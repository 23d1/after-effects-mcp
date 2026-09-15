import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AEError } from "./bridge.js";

type TextContent = { type: "text"; text: string };
type ImageContent = { type: "image"; data: string; mimeType: string };
export type ToolResult = {
  content: (TextContent | ImageContent)[];
  isError?: boolean;
};

export function text(value: string): ToolResult {
  return { content: [{ type: "text", text: value }] };
}

export function json(data: unknown, note?: string): ToolResult {
  const body = JSON.stringify(data, null, 2);
  return text(note ? `${note}\n\n${body}` : body);
}

export function image(base64: string, mimeType: string, note?: string): ToolResult {
  const content: (TextContent | ImageContent)[] = [];
  if (note) { content.push({ type: "text", text: note }); }
  content.push({ type: "image", data: base64, mimeType });
  return { content };
}

function describeError(error: unknown): string {
  if (error instanceof AEError) {
    return error.detail ? `${error.message}\n\n${error.detail}` : error.message;
  }
  if (error instanceof Error) { return error.message; }
  return String(error);
}

export interface ToolConfig {
  title: string;
  description: string;
  inputSchema?: z.ZodRawShape;
  readOnly?: boolean;
}

/** Registers a tool and turns thrown errors into MCP error results. */
export function defineTool<S extends z.ZodRawShape>(
  server: McpServer,
  name: string,
  config: ToolConfig & { inputSchema?: S },
  handler: (args: z.objectOutputType<S, z.ZodTypeAny>) => Promise<ToolResult>
): void {
  server.registerTool(
    name,
    {
      title: config.title,
      description: config.description,
      inputSchema: (config.inputSchema ?? {}) as S,
      annotations: {
        readOnlyHint: config.readOnly === true,
        openWorldHint: false,
      },
    },
    (async (args: unknown) => {
      try {
        return await handler((args ?? {}) as z.objectOutputType<S, z.ZodTypeAny>);
      } catch (error) {
        return { ...text(describeError(error)), isError: true };
      }
    }) as never
  );
}

/* ------------------------------------------------------------ shared args */

export const compRef = z
  .union([z.string(), z.number()])
  .optional()
  .describe("Composition name, project item id, or index. Omit for the active comp.");

export const layerRef = z
  .union([z.string(), z.number()])
  .describe("Layer name, or 1-based index from the top (negative counts from the bottom).");

export const optionalLayerRef = layerRef
  .optional()
  .describe("Layer name or 1-based index. Omit to use the current selection.");

export const timeRef = z
  .union([z.number(), z.string()])
  .describe('Time in seconds (number), or frames as a string like "48f".');

export const colorRef = z
  .union([z.string(), z.array(z.number())])
  .describe('Color as "#rrggbb", or [r, g, b] in 0-1 or 0-255.');

export const propertyPath = z
  .union([z.string(), z.array(z.string())])
  .describe(
    'Property path, e.g. "Transform.Position", "Position", "Effects.Gaussian Blur.Blurriness", ' +
      'or an array of names/matchNames for exact addressing.'
  );
