import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runJsx } from "../bridge.js";
import { colorRef, compRef, defineTool, json } from "../mcp.js";

export function register(server: McpServer): void {
  defineTool(
    server,
    "ae_list_comps",
    {
      title: "List compositions",
      description: "List every composition in the project with its size, duration and frame rate.",
      readOnly: true,
    },
    async () =>
      json(
        await runJsx(
          `
          var comps = [];
          for (var i = 1; i <= app.project.numItems; i++) {
              var item = app.project.item(i);
              if (item instanceof CompItem) { comps.push(AEMCP.serializeComp(item, 'none')); }
          }
          var active = app.project.activeItem;
          return {
              count: comps.length,
              activeComp: (active && active instanceof CompItem) ? active.name : null,
              comps: comps
          };
          `
        )
      )
  );

  defineTool(
    server,
    "ae_comp_info",
    {
      title: "Inspect a composition",
      description:
        "Read a composition's settings and its layer stack, including each layer's transform, effects, " +
        "and which properties are keyframed or expression-driven. This is the tool to call before editing " +
        "anything, so you know what is actually there.",
      readOnly: true,
      inputSchema: {
        comp: compRef,
        detail: z
          .enum(["minimal", "full"])
          .optional()
          .describe("'minimal' lists layer names and timing only; 'full' (default) includes transforms, effects and animation."),
      },
    },
    async (args) =>
      json(
        await runJsx(
          `
          var comp = AEMCP.comp(ARGS.comp);
          return AEMCP.serializeComp(comp, ARGS.detail === 'minimal' ? 'minimal' : 'full');
          `,
          { args }
        )
      )
  );

  defineTool(
    server,
    "ae_create_comp",
    {
      title: "Create a composition",
      description:
        "Create a new composition and open it in the timeline. Note that backgroundColor is a preview " +
        "convenience only — After Effects never renders it, so add a solid layer if the background " +
        "needs to appear in ae_save_frame output or a final render.",
      inputSchema: {
        name: z.string().describe("Composition name."),
        width: z.number().int().min(4).max(30000).optional().describe("Pixels. Default: 1920."),
        height: z.number().int().min(4).max(30000).optional().describe("Pixels. Default: 1080."),
        duration: z.number().positive().optional().describe("Seconds. Default: 10."),
        frameRate: z.number().positive().optional().describe("Frames per second. Default: 30."),
        pixelAspect: z.number().positive().optional().describe("Pixel aspect ratio. Default: 1."),
        backgroundColor: colorRef.optional(),
        open: z.boolean().optional().describe("Open the comp in the timeline. Default: true."),
      },
    },
    async (args) =>
      json(
        await runJsx(
          `
          var comp = app.project.items.addComp(
              ARGS.name,
              ARGS.width || 1920,
              ARGS.height || 1080,
              ARGS.pixelAspect || 1,
              ARGS.duration || 10,
              ARGS.frameRate || 30
          );
          if (ARGS.backgroundColor) { comp.bgColor = AEMCP.color(ARGS.backgroundColor); }
          if (ARGS.open !== false) { comp.openInViewer(); }
          return AEMCP.serializeComp(comp, 'none');
          `,
          { args, undo: "MCP: create composition" }
        )
      )
  );

  defineTool(
    server,
    "ae_set_comp_settings",
    {
      title: "Change composition settings",
      description: "Rename or resize a composition, or change its duration, frame rate, work area or background.",
      inputSchema: {
        comp: compRef,
        name: z.string().optional(),
        width: z.number().int().min(4).max(30000).optional(),
        height: z.number().int().min(4).max(30000).optional(),
        duration: z.number().positive().optional().describe("Seconds."),
        frameRate: z.number().positive().optional(),
        backgroundColor: colorRef.optional(),
        workAreaStart: z.number().min(0).optional().describe("Seconds."),
        workAreaDuration: z.number().positive().optional().describe("Seconds."),
        resolutionFactor: z
          .array(z.number().int().min(1))
          .length(2)
          .optional()
          .describe("Preview resolution as [x, y] downsample, e.g. [2, 2] for half."),
      },
    },
    async (args) =>
      json(
        await runJsx(
          `
          var comp = AEMCP.comp(ARGS.comp);
          if (ARGS.name !== undefined) { comp.name = ARGS.name; }
          if (ARGS.width !== undefined) { comp.width = ARGS.width; }
          if (ARGS.height !== undefined) { comp.height = ARGS.height; }
          if (ARGS.duration !== undefined) { comp.duration = ARGS.duration; }
          if (ARGS.frameRate !== undefined) { comp.frameRate = ARGS.frameRate; }
          if (ARGS.backgroundColor !== undefined) { comp.bgColor = AEMCP.color(ARGS.backgroundColor); }
          if (ARGS.workAreaStart !== undefined) { comp.workAreaStart = ARGS.workAreaStart; }
          if (ARGS.workAreaDuration !== undefined) { comp.workAreaDuration = ARGS.workAreaDuration; }
          if (ARGS.resolutionFactor !== undefined) { comp.resolutionFactor = ARGS.resolutionFactor; }
          return AEMCP.serializeComp(comp, 'none');
          `,
          { args, undo: "MCP: composition settings" }
        )
      )
  );

  defineTool(
    server,
    "ae_set_time",
    {
      title: "Move the playhead",
      description: "Set the current time in a composition. Affects what ae_save_frame captures.",
      inputSchema: {
        comp: compRef,
        time: z.union([z.number(), z.string()]).describe('Seconds, or frames as a string like "48f".'),
      },
    },
    async (args) =>
      json(
        await runJsx(
          `
          var comp = AEMCP.comp(ARGS.comp);
          comp.time = AEMCP.time(comp, ARGS.time);
          return { comp: comp.name, time: AEMCP.round(comp.time), frame: Math.round(comp.time * comp.frameRate) };
          `,
          { args, undo: false }
        )
      )
  );
}
