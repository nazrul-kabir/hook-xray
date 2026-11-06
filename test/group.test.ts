import { describe, expect, it } from "vitest";
import { baselineScan } from "./baseline.js";
import { groupFindings } from "../src/report/group.js";

const setup = () => {
  const { inv, findings } = baselineScan(false);
  return { inv, findings, g: groupFindings(inv, findings) };
};

describe("groupFindings", () => {
  it("puts every finding in exactly one bucket", () => {
    const { findings, g } = setup();
    const noteCount = g.notes.reduce((n, x) => n + x.hookIds.length, 0);
    expect(g.blocking.length + g.warnings.length + g.modFindings.length + noteCount).toBe(findings.length);
  });

  it("never collapses warnings; notes hold only info", () => {
    const { findings, g } = setup();
    const infoRules = new Set(findings.filter((f) => f.severity === "info" && f.hookId).map((f) => f.rule));
    for (const n of g.notes) expect(infoRules.has(n.rule)).toBe(true);
    for (const f of [...g.blocking, ...g.warnings]) expect(f.hookId).toBeTruthy();
    expect([...g.blocking, ...g.warnings].some((f) => f.severity === "info")).toBe(false);
    expect(g.warnings.some((f) => f.rule === "frequent-context-injection")).toBe(true);
  });

  it("blocking holds never-runs and double-run findings", () => {
    const { g } = setup();
    const rules = new Set(g.blocking.map((f) => f.rule));
    expect(rules.has("dead-if")).toBe(true);
    expect(rules.has("double-run-copy")).toBe(true);
    expect(rules.has("frequent-context-injection")).toBe(false);
  });

  it("collapses the ${CLAUDE_PLUGIN_ROOT} note across owners", () => {
    const { g } = setup();
    const n = g.notes.filter((x) => x.rule === "shell-form-placeholder" && x.message.includes("CLAUDE_PLUGIN_ROOT"));
    expect(n).toHaveLength(1);
    expect(n[0]!.hookIds).toHaveLength(3);
    expect(n[0]!.owners.map((o) => `${o.label} ×${o.count}`).sort()).toEqual(["deploy-tools ×1", "lint-kit ×2"]);
    expect(n[0]!.owners.every((o) => o.plugin)).toBe(true);
  });

  it("orders user config before plugins, and notes by size", () => {
    const { inv, g } = setup();
    const plugin = (id?: string) => inv.hooks.find((h) => h.id === id)?.owner.kind === "plugin";
    for (const list of [g.blocking, g.warnings]) {
      const flags = list.map((f) => plugin(f.hookId));
      expect(flags).toEqual([...flags].sort((a, b) => Number(a) - Number(b)));
    }
    const sizes = g.notes.map((n) => n.hookIds.length);
    expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
  });

  it("is pure", () => {
    const { inv, findings, g } = setup();
    const copy = structuredClone(findings);
    expect(groupFindings(inv, findings)).toEqual(g);
    expect(findings).toEqual(copy);
  });
});
