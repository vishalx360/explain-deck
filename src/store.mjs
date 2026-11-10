/**
 * The list of decks this machine has built, for the interactive UI.
 *
 * ~/.local/share/explain-deck/index.json holds one entry per built .html file,
 * keyed by its absolute path, so rebuilding a deck updates its entry instead of
 * adding another. Nothing here is required to build a deck: callers treat every
 * failure as "no history", never as a build error.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DATA = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "explain-deck");
export const INDEX = path.join(DATA, "index.json");

export function readIndex() {
  try {
    const list = JSON.parse(fs.readFileSync(INDEX, "utf8"));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function writeIndex(list) {
  fs.mkdirSync(DATA, { recursive: true });
  const tmp = `${INDEX}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 1));
  fs.renameSync(tmp, INDEX);
}

/** Add or replace the entry for entry.path. */
export function recordDeck(entry) {
  const list = readIndex().filter((d) => d.path !== entry.path);
  list.push(entry);
  writeIndex(list);
}

export function removeDeck(file) {
  writeIndex(readIndex().filter((d) => d.path !== file));
}

/** Describe the deck at <dir>/deck.json from what is already on disk, without
 *  rebuilding. Returns null when there is no built .html next to it. */
function describe(dir) {
  const deckJson = path.join(dir, "deck.json");
  let deck;
  try { deck = JSON.parse(fs.readFileSync(deckJson, "utf8")); } catch { return null; }
  if (!Array.isArray(deck.slides)) return null;

  const slug = path.basename(dir).replace(/[^\w.-]+/g, "-");
  const html = [`${slug}.html`, "index.html"].map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));
  if (!html) return null;

  let narrationSec = 0;
  try {
    const clips = JSON.parse(fs.readFileSync(path.join(dir, "steps", "cache.json"), "utf8"));
    narrationSec = Object.values(clips).reduce((n, c) => n + (c.duration || 0), 0);
  } catch { /* an older deck without a clip cache */ }

  const st = fs.statSync(html);
  return {
    path: html,
    deckJson,
    title: deck.title || slug,
    pageTitle: deck.page_title || deck.title || slug,
    slides: deck.slides.length,
    steps: deck.slides.reduce((n, s) => n + (s.steps?.length || 0), 0),
    narrationSec,
    sizeBytes: st.size,
    builtAt: st.mtime.toISOString(),
    standalone: path.basename(html) !== "index.html",
    voice: deck.voice || null,
    model: null,
  };
}

/** Import decks found in `root` itself or in its immediate and second-level
 *  subfolders (skipping node_modules and dot folders). Returns how many were
 *  added or refreshed. */
export function scanFolder(root) {
  const found = [];
  const walk = (dir, depth) => {
    const d = describe(dir);
    if (d) found.push(d);
    if (depth === 0) return;
    let names;
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const n of names)
      if (n.isDirectory() && !n.name.startsWith(".") && n.name !== "node_modules" && n.name !== "steps")
        walk(path.join(dir, n.name), depth - 1);
  };
  walk(path.resolve(root), 2);
  if (!found.length) return 0;
  const known = new Map(readIndex().map((d) => [d.path, d]));
  // A rescan must not erase what the build recorded (model) or the build time.
  for (const d of found) known.set(d.path, { ...d, model: known.get(d.path)?.model ?? d.model });
  writeIndex([...known.values()]);
  return found.length;
}
