import { basename, dirname, join, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { Handler, HooksConfig } from "../schema.js";
import type { GlobalState, HookRecord, Inventory, Owner, ScannedSource, SourceKind, SourceStatus } from "../types.js";
import { findFiles, isDir, listDir, obj, readFrontmatter, readJson } from "./fs.js";
import { discoverMods, type Validator } from "./mods.js";

export interface Env {
  home: string;
  cwd: string;
  /** directory holding managed-settings.json, per OS */
  managedDir: string;
  /** scan every project in ~/.claude.json, not just cwd */
  allProjects: boolean;
  /** extra settings files, treated like Claude Code's --settings flag */
  extraSettings: string[];
  validator: Validator | null;
}

export function defaultManagedDir(platform = process.platform): string {
  if (platform === "darwin") return "/Library/Application Support/ClaudeCode";
  if (platform === "win32") return "C:\\Program Files\\ClaudeCode";
  return "/etc/claude-code";
}

const WORKTREE = /[\\/]\.claude[\\/]worktrees[\\/]/;
export const isScratch = (p: string) => /[\\/]scratch-workspaces[\\/]/i.test(p);

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

export function discover(env: Env): Inventory {
  const inv: Inventory = {
    home: env.home,
    hooks: [],
    mods: [],
    global: { disableAllHooks: null, allowManagedHooksOnly: false, allowedHttpHookUrls: null },
    sources: [],
    projects: [],
    pluginNames: [],
    projectDetails: [],
    parseErrors: [],
  };
  const settingsByLevel: { level: string; value: Record<string, unknown> }[] = [];

  const note = (path: string, kind: ScannedSource["kind"], status: SourceStatus, n?: string) =>
    inv.sources.push({ path, kind, found: status === "found", status, note: n });

  // Adds every handler in a settings-shaped `hooks` object.
  const addHooks = (config: unknown, owner: Owner, file: string, pluginRoot?: string) => {
    const parsed = HooksConfig.safeParse(config);
    if (!parsed.success) {
      inv.parseErrors.push({ file, error: "hooks is not an event -> matcher-group map", kind: "schema" });
      return;
    }
    for (const [event, groups] of Object.entries(parsed.data)) {
      groups.forEach((group) => {
        group.hooks.forEach((raw) => {
          const h = Handler.safeParse(raw);
          if (!h.success) {
            const type = obj(raw).type;
            inv.parseErrors.push({
              file,
              error: `${event}: handler ${type ? `of type "${type}" ` : ""}doesn't match the hooks schema (${h.error.issues[0]?.message})`,
              kind: "schema",
            });
            return;
          }
          const n = inv.hooks.length + 1;
          inv.hooks.push({
            id: `h${n}`,
            event,
            matcher: group.matcher,
            handler: h.data,
            owner,
            file,
            pluginRoot,
            raw,
          });
        });
      });
    }
  };

  const readSettings = (path: string, kind: SourceKind, owner: Owner) => {
    const r = readJson(path);
    note(path, kind, r.ok ? "found" : r.status, r.ok ? undefined : r.error);
    if (!r.ok) {
      if (!r.missing) inv.parseErrors.push({ file: path, error: r.error ?? "unreadable", kind: r.status });
      return null;
    }
    const s = obj(r.value);
    if (s.hooks !== undefined) addHooks(s.hooks, owner, path);
    return s;
  };

  // --- user ---
  const userSettings = readSettings(join(env.home, ".claude", "settings.json"), "user", { kind: "user" });
  if (userSettings) settingsByLevel.push({ level: "user", value: userSettings });

  // --- projects ---
  const claudeJson = readJson(join(env.home, ".claude.json"));
  note(join(env.home, ".claude.json"), "global-config", claudeJson.ok ? "found" : claudeJson.status);
  const projects = new Set<string>([real(env.cwd)]);
  if (env.allProjects && claudeJson.ok) {
    for (const p of Object.keys(obj(obj(claudeJson.value).projects))) {
      if (isDir(p) && !WORKTREE.test(p) && real(p) !== real(env.home)) projects.add(real(p));
    }
  }
  projects.delete(real(env.home));
  inv.projects = [...projects].sort();
  inv.projectDetails = inv.projects.map((path) => ({ path, scratch: isScratch(path) }));
  const cwdReal = real(env.cwd);
  for (const project of inv.projects) {
    if (project === real(env.home)) continue;
    for (const [file, kind] of [
      ["settings.json", "project"],
      ["settings.local.json", "local"],
    ] as const) {
      const s = readSettings(join(project, ".claude", file), kind, { kind, project });
      if (s && project === cwdReal) settingsByLevel.push({ level: kind, value: s });
    }
    scanSkillsAndAgents(join(project, ".claude"), { project }, addHooks, note);
  }

  // --- flag (--settings files) ---
  for (const file of env.extraSettings) {
    const s = readSettings(resolve(file), "flag", { kind: "flag", name: basename(file) });
    if (s) settingsByLevel.push({ level: "flag", value: s });
  }

  // --- managed ---
  const managed: Record<string, unknown>[] = [];
  const mFile = join(env.managedDir, "managed-settings.json");
  const m = readSettings(mFile, "managed", { kind: "managed", name: "managed-settings.json" });
  if (m) managed.push(m);
  const dropIn = join(env.managedDir, "managed-settings.d");
  for (const f of listDir(dropIn).filter((f) => f.endsWith(".json") && !f.startsWith(".")).sort()) {
    const s = readSettings(join(dropIn, f), "managed", { kind: "managed", name: `managed-settings.d/${f}` });
    if (s) managed.push(s);
  }
  if (!isDir(dropIn)) note(dropIn, "managed", "missing");
  note(
    "MDM plist / Windows registry / server-managed settings",
    "note",
    "missing",
    "not readable from disk; the live-view mod reads them through $.settings.read({ source: 'policy' })",
  );
  for (const s of managed) settingsByLevel.push({ level: "managed", value: s });

  // --- user skills/agents ---
  scanSkillsAndAgents(join(env.home, ".claude"), {}, addHooks, note);

  // --- plugins ---
  const enabled = enabledPlugins(settingsByLevel.map((s) => s.value), inv.projects, env.cwd);
  const pluginsFile = join(env.home, ".claude", "plugins", "installed_plugins.json");
  const installed = readJson(pluginsFile);
  note(pluginsFile, "plugin", installed.ok ? "found" : installed.status);
  const pluginDirs: { key: string; root: string; enabled: boolean }[] = [];
  if (installed.ok) {
    const data = obj(obj(installed.value).plugins ?? installed.value);
    for (const [key, entries] of Object.entries(data)) {
      const list = (Array.isArray(entries) ? entries : [entries]).map(obj);
      const usable = list
        .filter((e) => typeof e.installPath === "string" && isDir(e.installPath as string))
        .sort((a, b) => String(b.lastUpdated ?? "").localeCompare(String(a.lastUpdated ?? "")));
      if (usable[0]) pluginDirs.push({ key, root: usable[0].installPath as string, enabled: enabled.has(key) });
    }
  }
  inv.pluginNames = pluginDirs.map((p) => p.key.split("@")[0]!);
  for (const p of pluginDirs) scanPlugin(p.root, p.key, p.enabled, addHooks, note, inv);

  // --- mods ---
  inv.mods = discoverMods(env.home, pluginDirs, env.validator, note);

  inv.global = globalState(settingsByLevel);
  return inv;
}

type AddHooks = (config: unknown, owner: Owner, file: string, pluginRoot?: string) => void;
type Note = (path: string, kind: ScannedSource["kind"], status: SourceStatus, n?: string) => void;

function scanSkillsAndAgents(
  claudeDir: string,
  base: { project?: string; plugin?: string; pluginRoot?: string },
  addHooks: AddHooks,
  note: Note,
) {
  const skillsDir = join(claudeDir, "skills");
  for (const file of findFiles(skillsDir, "SKILL.md", 3)) {
    const fm = readFrontmatter(file);
    if (fm?.hooks === undefined) continue;
    const name = typeof fm.name === "string" ? fm.name : basename(dirname(file));
    addHooks(fm.hooks, { kind: "skill", name: base.plugin ? `${base.plugin}:${name}` : name, project: base.project }, file, base.pluginRoot);
  }
  const agentsDir = join(claudeDir, "agents");
  for (const f of listDir(agentsDir).filter((f) => f.endsWith(".md"))) {
    const file = join(agentsDir, f);
    const fm = readFrontmatter(file);
    if (fm?.hooks === undefined) continue;
    const name = typeof fm.name === "string" ? fm.name : f.replace(/\.md$/, "");
    addHooks(fm.hooks, { kind: "agent", name: base.plugin ? `${base.plugin}:${name}` : name, project: base.project }, file, base.pluginRoot);
  }
  if (!base.plugin) {
    note(skillsDir, "skill", isDir(skillsDir) ? "found" : "missing");
    note(agentsDir, "agent", isDir(agentsDir) ? "found" : "missing");
  }
}

function scanPlugin(root: string, key: string, enabled: boolean, addHooks: AddHooks, note: Note, inv: Inventory) {
  const name = key.split("@")[0];
  const owner: Owner = { kind: "plugin", name: enabled ? name : `${name} (disabled)` };
  const manifestPath = [join(root, ".claude-plugin", "plugin.json"), join(root, "plugin.json")].find(
    (p) => readJson(p).ok,
  );
  const manifest = manifestPath ? obj((readJson(manifestPath) as { value: unknown }).value) : {};

  const hooksFile = join(root, "hooks", "hooks.json");
  const hf = readJson(hooksFile);
  note(hooksFile, "plugin", hf.ok ? "found" : hf.status);
  if (hf.ok && obj(hf.value).hooks !== undefined) addHooks(obj(hf.value).hooks, owner, hooksFile, root);
  if (!hf.ok && !hf.missing) inv.parseErrors.push({ file: hooksFile, error: hf.error ?? "unreadable", kind: hf.status });

  // manifest `hooks`: a path, a list of paths, or inline config
  const field = manifest.hooks;
  const refs = typeof field === "string" ? [field] : Array.isArray(field) ? field : [];
  for (const ref of refs) {
    if (typeof ref !== "string") {
      addInline(ref);
      continue;
    }
    const p = resolve(root, ref);
    if (!p.startsWith(resolve(root))) {
      inv.parseErrors.push({ file: manifestPath ?? root, error: `hooks path ${ref} escapes the plugin root; Claude Code skips it`, kind: "schema" });
      continue;
    }
    if (p === resolve(hooksFile)) continue;
    const r = readJson(p);
    note(p, "plugin", r.ok ? "found" : r.status);
    if (r.ok) addHooks(obj(r.value).hooks ?? r.value, owner, p, root);
  }
  if (field && typeof field === "object" && !Array.isArray(field)) addInline(field);

  function addInline(cfg: unknown) {
    const o = obj(cfg);
    addHooks(o.hooks ?? o, owner, manifestPath ?? root, root);
  }

  scanSkillsAndAgents(root, { plugin: owner.name, pluginRoot: root }, addHooks, note);
}

/** Plugins on in user, cwd project or managed settings (enabledPlugins), or in any scanned project. */
function enabledPlugins(levels: Record<string, unknown>[], projects: string[], cwd: string): Set<string> {
  const on = new Set<string>();
  const apply = (s: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(obj(s.enabledPlugins))) v ? on.add(k) : on.delete(k);
  };
  levels.forEach(apply);
  for (const p of projects) {
    if (real(p) === real(cwd)) continue;
    for (const f of ["settings.json", "settings.local.json"]) {
      const r = readJson(join(p, ".claude", f));
      if (r.ok) for (const [k, v] of Object.entries(obj(obj(r.value).enabledPlugins))) if (v) on.add(k);
    }
  }
  return on;
}

function globalState(levels: { level: string; value: Record<string, unknown> }[]): GlobalState {
  const g: GlobalState = { disableAllHooks: null, allowManagedHooksOnly: false, allowedHttpHookUrls: null };
  for (const { level, value } of levels) {
    if (typeof value.disableAllHooks === "boolean") g.disableAllHooks = { value: value.disableAllHooks, from: level };
    if (level === "managed" && value.allowManagedHooksOnly === true) g.allowManagedHooksOnly = true;
    if (Array.isArray(value.allowedHttpHookUrls)) {
      g.allowedHttpHookUrls = [
        ...(g.allowedHttpHookUrls ?? []),
        ...value.allowedHttpHookUrls.filter((u): u is string => typeof u === "string"),
      ];
    }
  }
  return g;
}
