/**
 * Choose which Kokoro build speaks, and download it.
 *
 *   explain-deck model          pick interactively, download, save
 *   explain-deck model --show   print the saved choice
 *
 * The choice lives in ~/.config/explain-deck/config.json and is the default for
 * every build. A deck's own `voice`/`speed` and the EXPLAIN_TTS env var win.
 *
 * The interactive UI (src/ui) drives the same functions exported here, so the
 * prompt below and the Models tab cannot disagree about what a preset means.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CONFIG = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "explain-deck", "config.json");
export const CACHE = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "explain-deck");
const HF_HUB = process.env.HF_HUB_CACHE
  || path.join(process.env.HF_HOME || path.join(os.homedir(), ".cache", "huggingface"), "hub");
const ONNX_REPO = "onnx-community/Kokoro-82M-v1.0-ONNX";
// kokoro-js dtype -> the file it loads from the repo's onnx/ folder.
const ONNX_FILE = { fp32: "model.onnx", q8: "model_quantized.onnx" };

export const DEFAULT_MLX = "mlx-community/Kokoro-82M-bf16";
export const DEFAULT_ONNX = "fp32";
export const appleSilicon = process.platform === "darwin" && process.arch === "arm64";

export function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG, "utf8")); } catch { return {}; }
}

export function saveConfig(cfg) {
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + "\n");
}

/** Part of the clip cache key, so switching to a different build re-renders.
 *  Empty for the defaults, which keeps existing caches valid. */
export function modelTag(cfg) {
  if (cfg.backend === "mlx" && cfg.mlxModel && cfg.mlxModel !== DEFAULT_MLX) return cfg.mlxModel;
  if (cfg.backend === "onnx" && cfg.onnxDtype && cfg.onnxDtype !== DEFAULT_ONNX) return `onnx-${cfg.onnxDtype}`;
  return "";
}

export const PRESETS = [
  { id: "mlx-bf16", name: "MLX bf16", note: "best quality, fastest", apple: true,
    cfg: { backend: "mlx", mlxModel: DEFAULT_MLX } },
  { id: "mlx-8bit", name: "MLX 8-bit", note: "smaller, near-identical", apple: true,
    cfg: { backend: "mlx", mlxModel: "mlx-community/Kokoro-82M-8bit" } },
  { id: "mlx-4bit", name: "MLX 4-bit", note: "smallest MLX, audibly rougher", apple: true,
    cfg: { backend: "mlx", mlxModel: "mlx-community/Kokoro-82M-4bit" } },
  { id: "onnx-fp32", name: "ONNX fp32", note: "any machine, ~330 MB",
    cfg: { backend: "onnx", onnxDtype: "fp32" } },
  { id: "onnx-q8", name: "ONNX q8", note: "any machine, a quarter of the size, slightly rougher",
    cfg: { backend: "onnx", onnxDtype: "q8" } },
];

/** Presets this machine can run. */
export const usablePresets = () => PRESETS.filter((p) => !p.apple || appleSilicon);

/** The preset a build uses right now: the saved choice, else what a build
 *  would pick on its own. */
export function activePreset(cfg = loadConfig()) {
  if (cfg.backend === "mlx") return PRESETS.find((p) => p.cfg.mlxModel === (cfg.mlxModel || DEFAULT_MLX));
  if (cfg.backend === "onnx") return PRESETS.find((p) => p.cfg.onnxDtype === (cfg.onnxDtype || DEFAULT_ONNX));
  return PRESETS.find((p) => p.id === (appleSilicon ? "mlx-bf16" : "onnx-fp32"));
}

/* ------------------------------------------------------------ disk locations */

const hfDir = (model) => path.join(HF_HUB, `models--${model.replace("/", "--")}`);
const onnxFile = (dtype) => path.join(CACHE, "models", ONNX_REPO, "onnx", ONNX_FILE[dtype]);

function dirBytes(dir) {
  let n = 0;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) n += dirBytes(p);
    else try { n += fs.statSync(p).size; } catch { /* dangling link */ }
  }
  return n;
}

/** { downloaded, bytes } for one preset. MLX weights live in the shared
 *  Hugging Face cache; the actual bytes are in blobs/, snapshots/ only links. */
export function presetStatus(preset) {
  if (preset.cfg.backend === "mlx") {
    const dir = hfDir(preset.cfg.mlxModel);
    const snaps = path.join(dir, "snapshots");
    const downloaded = fs.existsSync(snaps) && fs.readdirSync(snaps).length > 0;
    return { downloaded, bytes: downloaded ? dirBytes(path.join(dir, "blobs")) : 0 };
  }
  const file = onnxFile(preset.cfg.onnxDtype);
  try { return { downloaded: true, bytes: fs.statSync(file).size }; }
  catch { return { downloaded: false, bytes: 0 }; }
}

/** Delete a preset's downloaded weights. MLX removes that model's own cache
 *  folder only (the Hugging Face cache is shared with other tools). ONNX removes
 *  just that build's weight file; the voices and config it shares stay. */
export function removePreset(preset) {
  if (preset.cfg.backend === "mlx") fs.rmSync(hfDir(preset.cfg.mlxModel), { recursive: true, force: true });
  else fs.rmSync(onnxFile(preset.cfg.onnxDtype), { force: true });
}

/* ----------------------------------------------------------------- download */

/** Start the mlx worker just long enough for it to fetch and load the weights.
 *  `quiet` hides its progress output, for callers that draw their own screen. */
function downloadMlx(model, quiet) {
  return new Promise((resolve, reject) => {
    const script = path.join(HERE, "tts_mlx.py");
    const [cmd, args] = process.env.EXPLAIN_PYTHON
      ? [process.env.EXPLAIN_PYTHON, [script]]
      : ["uv", ["run", "--quiet", script]];
    const child = spawn(cmd, args, {
      stdio: ["pipe", "pipe", quiet ? "ignore" : "inherit"],
      env: { ...process.env, EXPLAIN_MLX_MODEL: model },
    });
    child.stdout.once("data", () => child.stdin.end());   // the "ready" line
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`worker exited with code ${code}`)));
  });
}

async function downloadOnnx(dtype, quiet) {
  const { env } = await import("@huggingface/transformers");
  env.cacheDir = path.join(CACHE, "models");
  const { KokoroTTS } = await import("kokoro-js");
  await KokoroTTS.from_pretrained(ONNX_REPO, {
    dtype, device: "cpu", ...(quiet ? { progress_callback: () => {} } : {}),
  });
}

export function downloadPreset(preset, { quiet = false } = {}) {
  return preset.cfg.backend === "mlx"
    ? downloadMlx(preset.cfg.mlxModel, quiet)
    : downloadOnnx(preset.cfg.onnxDtype, quiet);
}

export const validVoice = (v) => /^[ab][fm]_\w+$/.test(v);
export const validSpeed = (s) => s >= 0.5 && s <= 2;

/* -------------------------------------------------------------- the command */

export async function model(argv) {
  const cfg = loadConfig();
  if (argv.includes("--show")) {
    console.log(fs.existsSync(CONFIG) ? JSON.stringify(cfg, null, 2) : "no saved choice; builds use the defaults (MLX bf16 if available, else ONNX fp32, voice af_heart)");
    return;
  }
  if (!process.stdin.isTTY) {
    console.error("explain-deck: `model` is interactive; run it in a terminal.");
    process.exit(1);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const usable = usablePresets();
    console.log("\nSpeech model (Kokoro-82M):");
    usable.forEach((p, i) => console.log(`  ${i + 1}) ${p.name.padEnd(9)} - ${p.note}`));
    const n = Number((await rl.question(`Choose 1-${usable.length}: `)).trim());
    const preset = usable[n - 1];
    if (!preset) { console.error("explain-deck: not a choice, nothing changed."); process.exit(1); }

    const voice = (await rl.question(`Voice [${cfg.voice || "af_heart"}] (af_/bf_ female, am_/bm_ male): `)).trim() || cfg.voice || "af_heart";
    if (!validVoice(voice)) { console.error(`explain-deck: "${voice}" is not a Kokoro voice id, nothing changed.`); process.exit(1); }
    const speedIn = (await rl.question(`Speed [${cfg.speed || 1}]: `)).trim();
    const speed = speedIn ? Number(speedIn) : cfg.speed || 1;
    if (!validSpeed(speed)) { console.error("explain-deck: speed must be between 0.5 and 2, nothing changed."); process.exit(1); }

    console.log("\nDownloading (skipped by the model host if already cached)...");
    try {
      await downloadPreset(preset);
    } catch (e) {
      console.error(`\nexplain-deck: download failed (${e.message}); nothing changed.`);
      process.exit(1);
    }

    saveConfig({ ...preset.cfg, voice, speed });
    console.log(`\nSaved ${CONFIG}\nEvery build now uses it. Existing decks re-render their clips on the next build.`);
  } finally {
    rl.close();
  }
}
