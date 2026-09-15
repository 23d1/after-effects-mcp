import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AEError, host } from "./host.js";

export { AEError } from "./host.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const KEEP_TEMP = process.env.AE_MCP_KEEP_TEMP === "1";

let runtimeSource: string | null = null;

function runtime(): string {
  if (runtimeSource === null) {
    runtimeSource = readFileSync(join(HERE, "jsx", "runtime.jsx"), "utf8");
  }
  return runtimeSource;
}

/**
 * Serialises a value as an ASCII-only JS literal, so the generated .jsx file
 * stays 7-bit clean — ExtendScript reads script files without a BOM as Latin-1.
 */
export function jsonLiteral(value: unknown): string {
  return JSON.stringify(value === undefined ? null : value).replace(
    /[-￿]/g,
    (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")
  );
}

/**
 * ExtendScript's File() accepts forward slashes on both platforms, while a
 * Windows path embedded as a JS string would otherwise need its backslashes
 * escaped at every layer. Normalising sidesteps that entirely.
 */
function asScriptPath(path: string): string {
  return path.replace(/\\/g, "/");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function isRunning(): Promise<boolean> {
  return host().isRunning();
}

export async function launch(): Promise<void> {
  return host().launch();
}

export interface RunOptions {
  /** Undo-group label. Pass `false` for read-only scripts. */
  undo?: string | false;
  /** How long to wait for After Effects to finish. */
  timeoutMs?: number;
  /** Launch After Effects if it isn't already running. */
  autoLaunch?: boolean;
  /** Made available to the script as the `ARGS` variable. */
  args?: unknown;
}

/**
 * Runs an ExtendScript snippet inside After Effects and returns its value.
 *
 * `body` is a function body: use `return <value>` to send data back. Anything
 * JSON-serialisable works; `AEMCP` helpers are already in scope.
 */
export async function runJsx<T = unknown>(body: string, options: RunOptions = {}): Promise<T> {
  const { undo = false, timeoutMs = 120_000, autoLaunch = false, args } = options;
  const ae = host();

  if (!(await ae.isRunning())) {
    if (!autoLaunch) {
      throw new AEError(
        "After Effects isn't running. Start it (or call ae_status with launch=true) and open a project first."
      );
    }
    await ae.launch();
    // After Effects accepts scripts well before the UI settles.
    await sleep(6_000);
  }

  const dir = mkdtempSync(join(tmpdir(), "ae-mcp-"));
  const jsxPath = join(dir, `${randomUUID()}.jsx`);
  const resultPath = join(dir, "result.json");

  const inner =
    undo === false ? "__main()" : `AEMCP.undoGroup(${JSON.stringify(undo)}, __main)`;

  const preamble = [
    runtime(),
    "",
    "(function () {",
    "    function __emit(payload) {",
    "        // Serialise before touching the file: opening for write truncates,",
    "        // so a throw inside stringify would leave an empty result behind.",
    "        var text;",
    "        try {",
    "            text = AEMCP.stringify(payload);",
    "        } catch (serr) {",
    "            text = AEMCP.stringify({",
    "                ok: false,",
    "                error: 'Result could not be serialised: ' + ((serr && serr.message) ? serr.message : String(serr))",
    "            });",
    "        }",
    `        var out = new File(${jsonLiteral(asScriptPath(resultPath))});`,
    '        out.encoding = "UTF-8";',
    '        if (!out.open("w")) { return; }',
    "        out.write(text);",
    "        out.close();",
    "    }",
    "",
    "    function __main() {",
    `        var ARGS = ${jsonLiteral(args)};`,
  ];

  // Line number of the caller's first line, so ExtendScript's absolute line
  // numbers can be reported relative to the script the caller actually wrote.
  // The runtime is a single array entry spanning many lines, so count for real.
  const bodyStartLine = preamble.join("\n").split("\n").length + 1;

  const source = [
    ...preamble,
    body,
    "    }",
    "",
    "    try {",
    `        var __value = ${inner};`,
    "        __emit({ ok: true, data: __value === undefined ? null : __value });",
    "    } catch (e) {",
    "        __emit({",
    "            ok: false,",
    "            error: (e && e.message) ? e.message : String(e),",
    "            line: (e && e.line) ? e.line : null",
    "        });",
    "    }",
    "})();",
  ].join("\n");

  writeFileSync(jsxPath, source, "utf8");

  try {
    const res = await ae.dispatch(jsxPath, timeoutMs);

    if (res.timedOut) {
      throw new AEError(
        `After Effects did not respond within ${Math.round(timeoutMs / 1000)}s. ` +
          "It is usually blocked on a modal dialog — check the After Effects window and dismiss it.",
        KEEP_TEMP ? jsxPath : undefined
      );
    }

    const payload = await waitForResult(resultPath, timeoutMs);

    if (payload === null) {
      const detail =
        [res.stderr.trim(), res.stdout.trim() ? `dispatch output: ${res.stdout.trim()}` : ""]
          .filter(Boolean)
          .join("\n")
          .substring(0, 800) || undefined;
      throw new AEError(
        "After Effects ran the script but wrote no result. " + ae.noResultHint(),
        detail
      );
    }

    let parsed: { ok: boolean; data?: T; error?: string; line?: number | null };
    try {
      parsed = JSON.parse(payload);
    } catch {
      throw new AEError("Could not parse the result from After Effects.", payload.substring(0, 800));
    }

    if (!parsed.ok) {
      const bodyLines = body.split("\n").length;
      const line = parsed.line ?? 0;
      // Errors raised inside the runtime helpers carry a line number that means
      // nothing to the caller, so only report one that lands in their own code.
      const where =
        line >= bodyStartLine && line < bodyStartLine + bodyLines
          ? ` (line ${line - bodyStartLine + 1} of your script)`
          : "";
      throw new AEError(`${parsed.error}${where}`);
    }
    return parsed.data as T;
  } finally {
    if (!KEEP_TEMP) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

/**
 * Waits for the script's result file.
 *
 * On macOS dispatch blocks until the script has finished, so this returns on
 * the first look. On Windows `AfterFX.exe -r` hands the script to the running
 * instance and exits immediately, so the file appears some time later — and a
 * long-running script takes far longer than the dispatch call did.
 *
 * Returns null if nothing arrived before the deadline.
 */
async function waitForResult(path: string, timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  let delay = 20;

  for (;;) {
    if (existsSync(path)) {
      const text = readFileSync(path, "utf8");
      // The writer truncates before writing, so an empty file means "still
      // being written" rather than "finished with nothing to say".
      if (text.length > 0) { return text; }
    }
    if (Date.now() >= deadline) { return null; }

    await sleep(delay);
    delay = Math.min(delay * 2, 250);
  }
}
