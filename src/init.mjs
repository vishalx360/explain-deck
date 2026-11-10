/**
 * Install the explain skill for every coding agent on this machine.
 *
 *   explain-deck init [--agent claude-code,codex,...]
 *
 * SKILL.md is written once to ~/.agents/skills/explain, the shared folder that
 * Codex, Cline and others read directly. Agents with their own folder get a
 * symlink to it, so there is one copy to update. The folder layout matches the
 * `skills` CLI (npx skills add), so the two installers never fight.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NAME = "explain";

const home = os.homedir();
const config = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
const claude = process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(home, ".claude");
const codex = process.env.CODEX_HOME?.trim() || path.join(home, ".codex");
const SHARED = path.join(home, ".agents", "skills");

// [skills folder, folder whose existence means the agent is installed]
const AGENTS = {
  "claude-code": [path.join(claude, "skills"), claude],
  codex: [path.join(codex, "skills"), codex],
  cursor: [path.join(home, ".cursor", "skills"), path.join(home, ".cursor")],
  "gemini-cli": [path.join(home, ".gemini", "skills"), path.join(home, ".gemini")],
  "github-copilot": [path.join(home, ".copilot", "skills"), path.join(home, ".copilot")],
  opencode: [path.join(config, "opencode", "skills"), path.join(config, "opencode")],
  windsurf: [path.join(home, ".codeium", "windsurf", "skills"), path.join(home, ".codeium", "windsurf")],
  amp: [path.join(config, "agents", "skills"), path.join(config, "amp")],
};

/** Move aside anything at `p` that isn't already what we want, rather than
 *  deleting it: it may be an older hand-edited install. A folder holding only
 *  SKILL.md is one we wrote, and is simply overwritten. */
function clear(p, keepIfLinksTo) {
  let st;
  try { st = fs.lstatSync(p); } catch { return; }
  if (st.isSymbolicLink()) {
    if (keepIfLinksTo && path.resolve(path.dirname(p), fs.readlinkSync(p)) === keepIfLinksTo) return "kept";
    fs.unlinkSync(p);
    return;
  }
  if (st.isDirectory() && fs.readdirSync(p).every((f) => f === "SKILL.md")) return "kept";
  const backup = `${p}.bak-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}`;
  fs.renameSync(p, backup);
  console.log(`  moved the existing ${p} to ${backup}`);
}

const SHIM_MARK = "# explain-deck shim";

/** A launcher on PATH so `explain-deck model` works without typing npx. It
 *  forwards to the published CLI rather than copying it, so it never goes stale. */
function installShim() {
  const dir = path.join(home, ".local", "bin");
  const file = path.join(dir, "explain-deck");
  if (fs.existsSync(file) && !fs.readFileSync(file, "utf8").includes(SHIM_MARK)) {
    console.log(`skipped    ${file} (already exists and is not ours)`);
    return;
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\n${SHIM_MARK}\nexec npx -y explain-deck@1 "$@"\n`, { mode: 0o755 });
  console.log(`installed  ${file}  (run: explain-deck model)`);
  if (!(process.env.PATH || "").split(path.delimiter).includes(dir))
    console.log(`           ${dir} is not on your PATH; add it to your shell profile.`);
}

export function init(argv) {
  const i = argv.indexOf("--agent");
  const only = i >= 0 ? argv[i + 1]?.split(",") : null;
  if (only) for (const a of only)
    if (!(a in AGENTS)) {
      console.error(`explain-deck: unknown agent "${a}". Known: ${Object.keys(AGENTS).join(", ")}`);
      process.exit(1);
    }

  const canonical = path.join(SHARED, NAME);
  clear(canonical);
  fs.mkdirSync(canonical, { recursive: true });
  fs.copyFileSync(path.join(HERE, "..", "skill", "SKILL.md"), path.join(canonical, "SKILL.md"));
  console.log(`installed  ${canonical}`);

  const picked = Object.entries(AGENTS).filter(([name, [, marker]]) =>
    only ? only.includes(name) : fs.existsSync(marker));
  for (const [name, [dir]] of picked) {
    if (path.resolve(dir) === SHARED) continue;
    const link = path.join(dir, NAME);
    fs.mkdirSync(dir, { recursive: true });
    if (clear(link, canonical) !== "kept") fs.symlinkSync(canonical, link, "dir");
    console.log(`linked     ${link}  (${name})`);
  }

  installShim();

  console.log("\nRestart your agent so it picks up the skill, then ask it to explain something.");
  console.log("The first build downloads the speech model once; after that it runs offline.");
}
