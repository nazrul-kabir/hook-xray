import { describe, expect, it } from "vitest";
import { baselineScan } from "./baseline.js";
import { lint } from "../src/lint/rules.js";
import { renderJson } from "../src/report/json.js";
import { summarize } from "../src/report/summary.js";

const report = (allProjects: boolean, redact: boolean, tweak?: (inv: ReturnType<typeof baselineScan>["inv"]) => void) => {
  const { fx, inv } = baselineScan(allProjects);
  tweak?.(inv);
  const findings = lint(inv);
  tweak && inv.hooks.length && findings.push({ rule: "x", severity: "info", confidence: "certain", hookId: inv.hooks[0]!.id, message: "at C:\\Clients\\Acme Corp\\app\\x.js" });
  return { fx, inv, findings, json: JSON.parse(renderJson(inv, findings, summarize(inv, findings), "test", redact)) as Record<string, any> };
};

/** Every string in a parsed JSON value, so backslash paths are compared unescaped. */
const strings = (v: unknown): string[] =>
  typeof v === "string" ? [v] : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === "object" ? Object.values(v).flatMap(strings) : [];

describe("json report", () => {
  it("keeps every alpha top-level key and adds the new ones", () => {
    const { json } = report(true, false);
    for (const [k, t] of Object.entries({
      tool: "string", version: "string", redacted: "boolean", summary: "object", global: "object", projects: "object",
      hooks: "object", mods: "object", findings: "object", sources: "object", parseErrors: "object",
    })) expect(typeof json[k], k).toBe(t);
    expect(json.version).toBe("test");
    expect(json.projectDetails.filter((d: any) => d.scratch)).toHaveLength(1);
    expect(json.sources.every((s: any) => typeof s.status === "string")).toBe(true);
    expect(json.parseErrors.map((e: any) => e.kind).sort()).toEqual(["invalid", "unreadable"]);
  });

  it("groups carry hook ids and match the notes", () => {
    const { json } = report(false, false);
    const g = json.groups.find((x: any) => x.rule === "shell-form-placeholder" && x.message.includes("CLAUDE_PLUGIN_ROOT"));
    expect(g.hookIds).toHaveLength(3);
    expect(g.owners.map((o: any) => `${o.label} ×${o.count}`).sort()).toEqual(["deploy-tools ×1", "lint-kit ×2"]);
  });

  it("--redact leaks no project path, with POSIX or Windows separators", () => {
    const win = "C:\\Clients\\Acme Corp\\app";
    const { fx, json } = report(true, true, (inv) => {
      inv.projects.push(win);
      inv.projectDetails.push({ path: win, scratch: false });
      inv.parseErrors.push({ file: `${win}\\.claude\\settings.json`, error: `cannot read ${win}`, kind: "invalid" });
      inv.sources.push({ path: `${win}\\.claude\\settings.json`, kind: "project", found: false, status: "missing" });
      inv.hooks[0]!.file = `${win}\\.claude\\settings.json`;
      inv.hooks[0]!.raw = { type: "command", command: `${win}\\run.cmd`, env: { A: "sk-live-abcdefghijklmnop" } };
    });
    const all = strings(json);
    for (const leak of [fx.home, fx.project, fx.scratch, fx.broken, fx.odd, win, "Acme Corp", "sk-live-abcdefghijklmnop", "hooks.internal.example.com", "Check the command is safe"]) {
      expect(all.filter((s) => s.includes(leak)), leak).toEqual([]);
    }
    expect(json.groups.some((g: any) => g.message.includes("…/app"))).toBe(true);
  });
});
