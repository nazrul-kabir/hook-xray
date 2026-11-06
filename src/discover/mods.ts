import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type { ModRecord, ScannedSource, SourceStatus } from "../types.js";
import { isDir, listDir, obj, readJson } from "./fs.js";

/** Runs `claude plugin validate --json <dir>` and returns its parsed report. Static analysis only: it never runs the module. */
export type Validator = (dir: string) => { ok: true; report: unknown } | { ok: false; reason: string };

export function claudeValidator(bin = "claude", timeoutMs = 20_000): Validator {
  return (dir) => {
    const r = spawnSync(bin, ["plugin", "validate", "--json", dir], { encoding: "utf8", timeout: timeoutMs });
    if (r.error) {
      const code = (r.error as NodeJS.ErrnoException).code;
      return { ok: false, reason: code === "ENOENT" ? "claude CLI not found on PATH" : r.error.message };
    }
    try {
      return { ok: true, report: JSON.parse(r.stdout) };
    } catch {
      return { ok: false, reason: `claude plugin validate gave no JSON (exit ${r.status})` };
    }
  };
}

const NOTE = /^(\S+) (hooks|calls|env reads|env writes|state reads|state writes): (.*)$/;

/** Reads the hooks/calls/env/state notes and gatingHooks out of a validate report, for one plugin dir. */
export function parseValidateReport(report: unknown): ModRecord["validation"] {
  const r = obj(report);
  const out = {
    ok: true as const,
    hooks: [] as string[],
    calls: [] as string[],
    envReads: [] as string[],
    envWrites: [] as string[],
    stateReads: [] as string[],
    stateWrites: [] as string[],
    gatingWithoutCatch: [] as string[],
    errors: [] as string[],
  };
  const keys: Record<string, keyof typeof out> = {
    hooks: "hooks",
    calls: "calls",
    "env reads": "envReads",
    "env writes": "envWrites",
    "state reads": "stateReads",
    "state writes": "stateWrites",
  };
  const entries = [obj(r.manifest), ...(Array.isArray(r.contents) ? r.contents.map(obj) : [])];
  for (const e of entries) {
    for (const n of Array.isArray(e.notes) ? e.notes : []) {
      const m = typeof n === "string" ? NOTE.exec(n) : null;
      if (!m) continue;
      const list = out[keys[m[2]]] as string[];
      list.push(...m[3].split(", ").map((s) => s.trim()).filter((s) => s && !s.startsWith("nothing")));
    }
    for (const g of Array.isArray(e.gatingHooks) ? e.gatingHooks.map(obj) : []) {
      if (g.hasCatch === false && typeof g.hook === "string") out.gatingWithoutCatch.push(g.hook);
    }
    for (const err of Array.isArray(e.errors) ? e.errors : []) {
      out.errors.push(typeof err === "string" ? err : JSON.stringify(err));
    }
  }
  return out;
}

function modulesOf(dir: string): string[] {
  const r = readJson(join(dir, "hooks", "hooks.json"));
  if (!r.ok) return [];
  const m = obj(r.value).modules;
  return Array.isArray(m) ? m.filter((x): x is string => typeof x === "string") : [];
}

function pluginName(dir: string, fallback: string): string {
  for (const p of [join(dir, ".claude-plugin", "plugin.json"), join(dir, "plugin.json")]) {
    const r = readJson(p);
    if (r.ok && typeof obj(r.value).name === "string") return obj(r.value).name as string;
  }
  return fallback;
}

export function discoverMods(
  home: string,
  plugins: { key: string; root: string }[],
  validator: Validator | null,
  note: (path: string, kind: ScannedSource["kind"], status: SourceStatus, n?: string) => void,
): ModRecord[] {
  const candidates: { dir: string; name: string; origin: ModRecord["origin"] }[] = [];
  for (const p of plugins) candidates.push({ dir: p.root, name: p.key.split("@")[0], origin: "plugin" });

  const devMods = join(home, ".claude", "dev-mods");
  note(devMods, "mods", isDir(devMods) ? "found" : "missing");
  for (const session of listDir(devMods)) {
    const sdir = join(devMods, session);
    for (const mod of listDir(sdir)) {
      const dir = join(sdir, mod);
      if (isDir(dir)) candidates.push({ dir, name: pluginName(dir, mod), origin: "session" });
    }
  }

  const mods: ModRecord[] = [];
  for (const c of candidates) {
    const modules = modulesOf(c.dir);
    if (!modules.length) continue;
    let validation: ModRecord["validation"];
    if (!validator) validation = { ok: false, reason: "validation skipped (--no-validate)" };
    else {
      const v = validator(c.dir);
      validation = v.ok ? parseValidateReport(v.report) : { ok: false, reason: v.reason };
    }
    mods.push({ id: `m${mods.length + 1}`, plugin: c.name, dir: c.dir, modules, origin: c.origin, validation });
  }
  return mods;
}
