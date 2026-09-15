#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import * as animation from "./tools/animation.js";
import * as comps from "./tools/comps.js";
import * as effects from "./tools/effects.js";
import * as layers from "./tools/layers.js";
import * as project from "./tools/project.js";
import * as render from "./tools/render.js";
import * as scripting from "./tools/scripting.js";

const server = new McpServer(
  { name: "after-effects", version: "0.1.0" },
  {
    capabilities: { tools: {} },
    instructions:
      "Drives Adobe After Effects on macOS through ExtendScript.\n\n" +
      "Start with ae_status to confirm After Effects is running, then ae_list_comps / ae_comp_info to " +
      "see what you are working with. Read before you write: ae_comp_info reports each layer's " +
      "transform, effects, and which properties are keyframed.\n\n" +
      "Every mutating tool creates its own undo group, so the user can step back with Cmd-Z or ae_undo.\n\n" +
      "After making visual changes, call ae_save_frame to actually look at the result rather than " +
      "assuming it worked.\n\n" +
      "Property paths are dot-separated and accept display names or matchNames: 'Transform.Position', " +
      "'Effects.Gaussian Blur.Blurriness'. When unsure of a name, use ae_get_property on the parent " +
      "group or ae_list_effect_params — both list valid children.\n\n" +
      "Anything the typed tools don't cover can be done with ae_run_script, which runs raw ExtendScript.",
  }
);

project.register(server);
comps.register(server);
layers.register(server);
animation.register(server);
effects.register(server);
render.register(server);
scripting.register(server);

const transport = new StdioServerTransport();
await server.connect(transport);

// stdout belongs to the protocol; anything we want to say goes to stderr.
process.stderr.write("[after-effects-mcp] ready\n");
