import { describe, expect, it } from "vitest";
import { baselineScan } from "./baseline.js";
import { lint } from "../src/lint/rules.js";
import { renderTerminal } from "../src/report/terminal.js";
import { summarize } from "../src/report/summary.js";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const render = (allProjects: boolean, o: { redact?: boolean; expand?: boolean; showSources?: boolean } = {}) => {
  const { fx, inv, findings } = baselineScan(allProjects);
  const text = strip(renderTerminal(inv, findings, summarize(inv, findings), { redact: false, showSources: false, version: "test", ...o }));
  return { fx, inv, findings, text };
};

describe("terminal layout", () => {
  it("shows sections in order, with warnings on their own lines", () => {
    const { findings, text } = render(false);
    const at = (s: string) => text.indexOf(s);
    expect(at("Never runs or runs twice")).toBeGreaterThan(-1);
    expect(at("Never runs or runs twice")).toBeLessThan(at("Warnings"));
    expect(at("Warnings")).toBeLessThan(at("Mods"));
    expect(at("Mods")).toBeLessThan(at("Notes"));
    expect(at("Notes")).toBeLessThan(at("Hooks by owner"));
    const notes = text.slice(at("Notes"), at("Hooks by owner"));
    for (const f of findings.filter((f) => f.hookId && f.severity !== "info")) {
      expect(text).toContain(f.message);
      expect(notes).not.toContain(f.message);
    }
  });

  it("collapses repeated notes; --expand lists every hook behind them", () => {
    const { text } = render(false);
    expect(text).toContain("3 hooks: lint-kit ×2, deploy-tools ×1");
    const { inv, findings } = baselineScan(false);
    const expanded = strip(renderTerminal(inv, findings, summarize(inv, findings), { redact: false, showSources: false, expand: true, version: "test" }));
    const notes = expanded.slice(expanded.indexOf("Notes"), expanded.indexOf("Hooks by owner"));
    for (const f of findings.filter((f) => f.rule === "shell-form-placeholder")) expect(notes).toContain(f.hookId!.padEnd(4));
  });

  it("plugin warnings carry the disable line; plugin notes don't", () => {
    const { text } = render(false);
    expect(text).toContain("disable the plugin if the behavior is unwanted");
    const notes = text.slice(text.indexOf("Notes"), text.indexOf("Hooks by owner"));
    expect(notes).not.toContain("disable the plugin");
    expect(notes).toContain("Plugin-owned");
  });

  it("splits unreadable from invalid and labels scratch", () => {
    const { text } = render(true);
    expect(text).toMatch(/unreadable\s+\S*odd/);
    expect(text).toMatch(/invalid JSON\s+\S*broken/);
    expect(text).toContain("(1 scratch)");
  });
});

describe("terminal --redact", () => {
  it("leaks no project path, with POSIX or Windows separators", () => {
    const { fx, inv, findings } = baselineScan(true);
    const win = "C:\\Clients\\Acme Corp\\app";
    inv.projects.push(win);
    inv.parseErrors.push({ file: `${win}\\.claude\\settings.json`, error: "bad", kind: "invalid" });
    inv.sources.push({ path: `${win}\\.claude\\settings.json`, kind: "project", found: false, status: "missing" });
    const text = strip(renderTerminal(inv, lint(inv), summarize(inv, findings), { redact: true, showSources: true, version: "test" }));
    for (const leak of [fx.home, fx.project, fx.scratch, fx.broken, fx.odd, win, "Acme Corp", "sk-live-abcdefghijklmnop", "hooks.internal.example.com", "Check the command is safe"]) {
      expect(text).not.toContain(leak);
    }
  });
});
