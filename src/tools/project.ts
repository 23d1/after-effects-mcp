import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { isRunning, launch, runJsx } from "../bridge.js";
import { defineTool, json, text } from "../mcp.js";

export function register(server: McpServer): void {
  defineTool(
    server,
    "ae_status",
    {
      title: "After Effects status",
      description:
        "Check whether After Effects is running and report its version, the open project, " +
        "and whether scripts are allowed to write files (needed for ae_save_frame and rendering). " +
        "Start here if anything else fails.",
      readOnly: true,
      inputSchema: {
        launch: z
          .boolean()
          .optional()
          .describe("Start After Effects if it isn't running (takes ~30s to become responsive)."),
      },
    },
    async ({ launch: shouldLaunch }) => {
      if (!(await isRunning())) {
        if (!shouldLaunch) {
          return json({ running: false }, "After Effects is not running. Call again with launch=true to start it.");
        }
        await launch();
        await new Promise((r) => setTimeout(r, 6_000));
      }

      const info = await runJsx(
        `
        var project = app.project;
        var active = null;
        try {
            if (project.activeItem) {
                active = { id: project.activeItem.id, name: project.activeItem.name,
                           isComp: project.activeItem instanceof CompItem };
            }
        } catch (e2) {}

        return {
            running: true,
            version: app.version,
            buildName: app.buildName,
            language: app.isoLanguage,
            project: {
                file: project.file ? project.file.fsName : null,
                dirty: project.dirty,
                numItems: project.numItems,
                bitsPerChannel: project.bitsPerChannel
            },
            activeItem: active
        };
        `,
        { autoLaunch: false, timeoutMs: 30_000 }
      );

      // Getting a result back at all proves scripts can write files here, which is
      // what ae_save_frame and rendering need — more reliable than reading the pref.
      return json({ ...(info as object), scriptFileWritesVerified: true });
    }
  );

  defineTool(
    server,
    "ae_project_info",
    {
      title: "List project items",
      description:
        "List everything in the Project panel — comps, footage, solids and folders — with ids you can " +
        "pass to other tools.",
      readOnly: true,
      inputSchema: {
        kind: z
          .enum(["all", "comp", "footage", "folder"])
          .optional()
          .describe("Filter by item kind. Default: all."),
        search: z.string().optional().describe("Case-insensitive substring match on the item name."),
      },
    },
    async (args) =>
      json(
        await runJsx(
          `
          var wanted = ARGS.kind || 'all';
          var search = ARGS.search ? ARGS.search.toLowerCase() : null;
          var items = [];

          for (var i = 1; i <= app.project.numItems; i++) {
              var item = app.project.item(i);
              var info = AEMCP.serializeItem(item);

              if (wanted !== 'all') {
                  var kind = info.kind === 'solid' || info.kind === 'placeholder' ? 'footage' : info.kind;
                  if (kind !== wanted) { continue; }
              }
              if (search && item.name.toLowerCase().indexOf(search) === -1) { continue; }
              items.push(info);
          }

          return { count: items.length, items: items };
          `,
          { args }
        )
      )
  );

  defineTool(
    server,
    "ae_open_project",
    {
      title: "Open or create a project",
      description:
        "Open an .aep file, or start a new empty project. Unsaved changes in the current project are " +
        "kept — After Effects will prompt if it needs to.",
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe("Absolute path to an .aep file. Omit to create a new empty project."),
      },
    },
    async (args) =>
      json(
        await runJsx(
          `
          if (ARGS.path) {
              var file = new File(ARGS.path);
              if (!file.exists) { AEMCP.err('No such file: ' + ARGS.path); }
              app.open(file);
          } else {
              app.newProject();
          }
          return {
              file: app.project.file ? app.project.file.fsName : null,
              numItems: app.project.numItems
          };
          `,
          { args, undo: false, timeoutMs: 180_000 }
        )
      )
  );

  defineTool(
    server,
    "ae_save_project",
    {
      title: "Save the project",
      description: "Save the current project, optionally to a new path (Save As).",
      inputSchema: {
        path: z.string().optional().describe("Absolute .aep path for Save As. Omit to save in place."),
      },
    },
    async (args) =>
      json(
        await runJsx(
          `
          if (ARGS.path) {
              app.project.save(new File(ARGS.path));
          } else if (app.project.file) {
              app.project.save();
          } else {
              AEMCP.err('This project has never been saved. Pass an absolute path to save it.');
          }
          return { saved: app.project.file.fsName };
          `,
          { args, undo: false, timeoutMs: 180_000 }
        )
      )
  );

  defineTool(
    server,
    "ae_import",
    {
      title: "Import footage",
      description:
        "Import files into the project. Handles stills, video, audio, and image sequences. " +
        "Returns the new item ids so you can add them to a comp with ae_add_layer.",
      inputSchema: {
        paths: z.array(z.string()).min(1).describe("Absolute paths to import."),
        sequence: z
          .boolean()
          .optional()
          .describe("Treat each path as the first frame of an image sequence."),
        folder: z.string().optional().describe("Name of a project folder to import into (created if missing)."),
      },
    },
    async (args) =>
      json(
        await runJsx(
          `
          var folder = null;
          if (ARGS.folder) {
              for (var f = 1; f <= app.project.numItems; f++) {
                  var candidate = app.project.item(f);
                  if (candidate instanceof FolderItem && candidate.name === ARGS.folder) { folder = candidate; break; }
              }
              if (!folder) { folder = app.project.items.addFolder(ARGS.folder); }
          }

          var imported = [];
          for (var i = 0; i < ARGS.paths.length; i++) {
              var file = new File(ARGS.paths[i]);
              if (!file.exists) { AEMCP.err('No such file: ' + ARGS.paths[i]); }

              var options = new ImportOptions(file);
              if (ARGS.sequence && options.canImportAs(ImportAsType.FOOTAGE)) {
                  options.sequence = true;
              }
              var item = app.project.importFile(options);
              if (folder) { item.parentFolder = folder; }
              imported.push(AEMCP.serializeItem(item));
          }
          return { count: imported.length, items: imported };
          `,
          { args, undo: "MCP: import footage", timeoutMs: 180_000 }
        )
      )
  );

  defineTool(
    server,
    "ae_undo",
    {
      title: "Undo",
      description: "Undo the last operation in After Effects. Repeat to step further back.",
      inputSchema: {
        steps: z.number().int().min(1).max(50).optional().describe("How many steps to undo. Default: 1."),
      },
    },
    async (args) => {
      const done = await runJsx<number>(
        `
        var steps = ARGS.steps || 1;
        var id = app.findMenuCommandId('Undo');
        for (var i = 0; i < steps; i++) { app.executeCommand(id); }
        return steps;
        `,
        { args, undo: false }
      );
      return text(`Undid ${done} step${done === 1 ? "" : "s"}.`);
    }
  );
}
