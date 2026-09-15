/**
 * Diagnostics for the After Effects bridge.
 *
 * Run with `npm run doctor`. Checks each layer in turn — locating After
 * Effects, detecting that it is running, dispatching a script, getting a result
 * back, and resizing an image — and reports where the chain breaks.
 */
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { host } from "../dist/host.js";
import { runJsx } from "../dist/bridge.js";

// After Effects may still hold a handle on files it just touched, which on
// Windows makes deletion fail with EPERM. Retry, and never fail a check over it.
const removeQuietly = (target) => {
  try {
    rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {
    /* a leftover temp file is not worth failing a diagnostic over */
  }
};

const pass = (m) => console.log(`  ok    ${m}`);
const fail = (m) => console.log(`  FAIL  ${m}`);
const info = (m) => console.log(`        ${m}`);

let failures = 0;
function check(ok, message) {
  if (ok) { pass(message); } else { fail(message); failures++; }
  return ok;
}

console.log(`\nafter-effects-mcp doctor`);
console.log(`node ${process.version} on ${process.platform} (${process.arch})\n`);

/* 1 — platform support ---------------------------------------------------- */

console.log("Platform");
let ae;
try {
  ae = host();
  pass(`${ae.platform} host selected`);
} catch (e) {
  fail(e.message);
  process.exit(1);
}

/* 2 — locating After Effects ---------------------------------------------- */

console.log("\nAfter Effects");
const where = ae.describe();
check(!/not found/i.test(where), `target: ${where}`);
if (/not found/i.test(where)) {
  info("Set AE_APP to the full path of AfterFX.exe (Windows) or the app name (macOS).");
}

const running = await ae.isRunning();
if (!check(running, running ? "process is running" : "process is NOT running")) {
  info("Start After Effects and run this again — the remaining checks need it.");
  console.log(`\n${failures} check(s) failed.\n`);
  process.exit(1);
}

/* 3 — dispatch and result channel ----------------------------------------- */

console.log("\nScript round-trip");
try {
  const t0 = Date.now();
  const result = await runJsx(
    "return { version: app.version, items: app.project.numItems };",
    { timeoutMs: 60_000 }
  );
  const ms = Date.now() - t0;
  pass(`round-trip in ${ms}ms — After Effects ${result.version}, ${result.items} project item(s)`);
} catch (e) {
  fail(e.message);
  if (e.detail) { info(e.detail); }
  failures++;
}

/* 4 — how dispatch behaves ------------------------------------------------
 * Handing a script to After Effects blocks on macOS (DoScriptFile) but is
 * documented as returning immediately on Windows (AfterFX.exe -r). The server
 * waits on the result file either way, so this check exists to report which
 * behaviour actually happens rather than to gate anything.
 *
 * The probe sleeps inside ExtendScript so the two cases are distinguishable: a
 * script that finishes instantly cannot tell "dispatch waited" apart from
 * "dispatch was slower to start up than the script took to run".
 */

const PROBE_SLEEP_MS = 1500;

console.log("\nDispatch behaviour");
try {
  const dir = join(tmpdir(), "ae-mcp-doctor");
  removeQuietly(dir);
  mkdirSync(dir, { recursive: true });
  const script = join(dir, "probe.jsx");
  const marker = join(dir, "probe.done").replace(/\\/g, "/");

  writeFileSync(
    script,
    `$.sleep(${PROBE_SLEEP_MS});\n` +
      `var f = new File(${JSON.stringify(marker)});\n` +
      `f.open("w"); f.write("done"); f.close();\n`,
    "utf8"
  );

  const t0 = Date.now();
  await ae.dispatch(script, 60_000);
  const dispatchMs = Date.now() - t0;

  let markerMs = null;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (existsSync(marker)) { markerMs = Date.now() - t0; break; }
    await new Promise((r) => setTimeout(r, 25));
  }

  if (check(markerMs !== null, "script executed and wrote its marker file")) {
    info(`script slept ${PROBE_SLEEP_MS}ms; dispatch returned at ${dispatchMs}ms, marker at ${markerMs}ms`);
    // Allow slack for startup: the question is whether dispatch outlasted the sleep.
    if (dispatchMs >= PROBE_SLEEP_MS * 0.8) {
      info("dispatch WAITS for the script to finish");
    } else {
      info("dispatch RETURNS EARLY; waiting on the result file is doing the work");
    }
  } else {
    info("After Effects did not write the marker. Check that script file access is enabled:");
    info(ae.noResultHint());
  }
  removeQuietly(dir);
} catch (e) {
  fail(e.message);
  failures++;
}

/* 5 — frame capture and image resize -------------------------------------- */

console.log("\nFrame capture");
try {
  const probeComp = `__doctor_${Date.now()}`;
  await runJsx(
    `var c = app.project.items.addComp(ARGS.name, 320, 180, 1, 1, 24);
     // A shape layer, not a solid: solids add a footage item and an auto-created
     // "Solids" folder to the project, and the probe should leave no trace.
     var l = c.layers.addShape();
     AEMCP.buildShape(l, c, { shape: 'rectangle', width: 320, height: 180, color: '#3399ee' });
     return c.id;`,
    { args: { name: probeComp }, undo: "doctor probe" }
  );

  const out = join(tmpdir(), `ae-mcp-doctor-frame-${Date.now()}.png`);
  await runJsx(
    `var c = AEMCP.comp(ARGS.name);
     c.saveFrameToPng(0, new File(ARGS.path));
     return true;`,
    { args: { name: probeComp, path: out.replace(/\\/g, "/") }, timeoutMs: 60_000 }
  );

  // saveFrameToPng returns before the file is complete, so give it a moment.
  let size = 0;
  for (let i = 0; i < 200; i++) {
    try { size = statSync(out).size; } catch { /* not yet */ }
    if (size > 0) { break; }
    await new Promise((r) => setTimeout(r, 50));
  }

  if (check(size > 0, `rendered a frame (${size} bytes)`)) {
    const before = size;
    const resize = ae.downscale(out, 160);
    const after = statSync(out).size;
    if (check(resize.ok, "image resize available")) {
      info(`${before} bytes -> ${after} bytes`);
    } else {
      info(resize.detail?.trim().split("\n")[0] ?? "no detail");
      info("Not fatal: frames are still returned, just at full resolution.");
    }
  }

  removeQuietly(out);
  await runJsx(
    `AEMCP.comp(ARGS.name).remove(); return true;`,
    { args: { name: probeComp }, undo: "doctor cleanup" }
  );
} catch (e) {
  fail(e.message);
  if (e.detail) { info(e.detail); }
  failures++;
}

console.log(
  failures === 0
    ? "\nAll checks passed.\n"
    : `\n${failures} check(s) failed — see the notes above.\n`
);
process.exit(failures === 0 ? 0 : 1);
