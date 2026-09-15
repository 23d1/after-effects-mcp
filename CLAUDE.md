# after-effects-mcp

An MCP server that drives Adobe After Effects through ExtendScript. Runs on macOS and Windows.

## Check the bridge before debugging anything

```bash
npm run doctor
```

Walks the whole chain — locate After Effects, detect it running, dispatch a script, read the
result file, render a frame, resize it — and reports which step broke. This separates "the bridge
is down" from "this one tool is wrong" in a single command, so run it first.

It needs After Effects running. It leaves no trace in the user's project.

## How verification works here

There is no unit test suite, and one would not be worth much: nearly every behaviour that matters
is After Effects' behaviour, not this code's. Verification means driving a live instance.

- After Effects must be running, with a project open.
- After changing a tool, exercise it against real AE through an MCP client, then call
  `ae_save_frame` and **look at the image**. Do not assume an edit landed the way you intended.
- The user's project is theirs. Remove any comps or items you create while testing, and prefer
  shape layers over solids in throwaway comps — solids leave a footage item and an auto-created
  "Solids" folder behind.

## Layout

| Path | Role |
| --- | --- |
| `src/host.ts` | Everything platform-specific, behind the `Host` interface |
| `src/bridge.ts` | Generates the `.jsx`, dispatches it, marshals the result. Platform-independent |
| `src/jsx/runtime.jsx` | ExtendScript runtime injected into every call (the `AEMCP` helpers) |
| `src/tools/*.ts` | One module per tool group; each registers via `defineTool` |
| `src/mcp.ts` | `defineTool` plus shared zod argument schemas |
| `scripts/doctor.mjs` | End-to-end diagnostics |

To add a tool: write it in the relevant `src/tools` module and call `runJsx` with an ExtendScript
body. Arguments arrive in the script as `ARGS`; send data back with `return`.

Tool descriptions are read by a model deciding whether to call them, so say what the tool is for
and when to reach for it — not just what its parameters are.

## Rules that are easy to violate

**ExtendScript is ES3.** In `runtime.jsx` and in every JSX body: no `JSON`, no `let`/`const`, no
arrow functions, no `Array.prototype.forEach`/`map`/`indexOf`, no `Object.keys`, no
`String.prototype.trim`.

**Never index an object with an untrusted key.** ExtendScript puts operator-overload hooks on
`Object.prototype`, so `MAP['-']` returns a **Function**, not `undefined`. Use
`AEMCP.own(map, key)`. This silently corrupted JSON serialisation for every string containing a
hyphen, which is most font names.

**Never assume dispatch waited for the script.** macOS's `DoScriptFile` blocks; Windows'
`AfterFX.exe -r` returns early — measured at 376ms for a script that ran 1952ms. Always wait on
the result file. `saveFrameToPng()` has the same shape: it returns before the PNG is on disk.

**A modal dialog hangs the bridge, not just the call.** Nobody is there to click it, so the call
burns its whole timeout and everything queued behind it waits. Any tool that writes a file or
swaps the project must settle the question in advance instead of letting AE prompt — see
`overwrite` on `ae_render` and `discardChanges` on `ae_open_project`. Fail fast with an explicit
opt-in; never let the symptom be a hang.

**Never let two scripts into After Effects at once.** AE runs one at a time, and overlapping
calls do not queue — they lose one script and run another twice, silently. `runJsx` serialises
every call through a queue in `bridge.ts`. Don't add a path that dispatches around it.

**Windows holds file locks.** Deleting a file After Effects still has open fails with `EPERM`.
Cleanup retries and then gives up quietly. Never let cleanup throw — it runs in a `finally`, where
a throw replaces a good result with an error about a temp file.

**Every mutating tool opens an undo group** — pass `undo: "MCP: ..."` to `runJsx`, so the user can
step back with one undo. Read-only tools pass `undo: false` and set `readOnly: true` on
`defineTool`.

**Keep generated `.jsx` ASCII.** Script files are read without a BOM, so non-ASCII is mangled.
`jsonLiteral()` escapes it; use that rather than interpolating strings directly.

## Commands

```bash
npm run build     # compile, stage runtime.jsx, mark the entry executable (no-op on Windows)
npm run doctor    # end-to-end diagnostics
npm run bundle    # pack the .mcpb for Claude Desktop
```

## Background

`README.md` documents the bridge design and the non-obvious After Effects behaviours behind it.
Read it before changing `bridge.ts` or `host.ts` — each of those quirks cost real debugging time
to find, and they are not guessable from the code alone.
