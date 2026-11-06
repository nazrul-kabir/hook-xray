import { describe, expect, it } from "vitest";
import { baselineScan } from "./baseline.js";
import { buildFixture } from "./fixture.js";
import { discover } from "../src/discover/index.js";
import { lint } from "../src/lint/rules.js";
import { renderTerminal } from "../src/report/terminal.js";
import { summarize } from "../src/report/summary.js";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const render = (allProjects: boolean, o: { redact?: boolean; expand?: boolean; showSources?: boolean } = {}) => {
  const { fx, inv, findings } = baselineScan(allProjects);
  const text = strip(renderTerminal(inv, findings, summarize(inv, findings), { redact: false, showSources: false, version: "test", ...o }));
  return { fx, inv, findings, text };
};

describe("zero-projects hint", () => {
  const header = (projects: string[], allProjects: boolean) => {
    const { inv, findings } = baselineScan(false);
    inv.projects = projects;
    return strip(renderTerminal(inv, findings, summarize(inv, findings), { redact: false, showSources: false, allProjects, version: "test" })).split("\n")[1]!;
  };
  it("explains 0 projects only when --all-projects is off", () => {
    expect(header([], false)).toContain("0 projects  · run in a project folder or add --all-projects");
    expect(header([], true)).not.toContain("--all-projects");
    expect(header(["/x"], false)).not.toContain("--all-projects");
  });
});

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
    // a grouped note and a hook command that name the Windows project too
    const all = lint(inv);
    all.push({ rule: "x", severity: "info", confidence: "certain", hookId: inv.hooks[0]!.id, message: `see ${win}\\x.js`, fix: `edit ${win}` });
    inv.hooks[0]!.handler = { type: "command", command: `${win}\\run.cmd` };
    const text = strip(renderTerminal(inv, all, summarize(inv, findings), { redact: true, showSources: true, version: "test" }));
    expect(text).toContain("…/app");
    for (const leak of [fx.home, fx.project, fx.scratch, fx.broken, fx.odd, win, "Acme Corp", "sk-live-abcdefghijklmnop", "hooks.internal.example.com", "Check the command is safe"]) {
      expect(text).not.toContain(leak);
    }
  });
});

describe("terminal --sources", () => {
  const sources = (o: { expand?: boolean } = {}) => render(true, { showSources: true, ...o });

  it("lists found, unreadable and invalid only; --expand adds missing", () => {
    const { inv, text } = sources();
    const listed = text.slice(text.indexOf("Sources"), text.indexOf("projects checked"));
    const rows = listed.split("\n").filter((l) => /^ {2}[✓✖–] /.test(l)).length;
    expect(rows).toBe(inv.sources.filter((x) => x.status !== "missing").length);
    expect(listed).toContain("[unreadable]");
    expect(listed).toContain("[invalid]");
    expect(listed).not.toContain("[missing]");
    expect(sources({ expand: true }).text).toContain("[missing]");
  });

  it("prints project, plugin and managed summary lines", () => {
    const { inv, text } = sources();
    expect(text).toContain(`${inv.projects.length} projects checked:`);
    expect(text).toMatch(/[1-9]\d* with \.claude config, \d+ without, 1 scratch workspace \(temporary\)/);
    expect(text).toMatch(/\d+ plugins?: \d+ with hooks, \d+ without \(normal\)/);
    expect(text).toMatch(/managed settings: (found|none found)/);
  });

  it("default footer points at --sources and --json", () => {
    expect(render(false).text).toMatch(/\d+ of \d+ sources present · --sources for details · --json for everything/);
  });
});

describe("mods are always visible", () => {
  const clean = () => ({
    ok: true as const,
    report: { success: true, manifest: { notes: [], errors: [], gatingHooks: [] }, contents: [{ type: "hooks", errors: [], notes: ["./register.js hooks: tool.call", "./register.js calls: $.ui.invalidate"], gatingHooks: [] }] },
  });
  const run = (mutate?: (inv: ReturnType<typeof discover>) => void) => {
    const fx = buildFixture();
    const inv = discover({ home: fx.home, cwd: fx.project, managedDir: fx.managedDir, allProjects: false, extraSettings: [fx.flagFile], validator: clean });
    mutate?.(inv);
    const findings = lint(inv);
    return { inv, findings, text: strip(renderTerminal(inv, findings, summarize(inv, findings), { redact: false, showSources: false, version: "test" })) };
  };

  it("lists a mod with no findings, with its hooks and calls", () => {
    const { inv, findings, text } = run();
    expect(inv.mods.length).toBeGreaterThan(0);
    expect(findings.filter((f) => f.modId)).toEqual([]);
    const mods = text.slice(text.indexOf("Mods"), text.indexOf("Notes"));
    expect(mods).toContain(inv.mods[0]!.plugin);
    expect(mods).toContain("tool.call");
    expect(mods).toContain("$.ui.invalidate");
    expect(mods).not.toContain("No mods found.");
  });

  it("says so when there are none", () => {
    expect(run((inv) => (inv.mods = [])).text).toContain("No mods found.");
  });
});
