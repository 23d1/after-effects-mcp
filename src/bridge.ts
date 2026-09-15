import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** After Effects registers this bundle id regardless of the year in its name. */
const DEFAULT_BUNDLE_ID = "com.adobe.AfterEffects.application";

/*
 * After Effects' DoScript/DoScriptFile AppleScript commands return a status code
 * ("0" on success, "1" if the script threw) rather than the script's value, so
 * results come back through a file the script writes instead.
 */
const KEEP_TEMP = process.env.AE_MCP_KEEP_TEMP === "1";

/*
 * Absolute paths, because a host that launches this server from Finder or
 * launchd (Claude Desktop, an installed .mcpb bundle) inherits a minimal PATH
 * that need not contain /usr/bin.
 */
export const OSASCRIPT = "/usr/bin/osascript";
const PGREP = "/usr/bin/pgrep";

let runtimeSource: string | null = null;

function runtime(): string {
  if (runtimeSource === null) {
    runtimeSource = readFileSync(join(HERE, "jsx", "runtime.jsx"), "utf8");
  }
  return runtimeSource;
}

export class AEError extends Error {
  readonly detail?: string;

  constructor(message: string, detail?: string) {
    super(message);
    this.name = "AEError";
    this.detail = detail;
  }
}

/** The AppleScript `tell` target, overridable when several AE versions are installed. */
function target(): string {
  const override = process.env.AE_APP;
  if (override) {
    return override.startsWith("/")
      ? `application ${JSON.stringify(override)}`
      : `application ${JSON.stringify(override)}`;
  }
  return `application id ${JSON.stringify(DEFAULT_BUNDLE_ID)}`;
}

interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function exec(cmd: string, args: string[], input?: string, timeoutMs = 30_000): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr + String(e), timedOut });
    });

    if (input !== undefined) { child.stdin.write(input); }
    child.stdin.end();
  });
}

export async function isRunning(): Promise<boolean> {
  const res = await exec(PGREP, ["-x", "After Effects"], undefined, 5_000);
  if (res.stdout.trim()) { return true; }
  // Some builds report a versioned process name.
  const wide = await exec(PGREP, ["-f", "Adobe After Effects [0-9]+$"], undefined, 5_000);
  return wide.stdout.trim().length > 0;
}

export async function launch(): Promise<void> {
  await exec(OSASCRIPT, ["-"], `tell ${target()} to activate`, 120_000);
}

/**
 * Serialises a value as an ASCII-only JS literal, so the generated .jsx file
 * stays 7-bit clean — ExtendScript reads script files without a BOM as Latin-1.
 */
export function jsonLiteral(value: unknown): string {
  return JSON.stringify(value === undefined ? null : value).replace(
    /[\u007f-\uffff]/g,
    (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")
  );
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

  if (!(await isRunning())) {
    if (!autoLaunch) {
      throw new AEError(
        "After Effects isn't running. Start it (or call ae_status with launch=true) and open a project first."
      );
    }
    await launch();
    // AE accepts AppleEvents well before the UI settles; give it a moment.
    await new Promise((r) => setTimeout(r, 4_000));
  }

  const dir = mkdtempSync(join(tmpdir(), "ae-mcp-"));
  const scriptPath = join(dir, `${randomUUID()}.jsx`);
  const resultPath = join(dir, "result.json");

  const inner = undo === false
    ? `__main()`
    : `AEMCP.undoGroup(${JSON.stringify(undo)}, __main)`;

  const preamble = [
    runtime(),
    "",
    "(function () {",
    "    function __emit(payload) {",
    "        // Serialise before touching the file: open(\"w\") truncates, so a",
    "        // throw inside stringify would otherwise leave an empty result.",
    "        var text;",
    "        try {",
    "            text = AEMCP.stringify(payload);",
    "        } catch (serr) {",
    "            text = AEMCP.stringify({",
    "                ok: false,",
    "                error: 'Result could not be serialised: ' + ((serr && serr.message) ? serr.message : String(serr))",
    "            });",
    "        }",
    `        var out = new File(${jsonLiteral(resultPath)});`,
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

  writeFileSync(scriptPath, source, "utf8");

  const applescript = `tell ${target()}\n  DoScriptFile ${JSON.stringify(scriptPath)}\nend tell`;

  try {
    const res = await exec(OSASCRIPT, ["-"], applescript, timeoutMs);

    if (res.timedOut) {
      throw new AEError(
        `After Effects did not respond within ${Math.round(timeoutMs / 1000)}s. ` +
          "It is usually blocked on a modal dialog — check the After Effects window and dismiss it.",
        KEEP_TEMP ? scriptPath : undefined
      );
    }

    let payload: string;
    try {
      payload = readFileSync(resultPath, "utf8");
    } catch {
      throw new AEError(
        "After Effects ran the script but wrote no result. This usually means script file access is " +
          "blocked — enable 'Allow Scripts to Write Files and Access Network' in " +
          "After Effects > Settings > Scripting & Expressions.",
        [res.stderr.trim(), `osascript status: ${res.stdout.trim() || "(none)"}`]
          .filter(Boolean)
          .join("\n")
          .substring(0, 800)
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
