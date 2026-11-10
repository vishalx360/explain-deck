/**
 * The interactive screen: `explain-deck` with no arguments.
 *
 * Two tabs. Decks lists every explainer this machine has built (from the index
 * in src/store.mjs) and opens them. Models shows the five Kokoro builds and
 * lets you switch, download, delete, retune the voice, and hear a sample.
 *
 * Written with htm instead of JSX so src/ stays plain .mjs with no build step.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import React, { useState, useCallback } from "react";
import { render, Box, Text, useApp, useInput, useStdout } from "ink";
import htm from "htm";
import { readIndex, removeDeck, scanFolder } from "../store.mjs";
import { openFile } from "../build.mjs";
import {
  CONFIG, loadConfig, saveConfig, usablePresets, activePreset, presetStatus,
  removePreset, downloadPreset, validVoice, validSpeed,
} from "../model.mjs";

const html = htm.bind(React.createElement);
const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "explain-deck.mjs");

/* ------------------------------------------------------------------ helpers */

const mb = (n) => n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)} MB`;
const mins = (s) => s ? `${(s / 60).toFixed(1)} min` : "-";
const when = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(+d) ? "-" : `${d.toLocaleDateString("en-CA")} ${d.toTimeString().slice(0, 5)}`;
};
const tidy = (p) => p.startsWith(os.homedir()) ? `~${p.slice(os.homedir().length)}` : p;
const pad = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));

const newestFirst = () => readIndex().sort((a, b) => (b.builtAt || "").localeCompare(a.builtAt || ""));

function reveal(file) {
  const [cmd, args] = process.platform === "darwin" ? ["open", ["-R", file]]
    : [process.platform === "win32" ? "explorer" : "xdg-open", [path.dirname(file)]];
  spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}

/** Play a wav with whatever this machine has. Resolves false if nothing could. */
function play(file) {
  const players = process.platform === "darwin" ? [["afplay", [file]]]
    : [["paplay", [file]], ["aplay", ["-q", file]]];
  return new Promise((resolve) => {
    const next = (i) => {
      if (i >= players.length) return resolve(false);
      const child = spawn(players[i][0], players[i][1], { stdio: "ignore" });
      child.on("error", () => next(i + 1));
      child.on("exit", (code) => (code === 0 ? resolve(true) : next(i + 1)));
    };
    next(0);
  });
}

/** Render the sample in a child process, because a backend that cannot start
 *  exits the process, which here would take the whole screen with it. */
function renderSample(voice, speed) {
  const out = path.join(os.tmpdir(), `explain-deck-preview-${process.pid}.wav`);
  return new Promise((resolve, reject) => {
    let err = "";
    const child = spawn(process.execPath, [BIN, "preview", out, voice, String(speed)],
      { stdio: ["ignore", "ignore", "pipe"] });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve(out)
      : reject(new Error(err.trim().split("\n").filter((l) => !/^\s*(Fetching|npm notice)/.test(l)).pop() || `exit ${code}`)));
  });
}

/* ---------------------------------------------------------------- components */

function Tabs({ tab }) {
  const item = (id, label) => html`<${Text} bold=${tab === id} inverse=${tab === id} dimColor=${tab !== id}> ${label} </${Text}>`;
  return html`<${Box} gap=${1}>${item("decks", "Decks")}${item("models", "Models")}</${Box}>`;
}

function Decks({ decks, sel, rows, width }) {
  if (!decks.length) {
    return html`<${Box} flexDirection="column">
      <${Text} dimColor>No decks recorded yet.</${Text}>
      <${Text} dimColor>Build one with your agent, or press <${Text} bold>s</${Text}> to import decks from a folder.</${Text}>
    </${Box}>`;
  }
  const start = Math.max(0, Math.min(sel - Math.floor(rows / 2), decks.length - rows));
  const shown = decks.slice(start, start + rows);
  const titleW = Math.max(20, width - 52);
  return html`<${Box} flexDirection="column">
    <${Text} dimColor>  ${pad("TITLE", titleW)} ${pad("SLIDES", 6)}  ${pad("NARRATION", 9)}  ${pad("SIZE", 7)}  BUILT</${Text}>
    ${shown.map((d, i) => {
      const on = start + i === sel;
      const gone = !fs.existsSync(d.path);
      return html`<${Text} key=${d.path} inverse=${on} color=${gone ? "red" : undefined} wrap="truncate-end">
        ${on ? "›" : " "} ${pad(d.pageTitle || d.title, titleW)} ${pad(String(d.slides), 6)}  ${pad(mins(d.narrationSec), 9)}  ${pad(mb(d.sizeBytes || 0), 7)}  ${gone ? "missing" : when(d.builtAt)}
      </${Text}>`;
    })}
    ${decks.length > rows ? html`<${Text} dimColor>  ${sel + 1}/${decks.length}</${Text}>` : null}
  </${Box}>`;
}

function Models({ presets, sel, cfg, statuses }) {
  const active = activePreset(cfg);
  return html`<${Box} flexDirection="column">
    <${Text} dimColor>  ${pad("BUILD", 11)} ${pad("STATE", 19)} ${pad("SIZE", 8)} NOTE</${Text}>
    ${presets.map((p, i) => {
      const st = statuses[p.id] || {};
      const isActive = active?.id === p.id;
      return html`<${Text} key=${p.id} inverse=${i === sel} wrap="truncate-end">
        ${i === sel ? "›" : " "} ${pad(p.name, 11)} ${pad(isActive ? (cfg.backend ? "● active" : "● active (default)") : st.downloaded ? "downloaded" : "not downloaded", 19)} ${pad(st.downloaded ? mb(st.bytes) : "-", 8)} ${p.note}
      </${Text}>`;
    })}
    <${Text}> </${Text}>
    <${Text}>  Voice <${Text} bold>${cfg.voice || "af_heart"}</${Text}>   Speed <${Text} bold>${cfg.speed || 1}</${Text}>   <${Text} dimColor>saved to ${tidy(CONFIG)}</${Text}></${Text}>
  </${Box}>`;
}

function App() {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const width = stdout.columns || 100;
  const rows = Math.max(5, (stdout.rows || 30) - 12);

  const presets = usablePresets();
  const [tab, setTab] = useState("decks");
  const [decks, setDecks] = useState(newestFirst);
  const [deckSel, setDeckSel] = useState(0);
  const [modelSel, setModelSel] = useState(0);
  const [cfg, setCfg] = useState(loadConfig);
  const statusOf = () => Object.fromEntries(presets.map((p) => [p.id, presetStatus(p)]));
  const [statuses, setStatuses] = useState(statusOf);
  // mode: null | { kind: "confirm", ask, then } | { kind: "input", label, value, then }
  const [mode, setMode] = useState(null);
  const [busy, setBusy] = useState(null);
  const [note, setNote] = useState(null);

  const refreshDecks = useCallback(() => {
    const list = newestFirst();
    setDecks(list);
    setDeckSel((s) => Math.min(s, Math.max(0, list.length - 1)));
  }, []);
  const refreshModels = useCallback(() => { setCfg(loadConfig()); setStatuses(statusOf()); }, []);

  const guarded = async (label, fn) => {
    setBusy(label); setNote(null);
    try { setNote(await fn()); }
    catch (e) { setNote(`Failed: ${e.message}`); }
    setBusy(null);
  };

  const activate = (preset) => guarded(`Preparing ${preset.name} (downloads on first use)...`, async () => {
    if (!presetStatus(preset).downloaded) await downloadPreset(preset, { quiet: true });
    const cur = loadConfig();
    saveConfig({ ...preset.cfg, voice: cur.voice || "af_heart", speed: cur.speed || 1 });
    refreshModels();
    return `${preset.name} is now the default. Existing decks re-render on their next build.`;
  });

  const sample = () => guarded("Rendering a sample...", async () => {
    const c = loadConfig();
    const file = await renderSample(c.voice || "af_heart", c.speed || 1);
    setBusy("Playing...");
    const ok = await play(file);
    if (ok) fs.rmSync(file, { force: true });
    return ok ? "Played a sample with the active model." : `No audio player found. Sample saved at ${file}`;
  });

  useInput((input, key) => {
    if (busy) return;

    if (mode?.kind === "confirm") {
      const go = input === "y" || input === "Y";
      setMode(null);
      if (go) mode.then(); else setNote("Cancelled.");
      return;
    }
    if (mode?.kind === "input") {
      if (key.escape) { setMode(null); return; }
      if (key.return) { const m = mode; setMode(null); m.then(m.value.trim()); return; }
      if (key.backspace || key.delete) { setMode({ ...mode, value: mode.value.slice(0, -1) }); return; }
      if (input && !key.ctrl && !key.meta) setMode({ ...mode, value: mode.value + input });
      return;
    }

    if (input === "q" || key.escape || (key.ctrl && input === "c")) { exit(); return; }
    if (key.tab || key.leftArrow || key.rightArrow || input === "1" || input === "2") {
      setTab(input === "1" ? "decks" : input === "2" ? "models" : tab === "decks" ? "models" : "decks");
      setNote(null);
      return;
    }
    const move = key.upArrow || input === "k" ? -1 : key.downArrow || input === "j" ? 1 : 0;

    if (tab === "decks") {
      if (move) setDeckSel((s) => Math.max(0, Math.min(decks.length - 1, s + move)));
      const d = decks[deckSel];
      if (key.return && d) {
        if (!fs.existsSync(d.path)) setNote("That file is gone. Press d to drop it from the list.");
        else { openFile(d.path); setNote(`Opened ${tidy(d.path)}`); }
      } else if (input === "f" && d) reveal(d.path);
      else if (input === "d" && d) setMode({
        kind: "confirm", ask: `Remove "${d.pageTitle || d.title}" from this list? The files stay on disk. (y/N)`,
        then: () => { removeDeck(d.path); refreshDecks(); setNote("Removed from the list."); },
      });
      else if (input === "s") setMode({
        kind: "input", label: "Import decks from folder", value: process.cwd(),
        then: (dir) => {
          const n = fs.existsSync(dir) ? scanFolder(dir) : 0;
          refreshDecks();
          setNote(n ? `Imported ${n} deck${n === 1 ? "" : "s"} from ${tidy(dir)}.` : `No built decks found under ${tidy(dir)}.`);
        },
      });
    } else {
      if (move) setModelSel((s) => Math.max(0, Math.min(presets.length - 1, s + move)));
      const p = presets[modelSel];
      if (key.return) activate(p);
      else if (input === "p") sample();
      else if (input === "x") {
        const st = presetStatus(p);
        if (!st.downloaded) setNote(`${p.name} is not downloaded.`);
        else setMode({
          kind: "confirm", ask: `Delete the downloaded ${p.name} weights (${mb(st.bytes)})? (y/N)`,
          then: () => { removePreset(p); refreshModels(); setNote(`Deleted ${p.name}.`); },
        });
      } else if (input === "v") setMode({
        kind: "input", label: "Voice (af_/bf_ female, am_/bm_ male)", value: cfg.voice || "af_heart",
        then: (v) => {
          if (!validVoice(v)) return setNote(`"${v}" is not a Kokoro voice id.`);
          saveConfig({ ...loadConfig(), voice: v });
          refreshModels(); setNote(`Voice set to ${v}.`);
        },
      });
      else if (input === "e") setMode({
        kind: "input", label: "Speed (0.5 to 2)", value: String(cfg.speed || 1),
        then: (v) => {
          const n = Number(v);
          if (!validSpeed(n)) return setNote("Speed must be between 0.5 and 2.");
          saveConfig({ ...loadConfig(), speed: n });
          refreshModels(); setNote(`Speed set to ${n}.`);
        },
      });
    }
  });

  const hints = tab === "decks"
    ? "↑↓ move   enter open   f reveal   d remove   s import folder   tab switch   q quit"
    : "↑↓ move   enter use   x delete   v voice   e speed   p preview   tab switch   q quit";
  const detail = tab === "decks" && decks[deckSel]
    ? `${tidy(decks[deckSel].path)}${decks[deckSel].voice ? `  ·  voice ${decks[deckSel].voice}` : ""}` : null;

  return html`<${Box} flexDirection="column" paddingX=${1}>
    <${Box} justifyContent="space-between">
      <${Text} bold>explain-deck</${Text}>
      <${Tabs} tab=${tab} />
    </${Box}>
    <${Text}> </${Text}>
    ${tab === "decks"
      ? html`<${Decks} decks=${decks} sel=${deckSel} rows=${rows} width=${width} />`
      : html`<${Models} presets=${presets} sel=${modelSel} cfg=${cfg} statuses=${statuses} />`}
    <${Text}> </${Text}>
    ${detail ? html`<${Text} dimColor wrap="truncate-start">${detail}</${Text}>` : null}
    ${busy ? html`<${Text} color="yellow">${busy}</${Text}>` : null}
    ${!busy && !mode && note ? html`<${Text} color="green" wrap="truncate-end">${note}</${Text}>` : null}
    ${mode?.kind === "confirm" ? html`<${Text} color="yellow">${mode.ask}</${Text}>` : null}
    ${mode?.kind === "input" ? html`<${Text}>${mode.label}: <${Text} bold>${mode.value}</${Text}><${Text} inverse> </${Text}>  <${Text} dimColor>enter to accept, esc to cancel</${Text}></${Text}>` : null}
    <${Text} dimColor>${hints}</${Text}>
  </${Box}>`;
}

/** Take over the terminal on its alternate screen and give it back on exit. */
export async function run() {
  process.stdout.write("\x1b[?1049h\x1b[H");
  const restore = () => process.stdout.write("\x1b[?1049l");
  process.on("exit", restore);
  const app = render(html`<${App} />`, { exitOnCtrlC: false });
  await app.waitUntilExit();
}
