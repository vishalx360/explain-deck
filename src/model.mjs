/**
 * Choose which Kokoro build speaks, and download it.
 *
 *   explain-deck model          pick interactively, download, save
 *   explain-deck model --show   print the saved choice
 *
 * The choice lives in ~/.config/explain-deck/config.json and is the default for
 * every build. A deck's own `voice`/`speed` and the EXPLAIN_TTS env var win.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "explain-deck", "config.json");
const CACHE = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "explain-deck");

export const DEFAULT_MLX = "mlx-community/Kokoro-82M-bf16";
export const DEFAULT_ONNX = "fp32";

export function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG, "utf8")); } catch { return {}; }
}

/** Part of the clip cache key, so switching to a different build re-renders.
 *  Empty for the defaults, which keeps existing caches valid. */
export function modelTag(cfg) {
  if (cfg.backend === "mlx" && cfg.mlxModel && cfg.mlxModel !== DEFAULT_MLX) return cfg.mlxModel;
  if (cfg.backend === "onnx" && cfg.onnxDtype && cfg.onnxDtype !== DEFAULT_ONNX) return `onnx-${cfg.onnxDtype}`;
  return "";
}

const appleSilicon = process.platform === "darwin" && process.arch === "arm64";

const PRESETS = [
  { label: "MLX bf16  - best quality, fastest (Apple Silicon, needs uv)", apple: true,
    cfg: { backend: "mlx", mlxModel: DEFAULT_MLX } },
  { label: "MLX 8-bit - smaller, near-identical (Apple Silicon, needs uv)", apple: true,
    cfg: { backend: "mlx", mlxModel: "mlx-community/Kokoro-82M-8bit" } },
  { label: "MLX 4-bit - smallest MLX, audibly rougher (Apple Silicon, needs uv)", apple: true,
    cfg: { backend: "mlx", mlxModel: "mlx-community/Kokoro-82M-4bit" } },
  { label: "ONNX fp32 - any machine, ~330 MB", cfg: { backend: "onnx", onnxDtype: "fp32" } },
  { label: "ONNX q8   - any machine, a quarter of the size, slightly rougher", cfg: { backend: "onnx", onnxDtype: "q8" } },
];

/** Start the mlx worker just long enough for it to fetch and load the weights. */
function downloadMlx(model) {
  return new Promise((resolve, reject) => {
    const script = path.join(HERE, "tts_mlx.py");
    const [cmd, args] = process.env.EXPLAIN_PYTHON
      ? [process.env.EXPLAIN_PYTHON, [script]]
      : ["uv", ["run", "--quiet", script]];
    const child = spawn(cmd, args, {
      stdio: ["pipe", "pipe", "inherit"],
      env: { ...process.env, EXPLAIN_MLX_MODEL: model },
    });
    child.stdout.once("data", () => child.stdin.end());   // the "ready" line
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`worker exited with code ${code}`)));
  });
}

async function downloadOnnx(dtype) {
  const { env } = await import("@huggingface/transformers");
  env.cacheDir = path.join(CACHE, "models");
  const { KokoroTTS } = await import("kokoro-js");
  await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", { dtype, device: "cpu" });
}

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
    const usable = PRESETS.filter((p) => !p.apple || appleSilicon);
    console.log("\nSpeech model (Kokoro-82M):");
    usable.forEach((p, i) => console.log(`  ${i + 1}) ${p.label}`));
    const n = Number((await rl.question(`Choose 1-${usable.length}: `)).trim());
    const preset = usable[n - 1];
    if (!preset) { console.error("explain-deck: not a choice, nothing changed."); process.exit(1); }

    const voice = (await rl.question(`Voice [${cfg.voice || "af_heart"}] (af_/bf_ female, am_/bm_ male): `)).trim() || cfg.voice || "af_heart";
    if (!/^[ab][fm]_\w+$/.test(voice)) { console.error(`explain-deck: "${voice}" is not a Kokoro voice id, nothing changed.`); process.exit(1); }
    const speedIn = (await rl.question(`Speed [${cfg.speed || 1}]: `)).trim();
    const speed = speedIn ? Number(speedIn) : cfg.speed || 1;
    if (!(speed >= 0.5 && speed <= 2)) { console.error("explain-deck: speed must be between 0.5 and 2, nothing changed."); process.exit(1); }

    console.log("\nDownloading (skipped by the model host if already cached)...");
    try {
      if (preset.cfg.backend === "mlx") await downloadMlx(preset.cfg.mlxModel);
      else await downloadOnnx(preset.cfg.onnxDtype);
    } catch (e) {
      console.error(`\nexplain-deck: download failed (${e.message}); nothing changed.`);
      process.exit(1);
    }

    fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
    fs.writeFileSync(CONFIG, JSON.stringify({ ...preset.cfg, voice, speed }, null, 2) + "\n");
    console.log(`\nSaved ${CONFIG}\nEvery build now uses it. Existing decks re-render their clips on the next build.`);
  } finally {
    rl.close();
  }
}
