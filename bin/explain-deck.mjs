#!/usr/bin/env node
import fs from "node:fs";
import { build } from "../src/build.mjs";
import { model } from "../src/model.mjs";
import { init } from "../src/init.mjs";

const USAGE = `explain-deck - narrated, self-playing slide decks for coding agents

  explain-deck init [--agent claude-code,codex,...]   install the skill into your agents
  explain-deck model [--show]                         choose and download the speech model
  explain-deck build <folder>/deck.json [--folder] [--no-open]
  explain-deck --version

Environment: EXPLAIN_TTS=mlx|onnx forces a speech backend,
EXPLAIN_PYTHON=<python with mlx_audio> skips uv for the mlx backend.`;

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "build") await build(rest);
else if (cmd === "init") init(rest);
else if (cmd === "model") await model(rest);
else if (cmd === "--version" || cmd === "-v") {
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url)));
  console.log(pkg.version);
} else {
  console.log(USAGE);
  if (cmd && cmd !== "help" && cmd !== "--help" && cmd !== "-h") process.exit(1);
}
