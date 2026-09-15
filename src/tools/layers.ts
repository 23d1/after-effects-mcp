import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runJsx } from "../bridge.js";
import { colorRef, compRef, defineTool, json, layerRef, optionalLayerRef } from "../mcp.js";

export function register(server: McpServer): void {
  defineTool(
    server,
    "ae_add_layer",
    {
      title: "Add a layer",
      description:
        "Add a layer to a composition: text, solid, shape, null, adjustment, camera, light, or existing " +
        "footage/comp from the project. Returns the new layer's index.",
      inputSchema: {
        comp: compRef,
        type: z
          .enum(["text", "solid", "shape", "null", "adjustment", "camera", "light", "footage"])
          .describe("What kind of layer to create."),
        name: z.string().optional().describe("Layer name. Defaults to something sensible per type."),

        text: z.string().optional().describe("text layers: the string to display. Use \\n for line breaks."),
        fontSize: z.number().positive().optional().describe("text layers: point size. Default: 72."),
        font: z.string().optional().describe("text layers: PostScript font name, e.g. 'Helvetica-Bold'."),
        color: colorRef.optional().describe("text fill, solid color, or shape fill."),
        boxText: z
          .array(z.number())
          .length(2)
          .optional()
          .describe("text layers: [width, height] to create a paragraph text box instead of point text."),

        width: z.number().int().positive().optional().describe("solid/shape: width in px. Defaults to comp width."),
        height: z.number().int().positive().optional().describe("solid/shape: height in px. Defaults to comp height."),

        shape: z
          .enum(["rectangle", "ellipse", "star"])
          .optional()
          .describe("shape layers: which primitive to draw. Default: rectangle."),
        cornerRadius: z.number().min(0).optional().describe("shape layers: rounded-rectangle radius."),
        strokeColor: colorRef.optional().describe("shape layers: stroke color. Omit for no stroke."),
        strokeWidth: z.number().min(0).optional().describe("shape layers: stroke width in px. Default: 0."),

        source: z
          .union([z.string(), z.number()])
          .optional()
          .describe("footage layers: project item name or id (from ae_project_info)."),

        lightType: z
          .enum(["parallel", "spot", "point", "ambient"])
          .optional()
          .describe("light layers: light type. Default: point."),

        position: z.array(z.number()).optional().describe("[x, y] or [x, y, z] in comp pixels."),
        startTime: z.number().optional().describe("Seconds to offset the layer's start."),
        duration: z.number().positive().optional().describe("Seconds; trims the layer's out point."),
        threeD: z.boolean().optional().describe("Enable 3D for this layer."),
      },
    },
    async (args) =>
      json(
        await runJsx(
          `
          var comp = AEMCP.comp(ARGS.comp);
          var layer;

          switch (ARGS.type) {
              case 'text':
                  layer = comp.layers.addText(ARGS.text === undefined ? 'Text' : ARGS.text);
                  if (ARGS.boxText) {
                      var boxed = layer.property('Source Text').value;
                      boxed.boxText = true;
                      boxed.boxTextSize = ARGS.boxText;
                      layer.property('Source Text').setValue(boxed);
                  }
                  var doc = layer.property('Source Text').value;
                  if (ARGS.fontSize) { doc.fontSize = ARGS.fontSize; }
                  if (ARGS.font) { doc.font = ARGS.font; }
                  if (ARGS.color) { doc.applyFill = true; doc.fillColor = AEMCP.color(ARGS.color); }
                  layer.property('Source Text').setValue(doc);
                  break;

              case 'solid':
                  layer = comp.layers.addSolid(
                      AEMCP.color(ARGS.color || '#808080'),
                      ARGS.name || 'Solid',
                      ARGS.width || comp.width,
                      ARGS.height || comp.height,
                      comp.pixelAspect
                  );
                  break;

              case 'shape':
                  layer = comp.layers.addShape();
                  AEMCP.buildShape(layer, comp, ARGS);
                  break;

              case 'null':
                  layer = comp.layers.addNull(ARGS.duration || comp.duration);
                  break;

              case 'adjustment':
                  layer = comp.layers.addSolid([1, 1, 1], ARGS.name || 'Adjustment Layer',
                                               comp.width, comp.height, comp.pixelAspect);
                  layer.adjustmentLayer = true;
                  break;

              case 'camera':
                  layer = comp.layers.addCamera(ARGS.name || 'Camera',
                                                ARGS.position ? [ARGS.position[0], ARGS.position[1]]
                                                              : [comp.width / 2, comp.height / 2]);
                  break;

              case 'light':
                  var kinds = {
                      parallel: LightType.PARALLEL, spot: LightType.SPOT,
                      point: LightType.POINT, ambient: LightType.AMBIENT
                  };
                  layer = comp.layers.addLight(ARGS.name || 'Light', [comp.width / 2, comp.height / 2]);
                  layer.lightType = AEMCP.own(kinds, ARGS.lightType || 'point');
                  break;

              case 'footage':
                  if (ARGS.source === undefined || ARGS.source === null) {
                      AEMCP.err("Layer type 'footage' needs a source (project item name or id).");
                  }
                  var item = (typeof ARGS.source === 'number')
                      ? AEMCP.itemById(ARGS.source)
                      : AEMCP.findItemByName(ARGS.source);
                  layer = comp.layers.add(item);
                  break;

              default:
                  AEMCP.err('Unknown layer type: ' + ARGS.type);
          }

          if (ARGS.name) { layer.name = ARGS.name; }
          if (ARGS.threeD) { layer.threeDLayer = true; }
          if (ARGS.position) { layer.property('ADBE Transform Group').property('ADBE Position').setValue(ARGS.position); }
          if (ARGS.startTime !== undefined) { layer.startTime = ARGS.startTime; }
          if (ARGS.duration !== undefined) { layer.outPoint = layer.inPoint + ARGS.duration; }

          return AEMCP.serializeLayer(layer, 'minimal');
          `,
          { args, undo: "MCP: add layer" }
        )
      )
  );

  defineTool(
    server,
    "ae_set_layer",
    {
      title: "Set layer properties",
      description:
        "Change a layer's name, transform, timing, parenting, blend mode or switches. " +
        "Values set here are static — use ae_set_keyframes to animate instead.",
      inputSchema: {
        comp: compRef,
        layer: optionalLayerRef,
        name: z.string().optional(),
        position: z.array(z.number()).optional().describe("[x, y] or [x, y, z]."),
        anchorPoint: z.array(z.number()).optional(),
        scale: z
          .union([z.number(), z.array(z.number())])
          .optional()
          .describe("Percent. A single number scales uniformly."),
        rotation: z.number().optional().describe("Degrees (Z rotation)."),
        opacity: z.number().min(0).max(100).optional().describe("Percent."),
        inPoint: z.number().optional().describe("Seconds."),
        outPoint: z.number().optional().describe("Seconds."),
        startTime: z.number().optional().describe("Seconds."),
        parent: z
          .union([z.string(), z.number(), z.null()])
          .optional()
          .describe("Parent layer name/index, or null to unparent."),
        blendingMode: z
          .string()
          .optional()
          .describe("e.g. 'ADD', 'SCREEN', 'MULTIPLY', 'OVERLAY', 'SOFT_LIGHT'."),
        enabled: z.boolean().optional().describe("Layer visibility (the eyeball)."),
        locked: z.boolean().optional(),
        shy: z.boolean().optional(),
        solo: z.boolean().optional(),
        threeD: z.boolean().optional(),
        motionBlur: z.boolean().optional(),
        adjustmentLayer: z.boolean().optional(),
        label: z.number().int().min(0).max(16).optional().describe("Label color index, 0-16."),
      },
    },
    async (args) =>
      json(
        await runJsx(
          `
          var comp = AEMCP.comp(ARGS.comp);
          var layer = AEMCP.layer(comp, ARGS.layer);
          var transform = layer.property('ADBE Transform Group');

          if (ARGS.name !== undefined) { layer.name = ARGS.name; }
          if (ARGS.position !== undefined) { transform.property('ADBE Position').setValue(ARGS.position); }
          if (ARGS.anchorPoint !== undefined) { transform.property('ADBE Anchor Point').setValue(ARGS.anchorPoint); }
          if (ARGS.opacity !== undefined) { transform.property('ADBE Opacity').setValue(ARGS.opacity); }
          if (ARGS.rotation !== undefined) { AEMCP.rotationProp(layer).setValue(ARGS.rotation); }
          if (ARGS.scale !== undefined) {
              var scale = ARGS.scale;
              if (typeof scale === 'number') {
                  scale = layer.threeDLayer ? [scale, scale, scale] : [scale, scale];
              }
              transform.property('ADBE Scale').setValue(scale);
          }

          if (ARGS.startTime !== undefined) { layer.startTime = ARGS.startTime; }
          if (ARGS.inPoint !== undefined) { layer.inPoint = ARGS.inPoint; }
          if (ARGS.outPoint !== undefined) { layer.outPoint = ARGS.outPoint; }

          if (ARGS.parent !== undefined) {
              layer.parent = (ARGS.parent === null) ? null : AEMCP.layer(comp, ARGS.parent);
          }
          if (ARGS.blendingMode !== undefined) { layer.blendingMode = AEMCP.blendModeFrom(ARGS.blendingMode); }
          if (ARGS.enabled !== undefined) { layer.enabled = ARGS.enabled; }
          if (ARGS.locked !== undefined) { layer.locked = ARGS.locked; }
          if (ARGS.shy !== undefined) { layer.shy = ARGS.shy; }
          if (ARGS.solo !== undefined) { layer.solo = ARGS.solo; }
          if (ARGS.threeD !== undefined) { layer.threeDLayer = ARGS.threeD; }
          if (ARGS.motionBlur !== undefined) { layer.motionBlur = ARGS.motionBlur; }
          if (ARGS.adjustmentLayer !== undefined) { layer.adjustmentLayer = ARGS.adjustmentLayer; }
          if (ARGS.label !== undefined) { layer.label = ARGS.label; }

          return AEMCP.serializeLayer(layer, 'full');
          `,
          { args, undo: "MCP: set layer properties" }
        )
      )
  );

  defineTool(
    server,
    "ae_set_text",
    {
      title: "Set text content and style",
      description: "Change the string and character styling on a text layer.",
      inputSchema: {
        comp: compRef,
        layer: optionalLayerRef,
        text: z.string().optional().describe("New string. Use \\n for line breaks."),
        font: z.string().optional().describe("PostScript name, e.g. 'Helvetica-Bold'."),
        fontSize: z.number().positive().optional(),
        color: colorRef.optional().describe("Fill color."),
        strokeColor: colorRef.optional(),
        strokeWidth: z.number().min(0).optional(),
        tracking: z.number().optional(),
        leading: z.number().optional().describe("Line spacing in points."),
        justification: z.enum(["left", "center", "right"]).optional(),
        allCaps: z.boolean().optional(),
      },
    },
    async (args) =>
      json(
        await runJsx(
          `
          var comp = AEMCP.comp(ARGS.comp);
          var layer = AEMCP.layer(comp, ARGS.layer);
          if (!(layer instanceof TextLayer)) { AEMCP.err('"' + layer.name + '" is not a text layer.'); }

          var prop = layer.property('ADBE Text Properties').property('ADBE Text Document');
          var doc = prop.value;

          if (ARGS.text !== undefined) { doc.text = ARGS.text; }
          if (ARGS.font !== undefined) { doc.font = ARGS.font; }
          if (ARGS.fontSize !== undefined) { doc.fontSize = ARGS.fontSize; }
          if (ARGS.color !== undefined) { doc.applyFill = true; doc.fillColor = AEMCP.color(ARGS.color); }
          if (ARGS.strokeColor !== undefined) { doc.applyStroke = true; doc.strokeColor = AEMCP.color(ARGS.strokeColor); }
          if (ARGS.strokeWidth !== undefined) { doc.strokeWidth = ARGS.strokeWidth; }
          if (ARGS.tracking !== undefined) { doc.tracking = ARGS.tracking; }
          if (ARGS.leading !== undefined) { doc.leading = ARGS.leading; }
          if (ARGS.allCaps !== undefined) { doc.allCaps = ARGS.allCaps; }
          if (ARGS.justification !== undefined) {
              var modes = {
                  left: ParagraphJustification.LEFT_JUSTIFY,
                  center: ParagraphJustification.CENTER_JUSTIFY,
                  right: ParagraphJustification.RIGHT_JUSTIFY
              };
              doc.justification = AEMCP.own(modes, ARGS.justification);
          }

          prop.setValue(doc);
          return { layer: layer.name, index: layer.index, text: AEMCP.textDocument(prop.value) };
          `,
          { args, undo: "MCP: set text" }
        )
      )
  );

  defineTool(
    server,
    "ae_layer_op",
    {
      title: "Duplicate, delete, reorder or precompose layers",
      description:
        "Structural operations on layers: duplicate, delete, move in the stack, precompose a set of " +
        "layers into a new comp, or split at the current time.",
      inputSchema: {
        comp: compRef,
        op: z.enum(["duplicate", "delete", "move", "precompose", "split"]),
        layer: optionalLayerRef.describe("Target layer. For 'precompose', use `layers` instead."),
        layers: z
          .array(z.union([z.string(), z.number()]))
          .optional()
          .describe("For 'precompose' or bulk delete: the layers to act on."),
        toIndex: z.number().int().optional().describe("For 'move': the new 1-based index."),
        name: z.string().optional().describe("For 'precompose': the new comp's name."),
        moveAttributes: z
          .boolean()
          .optional()
          .describe("For 'precompose': move all attributes into the new comp. Default: true."),
      },
    },
    async (args) =>
      json(
        await runJsx(
          `
          var comp = AEMCP.comp(ARGS.comp);

          if (ARGS.op === 'precompose') {
              var targets = AEMCP.layers(comp, ARGS.layers || (ARGS.layer !== undefined ? [ARGS.layer] : null));
              var indices = [];
              for (var i = 0; i < targets.length; i++) { indices.push(targets[i].index); }
              var created = comp.layers.precompose(
                  indices,
                  ARGS.name || 'Pre-comp 1',
                  ARGS.moveAttributes !== false
              );
              return { precomposed: indices.length, comp: AEMCP.serializeComp(created, 'none') };
          }

          if (ARGS.op === 'delete') {
              var doomed = AEMCP.layers(comp, ARGS.layers || (ARGS.layer !== undefined ? [ARGS.layer] : null));
              var names = [];
              // Delete bottom-up so indices stay valid while we work.
              for (var d = doomed.length - 1; d >= 0; d--) { names.push(doomed[d].name); doomed[d].remove(); }
              return { deleted: names };
          }

          var layer = AEMCP.layer(comp, ARGS.layer);

          if (ARGS.op === 'duplicate') {
              var copy = layer.duplicate();
              if (ARGS.name) { copy.name = ARGS.name; }
              return AEMCP.serializeLayer(copy, 'minimal');
          }

          if (ARGS.op === 'move') {
              if (ARGS.toIndex === undefined) { AEMCP.err("'move' needs a toIndex."); }
              var target = Math.max(1, Math.min(ARGS.toIndex, comp.numLayers));
              if (target === 1) { layer.moveToBeginning(); }
              else if (target >= comp.numLayers) { layer.moveToEnd(); }
              else { layer.moveBefore(comp.layer(target > layer.index ? target + 1 : target)); }
              return AEMCP.serializeLayer(layer, 'minimal');
          }

          if (ARGS.op === 'split') {
              var piece = layer.split();
              return { original: AEMCP.serializeLayer(layer, 'minimal'), newLayer: AEMCP.serializeLayer(piece, 'minimal') };
          }

          AEMCP.err('Unknown op: ' + ARGS.op);
          `,
          { args, undo: "MCP: layer operation" }
        )
      )
  );

  defineTool(
    server,
    "ae_select",
    {
      title: "Select layers",
      description:
        "Change the timeline selection. Other tools fall back to the selection when you omit `layer`, " +
        "so this is how you say 'the ones I mean' once.",
      inputSchema: {
        comp: compRef,
        layers: z
          .array(z.union([z.string(), z.number()]))
          .optional()
          .describe("Layers to select. Omit or pass [] to deselect everything."),
      },
    },
    async (args) =>
      json(
        await runJsx(
          `
          var comp = AEMCP.comp(ARGS.comp);
          for (var i = 1; i <= comp.numLayers; i++) { comp.layer(i).selected = false; }

          var selected = [];
          var wanted = ARGS.layers || [];
          for (var j = 0; j < wanted.length; j++) {
              var layer = AEMCP.layer(comp, wanted[j]);
              layer.selected = true;
              selected.push({ index: layer.index, name: layer.name });
          }
          return { comp: comp.name, selected: selected };
          `,
          { args, undo: false }
        )
      )
  );
}
