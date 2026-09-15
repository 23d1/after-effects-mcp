import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export class AEError extends Error {
  readonly detail?: string;

  constructor(message: string, detail?: string) {
    super(message);
    this.name = "AEError";
    this.detail = detail;
  }
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function exec(
  cmd: string,
  args: string[],
  input?: string,
  timeoutMs = 30_000
): Promise<ExecResult> {
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

/**
 * Per-platform plumbing for talking to After Effects.
 *
 * The scripts themselves are identical everywhere — only the act of handing a
 * .jsx file to After Effects, and of noticing whether it is running, differ.
 */
export interface Host {
  readonly platform: string;
  /** Human-readable description of what this host talks to, for error messages. */
  describe(): string;
  isRunning(): Promise<boolean>;
  launch(): Promise<void>;
  /**
   * Hand a script file to After Effects. May return before the script has
   * finished running, so callers must wait on the result file rather than on
   * this promise.
   */
  dispatch(scriptPath: string, timeoutMs: number): Promise<ExecResult>;
  /** Resize a PNG in place. Best-effort: failure leaves the original intact. */
  downscale(pngPath: string, maxEdge: number): { ok: boolean; detail?: string };
  /** Guidance shown when a script produces no result file. */
  noResultHint(): string;
}

/* ------------------------------------------------------------------ macOS */

/*
 * Absolute paths, because a host that launches this server from Finder or
 * launchd (Claude Desktop, an installed .mcpb bundle) inherits a minimal PATH
 * that need not contain /usr/bin.
 */
const OSASCRIPT = "/usr/bin/osascript";
const PGREP = "/usr/bin/pgrep";
const SIPS = "/usr/bin/sips";

/** After Effects registers this bundle id regardless of the year in its name. */
const AE_BUNDLE_ID = "com.adobe.AfterEffects.application";

class DarwinHost implements Host {
  readonly platform = "darwin";

  /** The AppleScript `tell` target, overridable when several versions are installed. */
  private target(): string {
    const override = process.env.AE_APP;
    return override
      ? `application ${JSON.stringify(override)}`
      : `application id ${JSON.stringify(AE_BUNDLE_ID)}`;
  }

  describe(): string {
    return process.env.AE_APP ?? `bundle id ${AE_BUNDLE_ID}`;
  }

  async isRunning(): Promise<boolean> {
    const res = await exec(PGREP, ["-x", "After Effects"], undefined, 5_000);
    if (res.stdout.trim()) { return true; }
    // Some builds report a versioned process name.
    const wide = await exec(PGREP, ["-f", "Adobe After Effects [0-9]+$"], undefined, 5_000);
    return wide.stdout.trim().length > 0;
  }

  async launch(): Promise<void> {
    await exec(OSASCRIPT, ["-"], `tell ${this.target()} to activate`, 120_000);
  }

  async dispatch(scriptPath: string, timeoutMs: number): Promise<ExecResult> {
    // DoScriptFile blocks until the script finishes, and returns a status code
    // ("0" / "1") rather than the script's value — hence the result file.
    const applescript = `tell ${this.target()}\n  DoScriptFile ${JSON.stringify(scriptPath)}\nend tell`;
    return exec(OSASCRIPT, ["-"], applescript, timeoutMs);
  }

  downscale(pngPath: string, maxEdge: number): { ok: boolean; detail?: string } {
    const res = spawnSync(SIPS, ["-Z", String(maxEdge), pngPath], { encoding: "utf8" });
    return res.status === 0 ? { ok: true } : { ok: false, detail: res.stderr };
  }

  noResultHint(): string {
    return (
      "Enable 'Allow Scripts to Write Files and Access Network' in " +
      "After Effects > Settings > Scripting & Expressions. If this is the first run, also check " +
      "System Settings > Privacy & Security > Automation and allow this app to control After Effects."
    );
  }
}

/* ---------------------------------------------------------------- Windows */

const POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const TASKLIST = "C:\\Windows\\System32\\tasklist.exe";

/**
 * Locates AfterFX.exe. AE_APP wins; otherwise the newest version found under
 * the standard Adobe install roots.
 */
export function findAfterFx(): string | null {
  const override = process.env.AE_APP;
  if (override) {
    if (existsSync(override)) {
      // Accept either the executable or the installation folder.
      if (override.toLowerCase().endsWith(".exe")) { return override; }
      const nested = join(override, "Support Files", "AfterFX.exe");
      if (existsSync(nested)) { return nested; }
    }
    return null;
  }

  const roots = [
    join(process.env["ProgramFiles"] ?? "C:\\Program Files", "Adobe"),
    join(process.env["ProgramW6432"] ?? "C:\\Program Files", "Adobe"),
  ];

  const found: { version: number; path: string }[] = [];
  for (const root of roots) {
    if (!existsSync(root)) { continue; }
    let entries: string[];
    try { entries = readdirSync(root); } catch { continue; }

    for (const entry of entries) {
      if (!/^Adobe After Effects/i.test(entry)) { continue; }
      const exe = join(root, entry, "Support Files", "AfterFX.exe");
      if (!existsSync(exe)) { continue; }
      const year = Number(/(\d{4})/.exec(entry)?.[1] ?? 0);
      found.push({ version: year, path: exe });
    }
  }

  if (found.length === 0) { return null; }
  found.sort((a, b) => b.version - a.version);
  return found[0]!.path;
}

class Win32Host implements Host {
  readonly platform = "win32";

  private exe(): string {
    const path = findAfterFx();
    if (!path) {
      throw new AEError(
        process.env.AE_APP
          ? `AE_APP is set to "${process.env.AE_APP}" but no AfterFX.exe was found there.`
          : "Could not find AfterFX.exe. Set the AE_APP environment variable to its full path, " +
              "e.g. C:\\Program Files\\Adobe\\Adobe After Effects 2026\\Support Files\\AfterFX.exe"
      );
    }
    return path;
  }

  describe(): string {
    return findAfterFx() ?? "AfterFX.exe (not found)";
  }

  async isRunning(): Promise<boolean> {
    const res = await exec(
      TASKLIST,
      ["/FI", "IMAGENAME eq AfterFX.exe", "/NH"],
      undefined,
      10_000
    );
    return /AfterFX\.exe/i.test(res.stdout);
  }

  async launch(): Promise<void> {
    const child = spawn(this.exe(), [], { detached: true, stdio: "ignore" });
    child.unref();
  }

  async dispatch(scriptPath: string, timeoutMs: number): Promise<ExecResult> {
    /*
     * `AfterFX.exe -r <script>` runs a script in After Effects. Unlike macOS's
     * DoScriptFile it does NOT block: when an instance is already running the
     * new process signals it and exits immediately, long before the script has
     * finished. The caller waits on the result file instead.
     */
    return exec(this.exe(), ["-r", scriptPath], undefined, timeoutMs);
  }

  downscale(pngPath: string, maxEdge: number): { ok: boolean; detail?: string } {
    // System.Drawing via Windows PowerShell 5.1, which ships with the OS.
    const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$path = ${psQuote(pngPath)}
$max = ${maxEdge}
$img = [System.Drawing.Image]::FromFile($path)
try {
  $scale = [Math]::Min(1.0, $max / [Math]::Max($img.Width, $img.Height))
  if ($scale -ge 1.0) { exit 0 }
  $w = [int]($img.Width * $scale)
  $h = [int]($img.Height * $scale)
  $bmp = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.DrawImage($img, 0, 0, $w, $h)
  $g.Dispose()
  $tmp = [System.IO.Path]::GetTempFileName() + '.png'
  $bmp.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
} finally {
  $img.Dispose()
}
Move-Item -Force $tmp $path
`;
    const res = spawnSync(
      POWERSHELL,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { encoding: "utf8" }
    );
    return res.status === 0 ? { ok: true } : { ok: false, detail: res.stderr };
  }

  noResultHint(): string {
    return (
      "Enable 'Allow Scripts to Write Files and Access Network' in " +
      "After Effects > Edit > Preferences > Scripting & Expressions. Also make sure After Effects " +
      "is not showing a modal dialog, and that no script error window is waiting for a click."
    );
  }
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/* ------------------------------------------------------------------ pick  */

let cached: Host | null = null;

export function host(): Host {
  if (cached) { return cached; }
  switch (process.platform) {
    case "darwin":
      cached = new DarwinHost();
      break;
    case "win32":
      cached = new Win32Host();
      break;
    default:
      throw new AEError(
        `after-effects-mcp supports macOS and Windows; this is ${process.platform}. ` +
          "After Effects itself only runs on those two platforms."
      );
  }
  return cached;
}
