import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

export type JsonResult = { ok: true; value: unknown } | { ok: false; missing: boolean; error?: string };

export function readJson(path: string): JsonResult {
  if (!existsSync(path)) return { ok: false, missing: true };
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, "utf8")) };
  } catch (e) {
    return { ok: false, missing: false, error: (e as Error).message };
  }
}

export function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function listDir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

export function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** YAML frontmatter of a markdown file, or null when it has none or it doesn't parse. */
export function readFrontmatter(path: string): Record<string, unknown> | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return null;
  try {
    return obj(parseYaml(m[1]));
  } catch {
    return null;
  }
}

/** Every file named `name` under `root`, at most `depth` folders down. Skips dot-folders. */
export function findFiles(root: string, name: string, depth: number): string[] {
  const out: string[] = [];
  const walk = (dir: string, d: number) => {
    for (const entry of listDir(dir)) {
      if (entry.startsWith(".")) continue;
      const p = join(dir, entry);
      if (entry === name && !isDir(p)) out.push(p);
      else if (d > 0 && isDir(p)) walk(p, d - 1);
    }
  };
  walk(root, depth);
  return out.sort();
}

export function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
