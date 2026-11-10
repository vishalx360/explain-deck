/**
 * deck.json -> a single self-contained HTML explainer.
 *
 *   explain-deck build path/to/deck.json [--folder] [--no-open]
 *
 * Narration is synthesised one clip per step, encoded to mp3, and inlined as
 * data URIs alongside the syntax highlighter and diagram renderer, so the
 * result is one file that plays anywhere with no server and no network.
 *
 * Clips are cached by their narration text: fixing one sentence re-renders one
 * clip. --folder writes the multi-file form instead, for decks too large to
 * comfortably inline.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VENDOR = path.join(HERE, "..", "vendor");

// npx may wipe its own install dir between runs, so anything worth keeping
// (the speech model) lives in the user's cache, never next to the code.
const CACHE = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "explain-deck");

// Used only by --folder decks, which load libraries from the network. Kept in
// lockstep with the files in vendor/.
const CDN = {
  highlight: "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js",
  mermaid: "https://cdnjs.cloudflare.com/ajax/libs/mermaid/10.9.1/mermaid.min.js",
};

const die = (msg) => { console.error(`\nexplain-deck: ${msg}`); process.exit(1); };
import { loadConfig, modelTag, DEFAULT_ONNX } from "./model.mjs";

const cfg = loadConfig();
const log = (msg) => process.stderr.write(`  ${msg}\n`);

/* ------------------------------------------------------------------ backends */

const hasUv = () => {
  try { execFileSync("uv", ["--version"], { stdio: "ignore" }); return true; }
  catch { return false; }
};

/** Kokoro through MLX on Apple Silicon, ~17x realtime with the bf16 weights.
 *  `uv run` reads the dependency block at the top of tts_mlx.py and builds a
 *  cached environment on first use, so there is nothing for the user to set up.
 *  EXPLAIN_PYTHON points at a python that already has mlx_audio instead. */
function mlxBackend() {
  const script = path.join(HERE, "tts_mlx.py");
  const [cmd, args] = process.env.EXPLAIN_PYTHON
    ? [process.env.EXPLAIN_PYTHON, [script]]
    : ["uv", ["run", "--quiet", script]];
  const env = cfg.mlxModel ? { EXPLAIN_MLX_MODEL: cfg.mlxModel, ...process.env } : process.env;
  const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "inherit"], env });

  let buffer = "";
  const waiters = [];
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line || !waiters.length) continue;
      let msg;
      try { msg = JSON.parse(line); }
      catch { die(`tts backend wrote non-JSON on its protocol channel: ${line.slice(0, 120)}`); }
      waiters.shift().resolve(msg);
    }
  });
  // A worker that dies leaves its waiters hanging forever; fail them instead.
  const fail = (why) => { while (waiters.length) waiters.shift().reject(new Error(why)); };
  child.on("error", (e) => fail(e.message));
  child.on("exit", (code) => fail(`mlx worker exited with code ${code}`));

  const request = (obj) => new Promise((resolve, reject) => {
    waiters.push({ resolve, reject });
    if (obj) child.stdin.write(JSON.stringify(obj) + "\n");
  });
  return {
    name: "mlx",
    ready: request(null),            // the worker announces itself once loaded
    async synth(text, out, voice, speed) {
      const r = await request({ text, out, voice, speed });
      if (!r.ok) die(`tts failed: ${r.error}`);
      return r.duration;
    },
    close() { child.stdin.end(); },
  };
}

/** Kokoro through ONNX, everywhere. fp32 is the unquantised model: the q8
 *  build is a quarter of the size but audibly further from the original. */
async function onnxBackend() {
  const { env } = await import("@huggingface/transformers");
  env.cacheDir = path.join(CACHE, "models");
  const { KokoroTTS } = await import("kokoro-js");
  log("loading model (first run downloads ~330 MB)...");
  const tts = await KokoroTTS.from_pretrained(
    "onnx-community/Kokoro-82M-v1.0-ONNX", { dtype: cfg.onnxDtype || DEFAULT_ONNX, device: "cpu" });
  return {
    name: "onnx",
    async synth(text, out, voice, speed) {
      const audio = await tts.generate(text, { voice, speed });
      await audio.save(out);
      return audio.audio.length / audio.sampling_rate;
    },
    close() {},
  };
}

async function pickBackend() {
  const forced = process.env.EXPLAIN_TTS || cfg.backend;
  if (forced === "onnx") return onnxBackend();

  const appleSilicon = process.platform === "darwin" && process.arch === "arm64";
  const mlxPossible = appleSilicon && (process.env.EXPLAIN_PYTHON || hasUv());
  if (forced === "mlx" && !mlxPossible) die("the mlx backend (EXPLAIN_TTS or `explain-deck model`) needs Apple Silicon and uv (or EXPLAIN_PYTHON)");
  if (!mlxPossible) return onnxBackend();

  log("starting mlx worker (first run builds its environment, a minute or two)...");
  const mlx = mlxBackend();
  try {
    await mlx.ready;
    return mlx;
  } catch (e) {
    if (forced === "mlx") die(`mlx backend failed: ${e.message}`);
    log(`mlx backend failed (${e.message}), falling back to onnx`);
    return onnxBackend();
  }
}

/* ------------------------------------------------------------------- audio */

/** Read a wav as 16-bit PCM, whatever the backend wrote.
 *
 *  The two backends do not agree on format: mlx-audio writes 16-bit integer
 *  PCM, kokoro-js writes 32-bit IEEE float. Reading one as the other silently
 *  doubles the apparent length and turns the audio into noise, so the sample
 *  format is read from the header rather than assumed. */
function readWav(file) {
  const buf = fs.readFileSync(file);
  const audioFormat = buf.readUInt16LE(20);
  const channels = buf.readUInt16LE(22);
  const sampleRate = buf.readUInt32LE(24);
  const bits = buf.readUInt16LE(34);
  let off = 12;
  while (off < buf.length - 8) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "data") {
      const start = buf.byteOffset + off + 8;
      let pcm;
      if (audioFormat === 1 && bits === 16) {
        pcm = new Int16Array(buf.buffer, start, size / 2);
      } else if (audioFormat === 3 && bits === 32) {
        const f = new Float32Array(buf.buffer, start, size / 4);
        pcm = new Int16Array(f.length);
        for (let i = 0; i < f.length; i++) {
          const v = Math.max(-1, Math.min(1, f[i]));
          pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
        }
      } else {
        die(`${file}: unsupported wav format ${audioFormat} at ${bits}-bit`);
      }
      return { channels, sampleRate, pcm, duration: pcm.length / channels / sampleRate };
    }
    off += 8 + size + (size % 2);
  }
  die(`${file} has no data chunk`);
}

async function toMp3(wavFile, mp3File) {
  const { default: lamejs } = await import("@breezystack/lamejs");
  const { channels, sampleRate, pcm, duration } = readWav(wavFile);
  const enc = new lamejs.Mp3Encoder(channels, sampleRate, 64);
  const chunks = [];
  const BLOCK = 1152;
  for (let i = 0; i < pcm.length; i += BLOCK) {
    const b = enc.encodeBuffer(pcm.subarray(i, i + BLOCK));
    if (b.length) chunks.push(Buffer.from(b));
  }
  const tail = enc.flush();
  if (tail.length) chunks.push(Buffer.from(tail));
  fs.writeFileSync(mp3File, Buffer.concat(chunks));
  return duration;
}

/* --------------------------------------------------------------- validation */

const KINDS = { bullets: "bullets", code: "code", tree: "code", mermaid: "mermaid", image: "src" };

function parseLines(spec) {
  const out = new Set();
  for (const part of String(spec).split(",")) {
    const bits = part.trim().split("-").map(Number);
    if (bits.some(Number.isNaN)) die(`lit "${spec}" is not a line range like "3" or "1-8"`);
    for (let i = bits[0]; i <= bits[bits.length - 1]; i++) out.add(i);
  }
  return out;
}

const NODE_RE = /([A-Za-z_]\w*)\s*[[({]+\s*"?(.*?)"?\s*[\])}]+/g;

function mermaidNodes(src) {
  const head = (src.split("\n").find((l) => l.trim()) || "").trim();
  if (!/^(graph|flowchart)/.test(head)) return null;
  const found = [...src.matchAll(NODE_RE)].map((m) => [m[1], m[2]]);
  return found.length ? found : null;
}

function validate(deck) {
  if (!deck.slides?.length) die("deck has no slides");
  deck.slides.forEach((sl, i) => {
    const where = `slide ${i} (${sl.title || sl.kind || "?"})`;
    if (!(sl.kind in KINDS)) die(`${where}: kind "${sl.kind}" is not one of ${Object.keys(KINDS).join(", ")}`);
    if (!sl[KINDS[sl.kind]]) die(`${where}: kind "${sl.kind}" needs a "${KINDS[sl.kind]}" field`);
    if (!sl.steps?.length) die(`${where}: needs at least one step`);
    sl.steps.forEach((st, j) => {
      if (!st.say) die(`${where} step ${j}: needs a "say"`);
      if (st.lit === undefined) return;
      if (sl.kind === "code" || sl.kind === "tree") {
        const n = sl.code.split("\n").length;
        const over = [...parseLines(st.lit)].filter((x) => x < 1 || x > n).sort((a, b) => a - b);
        if (over.length) {
          const shown = over.slice(0, 4).join(", ");
          const more = over.length > 4 ? ` (+${over.length - 4} more)` : "";
          die(`${where} step ${j}: lit "${st.lit}" points at line(s) ${shown}${more} but the snippet has ${n} lines`);
        }
      } else if (sl.kind === "bullets") {
        const over = (Array.isArray(st.lit) ? st.lit : [st.lit]).filter((x) => x >= sl.bullets.length);
        if (over.length) die(`${where} step ${j}: lit ${JSON.stringify(st.lit)} points past the last bullet (there are ${sl.bullets.length})`);
      } else if (sl.kind === "mermaid") {
        const nodes = mermaidNodes(sl.mermaid);
        if (!nodes) return;
        for (const x of Array.isArray(st.lit) ? st.lit : [st.lit]) {
          const hits = nodes.filter(([id, lbl]) => id.split("-").includes(x) || lbl.includes(x));
          if (hits.length !== 1) {
            const names = nodes.map(([id, lbl]) => JSON.stringify(lbl || id)).join(", ");
            die(`${where} step ${j}: lit ${JSON.stringify(x)} ${hits.length ? `matches ${hits.length} nodes` : "matches no node"}. Nodes are: ${names}`);
          }
        }
      }
    });
  });
}

/* -------------------------------------------------------------------- main */

export async function build(argv) {
  const args = argv.filter((a) => !a.startsWith("-"));
  const flags = new Set(argv.filter((a) => a.startsWith("-")));
  if (!args.length) die("usage: explain-deck build path/to/deck.json [--folder] [--no-open]");

  const deckPath = path.resolve(args[0]);
  const outdir = path.dirname(deckPath);
  const deck = JSON.parse(fs.readFileSync(deckPath, "utf8"));
  validate(deck);

  const voice = deck.voice || cfg.voice || "af_heart";
  const speed = deck.speed || cfg.speed || 1.0;
  const stepsDir = path.join(outdir, "steps");
  fs.mkdirSync(stepsDir, { recursive: true });

  const cachePath = path.join(stepsDir, "cache.json");
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(cachePath, "utf8")); } catch { /* first build */ }

  const total = deck.slides.reduce((n, s) => n + s.steps.length, 0);
  const wanted = [];
  for (let si = 0; si < deck.slides.length; si++)
    for (let ti = 0; ti < deck.slides[si].steps.length; ti++)
      wanted.push([si, ti, `s${String(si).padStart(2, "0")}_${String(ti).padStart(2, "0")}.mp3`]);

  const keyOf = (say) => crypto.createHash("sha1")
    .update(`${voice}|${speed}|${say}` + (modelTag(cfg) && `|${modelTag(cfg)}`)).digest("hex").slice(0, 16);

  const missing = wanted.filter(([si, ti, name]) => {
    const hit = cache[name];
    return !(hit && hit.key === keyOf(deck.slides[si].steps[ti].say)
             && fs.existsSync(path.join(stepsDir, name)));
  });

  let backend = null;
  if (missing.length) {
    backend = await pickBackend();
    log(`backend: ${backend.name}, ${missing.length} of ${total} clips to render`);
  }

  const live = {};
  let done = 0;
  for (const [si, ti, name] of wanted) {
    const step = deck.slides[si].steps[ti];
    const key = keyOf(step.say);
    const mp3 = path.join(stepsDir, name);
    const hit = cache[name];
    if (hit && hit.key === key && fs.existsSync(mp3)) {
      step.duration = hit.duration;
    } else {
      const wav = path.join(stepsDir, `.${name}.wav`);
      const claimed = await backend.synth(step.say, wav, voice, speed);
      step.duration = await toMp3(wav, mp3);
      fs.unlinkSync(wav);
      // If these disagree the wav was decoded as the wrong sample format, which
      // otherwise shows up only as noise in a deck that built cleanly.
      if (Math.abs(claimed - step.duration) > 0.1 + claimed * 0.05)
        die(`${name}: backend reported ${claimed.toFixed(2)}s but the encoded clip is `
          + `${step.duration.toFixed(2)}s - wav format mismatch`);
      done++;
      log(`[${done}/${missing.length}] ${name}  ${step.duration.toFixed(1)}s`);
    }
    step.audio = `steps/${name}`;
    live[name] = { key, duration: step.duration };
  }
  backend?.close();

  // Clips from a longer previous version of the deck would otherwise linger.
  for (const stale of fs.readdirSync(stepsDir))
    if (!(stale in live) && stale !== "cache.json") fs.unlinkSync(path.join(stepsDir, stale));
  fs.writeFileSync(cachePath, JSON.stringify(live, null, 1));

  const standalone = !flags.has("--folder");
  const used = [
    deck.slides.some((s) => s.kind === "code") && "highlight",
    deck.slides.some((s) => s.kind === "mermaid") && "mermaid",
  ].filter(Boolean);

  let libs;
  if (standalone) {
    // Mermaid's source holds a literal U+FFFD (its HTML-entity decoder returns
    // it for invalid code points). As a JS escape it means the same thing in a
    // string or regex, and the page stays free of a character that a publish
    // check reads as text lost in an edit.
    libs = used.map((n) => `<script>${fs.readFileSync(path.join(VENDOR, `${n}.min.js`), "utf8")}</script>`)
      .join("\n").replace(/�/g, "\\uFFFD");
    for (const [si, ti, name] of wanted) {
      const b64 = fs.readFileSync(path.join(stepsDir, name)).toString("base64");
      deck.slides[si].steps[ti].audio = `data:audio/mpeg;base64,${b64}`;
    }
  } else {
    libs = used.map((n) => `<script src="${CDN[n]}"></script>`).join("\n");
  }

  const template = fs.readFileSync(path.join(HERE, "player.html"), "utf8");
  const blob = JSON.stringify(deck).replace(/<\//g, "<\\/");
  // The <title> is the name a browser tab and a hosted artifact show, so it
  // comes from the deck: `page_title` (short) when given, else `title`.
  const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const pageTitle = escapeHtml(deck.page_title || deck.title || "Explainer");
  const html = template.replace("<!--LIBS-->", () => libs)
                       .replace("<title>Explainer</title>", () => `<title>${pageTitle}</title>`)
                       .replace("/*DECK*/null", () => blob);

  const slug = path.basename(outdir).replace(/[^\w.-]+/g, "-");
  const outFile = path.join(outdir, standalone ? `${slug}.html` : "index.html");
  fs.writeFileSync(outFile, html);

  const spoken = deck.slides.reduce((n, s) => n + s.steps.reduce((m, t) => m + t.duration, 0), 0);
  const reused = total - done;
  console.log(`\n${deck.slides.length} slides, ${total} steps, ${(spoken / 60).toFixed(1)} min narration`
    + (reused ? `, ${reused} clips reused` : ""));
  console.log(`${(fs.statSync(outFile).size / 1e6).toFixed(1)} MB  ${outFile}`);

  if (!flags.has("--no-open")) {
    const opener = process.platform === "darwin" ? "open"
      : process.platform === "win32" ? "start" : "xdg-open";
    try { execFileSync(opener, [outFile], { stdio: "ignore" }); } catch { /* headless */ }
  }
}
