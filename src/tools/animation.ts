import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runJsx } from "../bridge.js";
import { compRef, defineTool, json, optionalLayerRef, propertyPath } from "../mcp.js";

const value = z
  .union([z.number(), z.string(), z.array(z.number()), z.boolean()])
  .describe("Property value: number, [x, y], [x, y, z], [r, g, b, a] 0-1, or '#rrggbb' for colors.");

export function register(server: McpServer): void {
  defineTool(
    server,
    "ae_set_keyframes",
    {
      title: "Animate a property",
      description:
        "Set keyframes on any animatable property — transform, effect parameters, mask paths, shape " +
        "properties, text animators. Existing keyframes at the same times are replaced. " +
        "Easing defaults to smooth ease in and out.",
      inputSchema: {
        comp: compRef,
        layer: optionalLayerRef,
        property: propertyPath,
        keyframes: z
          .array(
            z.object({
              time: z.union([z.number(), z.string()]).describe('Seconds, or frames as "48f".'),
              value,
              easing: z
                .enum(["none", "in", "out", "both"])
                .optional()
                .describe("Per-keyframe override of the default easing."),
              interpolation: z.enum(["linear", "bezier", "hold"]).optional(),
            })
          )
          .min(1),
        interpolation: z
          .enum(["linear", "bezier", "hold"])
          .optional()
          .describe("Default for all keyframes. Default: bezier."),
        easing: z
          .enum(["none", "in", "out", "both"])
          .optional()
          .describe("Which side of each keyframe gets eased. Default: both."),
        influence: z
          .number()
          .min(0.1)
          .max(100)
          .optional()
          .describe("Ease influence percent — higher is slower into and out of keys. Default: 33.33."),
        spatialInterpolation: z
          .enum(["auto", "linear"])
          .optional()
          .describe("For position: 'linear' gives straight-line motion, 'auto' gives a smooth curve."),
        clearExisting: z
          .boolean()
          .optional()
          .describe("Remove all existing keyframes on the property first. Default: false."),
      },
    },
    async (args) =>
      json(
        await runJsx(
          `
          var comp = AEMCP.comp(ARGS.comp);
          var layer = AEMCP.layer(comp, ARGS.layer);
          var prop = AEMCP.prop(layer, ARGS.property);

          if (ARGS.clearExisting) {
              while (prop.numKeys > 0) { prop.removeKey(1); }
          }

          AEMCP.setKeys(prop, comp, ARGS.keyframes, {
              interpolation: ARGS.interpolation,
              easing: ARGS.easing,
              influence: ARGS.influence,
              spatialInterpolation: ARGS.spatialInterpolation
          });

          return {
              layer: layer.name,
              property: prop.name,
              numKeys: prop.numKeys,
              keys: AEMCP.serializeKeys(prop)
          };
          `,
          { args, undo: "MCP: set keyframes" }
        )
      )
  );

  defineTool(
    server,
    "ae_set_property",
    {
      title: "Set a property value",
      description:
        "Set a static value on any property by path — effect parameters, mask feather, shape sizes, " +
        "anything ae_comp_info shows. Use ae_set_keyframes to animate instead.",
      inputSchema: {
        comp: compRef,
        layer: optionalLayerRef,
        property: propertyPath,
        value,
      },
    },
    async (args) =>
      json(
        await runJsx(
          `
          var comp = AEMCP.comp(ARGS.comp);
          var layer = AEMCP.layer(comp, ARGS.layer);
          var prop = AEMCP.prop(layer, ARGS.property);

          var v = ARGS.value;
          if (prop.propertyValueType === PropertyValueType.COLOR && !(v instanceof Array)) {
              v = AEMCP.color(v);
              v.push(1);
          }
          prop.setValue(v);

          return { layer: layer.name, property: prop.name, value: AEMCP.value(prop) };
          `,
          { args, undo: "MCP: set property" }
        )
      )
  );

  defineTool(
    server,
    "ae_get_property",
    {
      title: "Read a property",
      description:
        "Read a property's current value, its keyframes and any expression on it. " +
        "Also lists the property's children, which is how you discover exact parameter names.",
      readOnly: true,
      inputSchema: {
        comp: compRef,
        layer: optionalLayerRef,
        property: propertyPath,
        time: z
          .union([z.number(), z.string()])
          .optional()
          .describe("Evaluate at this time instead of the current one."),
      },
    },
    async (args) =>
      json(
        await runJsx(
          `
          var comp = AEMCP.comp(ARGS.comp);
          var layer = AEMCP.layer(comp, ARGS.layer);
          var prop = AEMCP.prop(layer, ARGS.property);

          var out = {
              layer: layer.name,
              name: prop.name,
              matchName: prop.matchName,
              propertyType: prop.propertyType === PropertyType.PROPERTY ? 'property' : 'group'
          };

          if (prop.propertyType === PropertyType.PROPERTY) {
              out.value = AEMCP.value(prop, ARGS.time === undefined ? undefined : AEMCP.time(comp, ARGS.time));
              out.numKeys = prop.numKeys;
              if (prop.numKeys > 0) { out.keys = AEMCP.serializeKeys(prop); }
              if (prop.expressionEnabled) { out.expression = prop.expression; }
              try { out.min = prop.minValue; out.max = prop.maxValue; } catch (e) { /* unbounded */ }
          } else {
              out.children = AEMCP.childNames(prop);
          }
          return out;
          `,
          { args }
        )
      )
  );

  defineTool(
    server,
    "ae_set_expression",
    {
      title: "Set or clear an expression",
      description:
        "Attach an expression to a property, or clear it. Expressions are written in After Effects' " +
        "JavaScript expression language.",
      inputSchema: {
        comp: compRef,
        layer: optionalLayerRef,
        property: propertyPath,
        expression: z
          .string()
          .optional()
          .describe("The expression source. Omit or pass an empty string to remove it."),
      },
    },
    async (args) =>
      json(
        await runJsx(
          `
          var comp = AEMCP.comp(ARGS.comp);
          var layer = AEMCP.layer(comp, ARGS.layer);
          var prop = AEMCP.prop(layer, ARGS.property);

          if (!prop.canSetExpression) { AEMCP.err('"' + prop.name + '" does not accept expressions.'); }

          var source = ARGS.expression === undefined ? '' : ARGS.expression;
          prop.expression = source;
          prop.expressionEnabled = source !== '';

          var out = {
              layer: layer.name,
              property: prop.name,
              expressionEnabled: prop.expressionEnabled,
              expression: prop.expression
          };

          // A broken expression stays "enabled"; AE reports the failure through
          // expressionError instead, which is empty when the expression is fine.
          var failure = '';
          try { failure = AEMCP.trim(prop.expressionError); } catch (e) { /* older AE */ }

          if (failure !== '') {
              out.error = failure;
              out.warning = 'After Effects could not evaluate this expression. The property is showing ' +
                            'its last static value and the layer is flagged in the timeline.';
          } else {
              out.value = AEMCP.value(prop);
          }
          return out;
          `,
          { args, undo: "MCP: set expression" }
        )
      )
  );

  defineTool(
    server,
    "ae_remove_keyframes",
    {
      title: "Remove keyframes",
      description: "Delete keyframes from a property — all of them, or those inside a time range.",
      inputSchema: {
        comp: compRef,
        layer: optionalLayerRef,
        property: propertyPath,
        from: z.union([z.number(), z.string()]).optional().describe("Range start. Omit for the beginning."),
        to: z.union([z.number(), z.string()]).optional().describe("Range end. Omit for the end."),
      },
    },
    async (args) =>
      json(
        await runJsx(
          `
          var comp = AEMCP.comp(ARGS.comp);
          var layer = AEMCP.layer(comp, ARGS.layer);
          var prop = AEMCP.prop(layer, ARGS.property);

          var from = ARGS.from === undefined ? -Infinity : AEMCP.time(comp, ARGS.from);
          var to = ARGS.to === undefined ? Infinity : AEMCP.time(comp, ARGS.to);

          var removed = 0;
          // Walk backwards: removeKey renumbers everything above it.
          for (var i = prop.numKeys; i >= 1; i--) {
              var t = prop.keyTime(i);
              if (t >= from && t <= to) { prop.removeKey(i); removed++; }
          }
          return { layer: layer.name, property: prop.name, removed: removed, remaining: prop.numKeys };
          `,
          { args, undo: "MCP: remove keyframes" }
        )
      )
  );
}
