import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runJsx } from "../bridge.js";
import { compRef, defineTool, json, optionalLayerRef } from "../mcp.js";

export function register(server: McpServer): void {
  defineTool(
    server,
    "ae_search_effects",
    {
      title: "Find available effects",
      description:
        "Search the effects installed in this copy of After Effects and get their exact matchNames. " +
        "Use this before ae_apply_effect when you aren't sure an effect exists or how it's spelled.",
      readOnly: true,
      inputSchema: {
        query: z.string().optional().describe("Case-insensitive substring of the effect or category name."),
        limit: z.number().int().min(1).max(500).optional().describe("Max results. Default: 60."),
      },
    },
    async (args) =>
      json(
        await runJsx(
          `
          var query = ARGS.query ? ARGS.query.toLowerCase() : null;
          var limit = ARGS.limit || 60;
          var all = app.effects;
          var hits = [];

          for (var i = 0; i < all.length && hits.length < limit; i++) {
              var fx = all[i];
              if (query) {
                  var haystack = (fx.displayName + ' ' + fx.category + ' ' + fx.matchName).toLowerCase();
                  if (haystack.indexOf(query) === -1) { continue; }
              }
              hits.push({ name: fx.displayName, matchName: fx.matchName, category: fx.category });
          }
          return { total: all.length, shown: hits.length, effects: hits };
          `,
          { args }
        )
      )
  );

  defineTool(
    server,
    "ae_apply_effect",
    {
      title: "Apply an effect",
      description:
        "Add an effect to a layer and optionally set its parameters in one call. " +
        "Accepts a display name ('Gaussian Blur') or a matchName ('ADBE Gaussian Blur 2').",
      inputSchema: {
        comp: compRef,
        layer: optionalLayerRef,
        effect: z.string().describe("Effect display name or matchName."),
        name: z.string().optional().describe("Rename the effect instance in the timeline."),
        parameters: z
          .record(z.union([z.number(), z.string(), z.boolean(), z.array(z.number())]))
          .optional()
          .describe(
            "Parameter name to value, e.g. {\"Blurriness\": 20}. Colors accept '#rrggbb'. " +
              "Call ae_list_effect_params if you need the exact names."
          ),
      },
    },
    async (args) =>
      json(
        await runJsx(
          `
          var comp = AEMCP.comp(ARGS.comp);
          var layer = AEMCP.layer(comp, ARGS.layer);
          var parade = layer.property('ADBE Effect Parade');
          if (!parade) { AEMCP.err('"' + layer.name + '" cannot take effects.'); }

          var matchName = AEMCP.resolveEffect(ARGS.effect);
          if (!parade.canAddProperty(matchName)) {
              AEMCP.err('"' + ARGS.effect + '" cannot be applied to this layer.');
          }

          var fx = parade.addProperty(matchName);
          if (ARGS.name) { fx.name = ARGS.name; }

          var applied = {};
          if (ARGS.parameters) {
              for (var key in ARGS.parameters) {
                  if (!ARGS.parameters.hasOwnProperty(key)) { continue; }
                  var prop = AEMCP.prop(fx, key);
                  var value = ARGS.parameters[key];
                  if (prop.propertyValueType === PropertyValueType.COLOR && !(value instanceof Array)) {
                      value = AEMCP.color(value);
                      value.push(1);
                  }
                  prop.setValue(value);
                  applied[prop.name] = AEMCP.value(prop);
              }
          }

          return {
              layer: layer.name,
              effect: fx.name,
              matchName: fx.matchName,
              index: fx.propertyIndex,
              parameters: applied
          };
          `,
          { args, undo: "MCP: apply effect" }
        )
      )
  );

  defineTool(
    server,
    "ae_list_effect_params",
    {
      title: "Inspect an applied effect",
      description:
        "List every parameter of an effect already on a layer, with current values and types. " +
        "This is how you discover the exact names to pass to ae_apply_effect or ae_set_property.",
      readOnly: true,
      inputSchema: {
        comp: compRef,
        layer: optionalLayerRef,
        effect: z
          .union([z.string(), z.number()])
          .describe("Effect name in the timeline, or its 1-based index in the effect stack."),
      },
    },
    async (args) =>
      json(
        await runJsx(
          `
          var comp = AEMCP.comp(ARGS.comp);
          var layer = AEMCP.layer(comp, ARGS.layer);
          var parade = layer.property('ADBE Effect Parade');
          if (!parade || parade.numProperties === 0) { AEMCP.err('"' + layer.name + '" has no effects.'); }

          var fx;
          if (typeof ARGS.effect === 'number') {
              if (ARGS.effect < 1 || ARGS.effect > parade.numProperties) {
                  AEMCP.err('Effect index ' + ARGS.effect + ' is out of range (1-' + parade.numProperties + ').');
              }
              fx = parade.property(ARGS.effect);
          } else {
              fx = AEMCP.prop(parade, ARGS.effect);
          }

          var params = [];
          for (var i = 1; i <= fx.numProperties; i++) {
              var p = fx.property(i);
              var entry = { name: p.name, matchName: p.matchName };
              if (p.propertyType === PropertyType.PROPERTY) {
                  entry.value = AEMCP.value(p);
                  entry.animatable = p.canVaryOverTime;
                  if (p.numKeys > 0) { entry.numKeys = p.numKeys; }
                  try { entry.min = p.minValue; entry.max = p.maxValue; } catch (e) { /* unbounded */ }
              } else {
                  entry.group = AEMCP.childNames(p);
              }
              params.push(entry);
          }

          return {
              layer: layer.name,
              effect: fx.name,
              matchName: fx.matchName,
              enabled: fx.enabled,
              parameters: params,
              propertyPathPrefix: 'Effects.' + fx.name
          };
          `,
          { args }
        )
      )
  );

  defineTool(
    server,
    "ae_remove_effect",
    {
      title: "Remove or toggle an effect",
      description: "Delete an effect from a layer, or just switch it off.",
      inputSchema: {
        comp: compRef,
        layer: optionalLayerRef,
        effect: z.union([z.string(), z.number()]).describe("Effect name or 1-based index."),
        disableOnly: z.boolean().optional().describe("Switch the effect off instead of deleting it."),
      },
    },
    async (args) =>
      json(
        await runJsx(
          `
          var comp = AEMCP.comp(ARGS.comp);
          var layer = AEMCP.layer(comp, ARGS.layer);
          var parade = layer.property('ADBE Effect Parade');
          if (!parade || parade.numProperties === 0) { AEMCP.err('"' + layer.name + '" has no effects.'); }

          var fx = (typeof ARGS.effect === 'number') ? parade.property(ARGS.effect) : AEMCP.prop(parade, ARGS.effect);
          var name = fx.name;

          if (ARGS.disableOnly) {
              fx.enabled = false;
              return { layer: layer.name, effect: name, enabled: false };
          }
          fx.remove();
          return { layer: layer.name, removed: name, remainingEffects: AEMCP.effectList(layer) };
          `,
          { args, undo: "MCP: remove effect" }
        )
      )
  );
}
