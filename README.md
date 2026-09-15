# after-effects-mcp

An MCP server that lets Claude drive **Adobe After Effects** on macOS — build comps, add and
animate layers, apply effects, write expressions, and render frames back so the model can
actually *see* what it made.

Tested against After Effects 2026 (26.4) on macOS.

---

## How it works

There is no network API for After Effects. This server talks to it the way AE expects:

```
MCP client  ──stdio──▶  this server  ──osascript──▶  After Effects  ──▶  ExtendScript
                              ▲                                              │
                              └────────────── result.json ◀───────────────────┘
```

1. Each tool call generates an ExtendScript (`.jsx`) file: a shared runtime library plus the
   tool's own body, with arguments baked in as a JSON literal.
2. AppleScript's `DoScriptFile` hands that file to After Effects.
3. The script writes its result as JSON to a temp file, which the server reads back.

No panel or extension to install — only AE itself.

## Requirements

- macOS with Adobe After Effects installed
- Node.js 18+
- After Effects **running**, with a project open (`ae_status` will start it for you)

On first use macOS asks permission for your terminal to control After Effects. Approve it, or
nothing will work. If you miss the prompt: **System Settings → Privacy & Security → Automation**.

## Install

```bash
npm install
npm run build
```

Register it with Claude Code:

```bash
claude mcp add after-effects -- node /absolute/path/to/after-effects-mcp/dist/index.js
```

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
| `AE_APP` | Target a specific install when several are present — an app name (`"Adobe After Effects 2025"`) or a full path. Defaults to whichever registered the `com.adobe.AfterEffects.application` bundle id. |
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

Four things cost real debugging time. They're documented here so they don't cost it twice.

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

**3. `saveFrameToPng()` is asynchronous.**
It returns before the file exists. Read it immediately and you get zero bytes, with no error
anywhere. `waitForPng()` in `src/tools/render.ts` polls until the size settles and the PNG's
`IEND` chunk is present.

**4. ExtendScript is ES3.**
No `JSON`, no `let`/`const`, no arrow functions, no `Array.prototype.forEach/map/indexOf`, no
`Object.keys`, no `String.prototype.trim`. The runtime in `src/jsx/runtime.jsx` provides a JSON
serializer and the helpers the tools rely on.

### Layout

```
src/
  index.ts          MCP server; registers every tool
  bridge.ts         script generation, osascript invocation, result marshalling
  mcp.ts            tool-definition helpers and shared argument schemas
  jsx/runtime.jsx   ExtendScript runtime injected into every call
  tools/            one module per tool group
```

`ae_run_script` exposes the same runtime to callers, so anything the typed tools don't cover —
masks, shape operators, text animators, puppet pins — is still reachable without changing code.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| "After Effects isn't running" | Call `ae_status` with `launch: true`. |
| Everything times out | AE is blocked on a modal dialog. Check its window. |
| "ran the script but wrote no result" | Script file access is blocked — enable *Allow Scripts to Write Files and Access Network* in **After Effects → Settings → Scripting & Expressions**. |
| "Not authorized to send Apple events" | Approve your terminal under **System Settings → Privacy & Security → Automation**. |
| A font silently doesn't apply | AE wants the PostScript name. Use `ae_list_fonts` to find it. |

## License

MIT
