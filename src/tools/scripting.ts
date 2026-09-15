import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runJsx } from "../bridge.js";
import { defineTool, json } from "../mcp.js";

export function register(server: McpServer): void {
  defineTool(
    server,
    "ae_run_script",
    {
      title: "Run ExtendScript",
      description:
        "Run arbitrary ExtendScript inside After Effects. This is the escape hatch for anything the " +
        "other tools don't cover — masks, shape operators, text animators, puppet pins, the lot.\n\n" +
        "The script body runs as a function: use `return <value>` to send JSON-serialisable data back. " +
        "The full AE scripting API is available (`app`, `app.project`, ...), plus the `AEMCP` helpers " +
        "used by this server: AEMCP.comp(ref), AEMCP.layer(comp, ref), AEMCP.prop(root, path), " +
        "AEMCP.color(hex), AEMCP.time(comp, t), AEMCP.serializeLayer(layer), AEMCP.setKeys(prop, comp, keys, opts).\n\n" +
        "Remember: this is ES3. No JSON, no arrow functions, no let/const, no Array.forEach.",
      inputSchema: {
        script: z.string().describe("ExtendScript source. Use `return` to produce a result."),
        undoLabel: z
          .string()
          .optional()
          .describe("Wrap the script in an undo group with this label. Omit for read-only scripts."),
        timeoutSeconds: z.number().min(1).max(3600).optional().describe("Default: 120."),
      },
    },
    async (args) =>
      json(
        await runJsx(args.script, {
          undo: args.undoLabel ?? false,
          timeoutMs: (args.timeoutSeconds ?? 120) * 1000,
        })
      )
  );

  defineTool(
    server,
    "ae_exec_menu",
    {
      title: "Run a menu command",
      description:
        "Execute an After Effects menu command by name — useful for things with no scripting API, like " +
        "'Auto-Orient', 'Fit to Comp', or 'Purge All Memory'. Names must match the menu exactly.",
      inputSchema: {
        command: z.string().describe("Menu command name, e.g. 'Fit to Comp Width'."),
      },
    },
    async (args) =>
      json(
        await runJsx(
          `
          var id = app.findMenuCommandId(ARGS.command);
          if (!id) { AEMCP.err('No menu command named "' + ARGS.command + '".'); }
          app.executeCommand(id);
          return { command: ARGS.command, commandId: id, executed: true };
          `,
          { args, undo: `MCP: ${args.command}` }
        )
      )
  );

  defineTool(
    server,
    "ae_list_fonts",
    {
      title: "List available fonts",
      description:
        "List fonts installed for After Effects with their PostScript names — which is what ae_add_layer " +
        "and ae_set_text expect. Setting a font that isn't listed here silently does nothing.",
      readOnly: true,
      inputSchema: {
        query: z.string().optional().describe("Case-insensitive substring of the family or PostScript name."),
        limit: z.number().int().min(1).max(500).optional().describe("Max results. Default: 80."),
      },
    },
    async (args) =>
      json(
        await runJsx(
          `
          if (!app.fonts) {
              AEMCP.err('This version of After Effects does not expose the font list to scripting.');
          }
          var all = app.fonts.allFonts;
          var query = ARGS.query ? ARGS.query.toLowerCase() : null;
          var limit = ARGS.limit || 80;
          var hits = [];

          for (var i = 0; i < all.length && hits.length < limit; i++) {
              var font = all[i];
              if (query) {
                  var haystack = (font.familyName + ' ' + font.styleName + ' ' + font.postScriptName).toLowerCase();
                  if (haystack.indexOf(query) === -1) { continue; }
              }
              hits.push({
                  postScriptName: font.postScriptName,
                  family: font.familyName,
                  style: font.styleName
              });
          }
          return { total: all.length, shown: hits.length, fonts: hits };
          `,
          { args }
        )
      )
  );
}
