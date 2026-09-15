# after-effects-mcp

An MCP server that lets Claude drive **Adobe After Effects** — build comps, add and animate
layers, apply effects, write expressions, and render frames back so the model can actually
*see* what it made.

Runs on macOS and Windows.

> **Verification status.** Both platforms are tested end-to-end against After Effects 2026 —
> 26.4 on macOS, 26.5 on Windows. `npm run doctor` re-checks every layer of the bridge on your
> own machine.

---

## How it works

There is no network API for After Effects. This server talks to it the way AE expects:

```
MCP client  ──stdio──▶  this server  ──dispatch──▶  After Effects  ──▶  ExtendScript
                              ▲                                              │
                              └────────────── result.json ◀───────────────────┘
```

1. Each tool call generates an ExtendScript (`.jsx`) file: a shared runtime library plus the
   tool's own body, with arguments baked in as a JSON literal.
2. That file is handed to After Effects — by `osascript`/`DoScriptFile` on macOS, by
   `AfterFX.exe -r` on Windows.
3. The script writes its result as JSON to a temp file, which the server polls for and reads.

No panel or extension to install — only AE itself.

**Results are waited for on the file, never on the dispatch call.** The two platforms genuinely
differ here. Measured with a script that sleeps 1500ms: on macOS `DoScriptFile` returned at
1818ms, having waited for it; on Windows `AfterFX.exe -r` returned at 376ms while the script ran
on until 1952ms. Polling the result file is correct under either behaviour, and on Windows it is
load-bearing — without it every call would return before After Effects had finished. Everything
above that line — the runtime, the tools, the scripts themselves — is identical on both.

## Requirements

- macOS or Windows, with Adobe After Effects installed
- Node.js 18+
- After Effects **running**, with a project open (`ae_status` will start it for you)
- **Allow Scripts to Write Files and Access Network** enabled in After Effects:
  *Settings → Scripting & Expressions* (macOS) or *Edit → Preferences → Scripting & Expressions*
  (Windows). Results come back through a file, so nothing works without it.

On macOS, the first call also raises a system prompt asking to let the host app control After
Effects. Approve it, or nothing will work. If you miss it: **System Settings → Privacy & Security
→ Automation**. This permission is granted per host application, so approving it for your
terminal does not cover Claude Desktop, and vice versa.

### Checking the setup

```bash
npm run doctor
```

Walks the chain — locating After Effects, detecting it running, dispatching a script, getting a
result back, rendering a frame, resizing it — and says which step failed and why.

## Install

```bash
npm install
npm run build
```

Register it with Claude Code. Use `--scope user` so the tools are available from any directory,
not only this repo — you will normally want them where your actual video projects live, not where
the server's source happens to sit:

```bash
# macOS
claude mcp add --scope user after-effects -- node /path/to/after-effects-mcp/dist/index.js

# Windows
claude mcp add --scope user after-effects -- node C:\path\to\after-effects-mcp\dist\index.js
```

The path must be absolute, and must keep existing — `dist/` is gitignored, so a fresh clone needs
`npm install && npm run build` before that path resolves. Check with `claude mcp list`.

### As a Claude Desktop extension (.mcpb)

Build a self-contained bundle:

```bash
npm run bundle          # -> build/after-effects-mcp-<version>.mcpb
open build/after-effects-mcp-0.1.0.mcpb
```

Opening it hands the bundle to Claude Desktop, which shows an install dialog. The bundle carries
its own production dependencies, so there is nothing to install alongside it and no PATH to
configure.

**The first tool call will raise a macOS prompt — "Claude wants to control After Effects".**
It must be approved or every call fails with `Not authorized to send Apple events`. Automation
permission is granted per host application, so approving it for your terminal does not cover
Claude Desktop, and vice versa. If you miss the prompt: **System Settings → Privacy & Security →
Automation**.

### As a config entry

Or add it to a client config by hand:

```json
{
  "mcpServers": {
    "after-effects": {
      "command": "node",
      "args": ["/absolute/path/to/after-effects-mcp/dist/index.js"]
    }
  }
}
```

### Environment variables

| Variable | Purpose |
| --- | --- |
| `AE_APP` | Target a specific install when several are present. **Windows:** full path to `AfterFX.exe`, or to the install folder containing `Support Files\AfterFX.exe`. **macOS:** an app name (`"Adobe After Effects 2025"`) or a full path to the `.app`. Auto-detected when unset — on Windows by scanning `%ProgramFiles%\Adobe` and taking the newest version. |
| `AE_MCP_KEEP_TEMP` | Set to `1` to keep generated `.jsx` files for debugging instead of deleting them. |

## Tools

**Project**
`ae_status` · `ae_project_info` · `ae_open_project` · `ae_save_project` · `ae_import` · `ae_undo`

**Compositions**
`ae_list_comps` · `ae_comp_info` · `ae_create_comp` · `ae_set_comp_settings` · `ae_set_time`

**Layers**
`ae_add_layer` · `ae_set_layer` · `ae_set_text` · `ae_layer_op` · `ae_select`

**Animation**
`ae_set_keyframes` · `ae_set_property` · `ae_get_property` · `ae_set_expression` · `ae_remove_keyframes`

**Effects**
`ae_search_effects` · `ae_apply_effect` · `ae_list_effect_params` · `ae_remove_effect`

**Output**
`ae_save_frame` · `ae_render` · `ae_render_templates`

**Escape hatches**
`ae_run_script` · `ae_exec_menu` · `ae_list_fonts`

Every mutating tool opens its own undo group, so anything the model does is one ⌘Z away.

### Property paths

Animatable things are addressed by dot-separated path, accepting display names or matchNames:

```
"Position"                            bare transform properties work
"Transform.Scale"
"Effects.Gaussian Blur.Blurriness"
["ADBE Effect Parade", "ADBE Gaussian Blur 2", "ADBE Gaussian Blur 2-0001"]
```

Pass an array when a name contains a dot or you want exact matchName addressing. When a path
fails, the error lists the valid children at the point it gave up — so a wrong guess tells you
the right answer.

### Seeing the result

`ae_save_frame` renders a frame and returns it as an image. This is the point of the whole
thing: the model can check its own work rather than assuming an edit landed.

```
ae_save_frame { comp: "Titles", time: "24f", maxSize: 900 }
```

Note that a composition's background color is an AE *preview* setting and never renders — the
PNG has a transparent background. Add a solid layer if you need an opaque backdrop.

## Notes for anyone extending this

Nine things cost real debugging time. They're documented here so they don't cost it twice.

**1. `DoScript` returns a status code, not your script's value.**
AE's AppleScript dictionary declares `DoScript`/`DoScriptFile` as returning `text`, which is
technically true — the text is `"0"` on success and `"1"` if the script threw. Your actual
return value is discarded. Hence the result file in `src/bridge.ts`.

**2. `Object.prototype` in ExtendScript carries operator-overload hooks.**
ExtendScript supports operator overloading, which means every object inherits methods named
`-`, `*`, `/`, `+`, `==` and friends. So:

```javascript
var ESCAPES = { '\n': '\\n', '"': '\\"' };
ESCAPES['-']   // → a Function, NOT undefined
```

Any lookup keyed by untrusted data can silently return a function. This broke JSON
serialization for every string containing a hyphen — including most font names. All such
lookups go through `AEMCP.own()`, which checks `hasOwnProperty` first.

**3. Dispatch waits on macOS and does not on Windows.**
`DoScriptFile` blocks until the script finishes. `AfterFX.exe -r` signals the running instance
and exits — for a 1500ms script it returned at 376ms. Waiting on the result file rather than on
the dispatch call is what lets one code path serve both.

Measuring this needs care: a probe that finishes instantly cannot distinguish "dispatch waited"
from "dispatch took longer to start up than the script took to run". The doctor's probe sleeps
inside ExtendScript so the two separate cleanly.

**4. Two scripts at once corrupts the project, quietly.**
After Effects runs one script at a time, and nothing in the dispatch path enforces it. MCP clients
are free to issue tool calls in parallel, so overlapping calls are reachable from ordinary use.
Four concurrent `ae_add_layer` calls for C1..C4 left a comp containing C2, C3 and *two* C4s, with
C1 gone — while two of the four callers blocked for the full timeout and then blamed file
permissions. A dropped script and a duplicated one are both silent; the damage shows up later as
a project that doesn't match what was asked for. `runJsx` therefore funnels every call through a
queue in `src/bridge.ts`, and the timeout starts when a call's turn does, so waiting in line is
not charged against its own budget.

**5. A modal dialog stops everything, and ordinary operations raise them.**
After Effects runs scripts on the thread its UI blocks, so any modal wins: the bridge waits on a
result file that will never appear, the call burns its whole timeout, and every queued call behind
it waits too. Nobody is there to click. Two everyday operations raise one, so both are settled in
advance rather than left to prompt: rendering over an existing file ("already exists. Overwrite?")
and opening a project while the current one has unsaved changes ("Save changes before closing?").
Each now takes an explicit opt-in (`overwrite`, `discardChanges`) and otherwise fails fast with a
message saying so. `ae_save_project` and `ae_save_frame` were checked too — they overwrite
silently and need no such guard. Anything new that writes a file or swaps the project deserves the
same check, because the symptom is a hang rather than an error.

**6. Windows will not let you delete a file After Effects still has open.**
Because dispatch returns early there, the temp `.jsx` is often still held when the call finishes,
and removing its directory fails with `EPERM`. Cleanup retries and then gives up quietly — it
runs in a `finally`, where throwing would replace a perfectly good result with an error about a
temp file.

**7. `saveFrameToPng()` is asynchronous.**
It returns before the file exists. Read it immediately and you get zero bytes, with no error
anywhere. `waitForPng()` in `src/tools/render.ts` polls until the size settles and the PNG's
`IEND` chunk is present.

**8. `app.fonts.allFonts` is a list of families, not of fonts.**
Each element is an *array* of that family's faces, so `allFonts[i].postScriptName` is `undefined`
rather than an error — every font serialised as `{}` and every query matched nothing, while the
count still looked plausible (359 "fonts" that were really families holding 1384 faces). Reach
the face through the inner array, and treat the count accordingly.

**9. ExtendScript is ES3.**
No `JSON`, no `let`/`const`, no arrow functions, no `Array.prototype.forEach/map/indexOf`, no
`Object.keys`, no `String.prototype.trim`. The runtime in `src/jsx/runtime.jsx` provides a JSON
serializer and the helpers the tools rely on.

### Layout

```
src/
  index.ts          MCP server; registers every tool
  host.ts           per-platform plumbing: locate, detect, dispatch, resize
  bridge.ts         script generation and result marshalling (platform-independent)
  mcp.ts            tool-definition helpers and shared argument schemas
  jsx/runtime.jsx   ExtendScript runtime injected into every call
  tools/            one module per tool group
manifest.json       MCPB bundle manifest
scripts/bundle.mjs  stages dist/ + production deps and packs the .mcpb
scripts/doctor.mjs  end-to-end diagnostics
```

Everything platform-specific lives behind the `Host` interface in `src/host.ts` — finding After
Effects, detecting whether it runs, dispatching a script, and resizing a PNG (`sips` on macOS,
`System.Drawing` via PowerShell on Windows). Adding a platform means implementing that interface
and nothing else.

macOS system binaries (`osascript`, `sips`, `pgrep`) are invoked by absolute path. A host that
launches the server from Finder or launchd — Claude Desktop, or an installed bundle — inherits a
minimal PATH that need not contain `/usr/bin`.

Bundles are unsigned by default; `npx mcpb sign` will sign one if you are distributing it
widely.

`ae_run_script` exposes the same runtime to callers, so anything the typed tools don't cover —
masks, shape operators, text animators, puppet pins — is still reachable without changing code.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| "After Effects isn't running" | Call `ae_status` with `launch: true`. |
| Everything times out | AE is blocked on a modal dialog. Check its window. |
| "ran the script but wrote no result" | Script file access is blocked — enable *Allow Scripts to Write Files and Access Network* in **After Effects → Settings → Scripting & Expressions**. |
| "Not authorized to send Apple events" (macOS) | Approve the host app under **System Settings → Privacy & Security → Automation**. |
| "Could not find AfterFX.exe" (Windows) | After Effects is installed somewhere non-standard. Set `AE_APP` to the full path of `AfterFX.exe`. |
| A font silently doesn't apply | AE wants the PostScript name. Use `ae_list_fonts` to find it. |

## License

MIT
