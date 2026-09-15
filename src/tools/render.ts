import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { AEError, runJsx } from "../bridge.js";
import { host } from "../host.js";
import { compRef, defineTool, image, json } from "../mcp.js";

const FRAME_DIR = join(tmpdir(), "ae-mcp-frames");

/** Anything much above this and the image eats the context window. */
const MAX_EMBED_BYTES = 3_500_000;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * After Effects' saveFrameToPng() returns before the file is actually on disk —
 * it hands the write off and carries on, so reading immediately yields 0 bytes.
 * Wait until the PNG is complete: a settled size, the signature, and the IEND
 * chunk that terminates every valid PNG.
 */
async function waitForPng(path: string, timeoutMs: number): Promise<Buffer> {
  const deadline = Date.now() + timeoutMs;
  let lastSize = -1;

  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const size = statSync(path).size;
      if (size > 0 && size === lastSize) {
        const bytes = readFileSync(path);
        const complete =
          bytes.subarray(0, 8).equals(PNG_SIGNATURE) &&
          bytes.subarray(-12).includes("IEND");
        if (complete) { return bytes; }
      }
      lastSize = size;
    }
    await sleep(100);
  }

  throw new AEError(
    `After Effects did not finish writing the frame to ${path} within ` +
      `${Math.round(timeoutMs / 1000)}s. Complex comps can take a while — try a simpler frame, ` +
      "or check that the render isn't waiting on missing footage."
  );
}

function downscale(path: string, maxEdge: number): void {
  const res = host().downscale(path, maxEdge);
  if (!res.ok) {
    // Not fatal: the full-size frame is still on disk and still returned.
    process.stderr.write(`[after-effects-mcp] image resize failed: ${res.detail ?? "unknown error"}\n`);
  }
}

export function register(server: McpServer): void {
  defineTool(
    server,
    "ae_save_frame",
    {
      title: "Render a frame to look at",
      description:
        "Render a single frame of a composition to PNG and return it as an image, so you can see what " +
        "the comp actually looks like. Use this to check your work after making changes — don't assume " +
        "an edit landed the way you intended.\n\n" +
        "The PNG has a transparent background: a composition's background color is an After Effects " +
        "preview setting and never renders. Add a solid layer if you need an opaque backdrop.",
      readOnly: true,
      inputSchema: {
        comp: compRef,
        time: z
          .union([z.number(), z.string()])
          .optional()
          .describe('Seconds, or frames as "48f". Omit for the current playhead position.'),
        maxSize: z
          .number()
          .int()
          .min(64)
          .max(4096)
          .optional()
          .describe("Longest edge in pixels for the returned image. Default: 1200."),
        outputPath: z
          .string()
          .optional()
          .describe("Absolute path to keep the PNG. Omit to use a temp file."),
        returnImage: z
          .boolean()
          .optional()
          .describe("Embed the PNG in the response. Default: true. Set false to only write the file."),
      },
    },
    async (args) => {
      mkdirSync(FRAME_DIR, { recursive: true });
      // Always render full-size to a temp file; the embedded copy gets downscaled,
      // and the caller's outputPath (if any) keeps the original resolution.
      const renderPath = join(FRAME_DIR, `frame-${Date.now()}.png`);

      const result = await runJsx<{ comp: string; time: number; frame: number; width: number; height: number }>(
        `
        var comp = AEMCP.comp(ARGS.comp);
        var time = AEMCP.time(comp, ARGS.time, comp.time);
        var file = new File(ARGS.path);

        try {
            comp.saveFrameToPng(time, file);
        } catch (e) {
            AEMCP.err('Could not write the frame: ' + e.message +
                      '. Enable "Allow Scripts to Write Files and Access Network" in ' +
                      'After Effects > Settings > Scripting & Expressions.');
        }

        return {
            comp: comp.name,
            time: AEMCP.round(time),
            frame: Math.round(time * comp.frameRate),
            width: comp.width,
            height: comp.height
        };
        `,
        { args: { ...args, path: renderPath }, undo: false, timeoutMs: 300_000 }
      );

      await waitForPng(renderPath, 120_000);

      const finalPath = args.outputPath ?? renderPath;
      if (args.outputPath) {
        copyFileSync(renderPath, args.outputPath);
      }

      if (args.returnImage === false) {
        if (args.outputPath) { rmSync(renderPath, { force: true }); }
        return json({ ...result, path: finalPath, bytes: statSync(finalPath).size });
      }

      downscale(renderPath, args.maxSize ?? 1200);
      const bytes = readFileSync(renderPath);
      if (args.outputPath) { rmSync(renderPath, { force: true }); }

      if (bytes.length > MAX_EMBED_BYTES) {
        return json(
          { ...result, path: finalPath, bytes: bytes.length },
          "The frame is too large to embed inline. It is on disk at the path below; " +
            "re-run with a smaller maxSize to see it."
        );
      }

      return image(
        bytes.toString("base64"),
        "image/png",
        `${result.comp} — frame ${result.frame} (${result.time}s), ${result.width}x${result.height}\n${finalPath}`
      );
    }
  );

  defineTool(
    server,
    "ae_render",
    {
      title: "Render a composition",
      description:
        "Add a composition to the render queue and render it. After Effects is blocked while this runs, " +
        "so keep the range short unless you mean it. Use ae_save_frame for quick visual checks instead.",
      inputSchema: {
        comp: compRef,
        outputPath: z.string().describe("Absolute output path, e.g. '/Users/me/out.mov'."),
        renderSettings: z.string().optional().describe("Render settings template name. Default: 'Best Settings'."),
        outputModule: z
          .string()
          .optional()
          .describe("Output module template name, e.g. 'H.264 - Match Render Settings - 15 Mbps'. Omit for the default."),
        start: z.number().optional().describe("Start time in seconds. Omit for the work area start."),
        end: z.number().optional().describe("End time in seconds. Omit for the work area end."),
        overwrite: z
          .boolean()
          .optional()
          .describe(
            "Replace outputPath if a file is already there. Default: false, which fails with a clear " +
              "error instead — After Effects would otherwise block on a modal overwrite prompt."
          ),
        queueOnly: z
          .boolean()
          .optional()
          .describe("Add to the render queue without starting it, so the user can press Render themselves."),
        timeoutMinutes: z.number().min(1).max(240).optional().describe("How long to wait. Default: 30."),
      },
    },
    async (args) => {
      const timeoutMs = (args.timeoutMinutes ?? 30) * 60_000;
      return json(
        await runJsx(
          `
          var comp = AEMCP.comp(ARGS.comp);
          var item = app.project.renderQueue.items.add(comp);

          if (ARGS.start !== undefined) { item.timeSpanStart = ARGS.start; }
          if (ARGS.end !== undefined) {
              item.timeSpanDuration = ARGS.end - (ARGS.start === undefined ? item.timeSpanStart : ARGS.start);
          }

          if (ARGS.renderSettings) {
              try { item.applyTemplate(ARGS.renderSettings); }
              catch (e) { AEMCP.err('No render settings template named "' + ARGS.renderSettings + '". Available: ' + item.templates.join(', ')); }
          }

          var output = item.outputModule(1);
          if (ARGS.outputModule) {
              try { output.applyTemplate(ARGS.outputModule); }
              catch (e2) { AEMCP.err('No output module template named "' + ARGS.outputModule + '". Available: ' + output.templates.join(', ')); }
          }
          output.file = new File(ARGS.outputPath);

          if (ARGS.queueOnly) {
              // A human presses Render here, so After Effects can prompt them
              // about an existing file the way it normally would.
              return { queued: true, comp: comp.name, queueIndex: item.index, outputPath: output.file.fsName };
          }

          // An existing target makes After Effects raise a modal "already exists.
          // Overwrite?" prompt, which blocks the bridge until somebody clicks it —
          // and re-rendering to the same path is completely ordinary. Settle it
          // here instead. The output module may have changed the extension, so
          // test the file AE actually landed on, not the path we were handed.
          var target = output.file;
          if (target.exists) {
              if (!ARGS.overwrite) {
                  item.remove();
                  AEMCP.err('"' + target.fsName + '" already exists. Pass overwrite: true to replace it, ' +
                            'or render to a different outputPath. (Left alone, After Effects would stop ' +
                            'and wait for someone to answer an overwrite prompt.)');
              }
              if (!target.remove()) {
                  item.remove();
                  AEMCP.err('Could not replace "' + target.fsName + '" — it may be open in another ' +
                            'application. Close it, or render to a different outputPath.');
              }
          }

          app.project.renderQueue.render();

          return {
              rendered: true,
              comp: comp.name,
              status: String(item.status),
              outputPath: output.file.fsName
          };
          `,
          { args, undo: false, timeoutMs }
        )
      );
    }
  );

  defineTool(
    server,
    "ae_render_templates",
    {
      title: "List render templates",
      description:
        "List the render settings and output module templates available in this install, so you can pass " +
        "valid names to ae_render.",
      readOnly: true,
    },
    async () =>
      json(
        await runJsx(
          `
          // Templates are only readable from a queue item, so borrow one.
          var comps = [];
          for (var i = 1; i <= app.project.numItems; i++) {
              if (app.project.item(i) instanceof CompItem) { comps.push(app.project.item(i)); }
          }
          if (comps.length === 0) { AEMCP.err('The project has no compositions to inspect templates with.'); }

          var probe = app.project.renderQueue.items.add(comps[0]);
          var result = {
              renderSettings: probe.templates,
              outputModules: probe.outputModule(1).templates
          };
          probe.remove();
          return result;
          `,
          { undo: false }
        )
      )
  );
}
