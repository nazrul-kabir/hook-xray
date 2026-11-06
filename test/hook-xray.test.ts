import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { baselineScan, normalized } from "./baseline.js";
import { join } from "node:path";
import { addLiveSnapshot } from "../src/discover/live.js";
import { discover, isScratch, type Env } from "../src/discover/index.js";
import { parseValidateReport } from "../src/discover/mods.js";
import { lint, _test } from "../src/lint/rules.js";
import { renderJson } from "../src/report/json.js";
import { redactText, redactUrl } from "../src/report/redact.js";
import { summarize } from "../src/report/summary.js";
import { buildFixture, fakeValidator } from "./fixture.js";

function scan(opts: { disableAllHooks?: boolean } = {}) {
  const fx = buildFixture(opts);
  const env: Env = {
    home: fx.home,
    cwd: fx.project,
    managedDir: fx.managedDir,
    allProjects: false,
    extraSettings: [fx.flagFile],
    validator: fakeValidator,
  };
  const inv = discover(env);
  return { fx, inv, findings: lint(inv) };
}

const hook = (inv: ReturnType<typeof scan>["inv"], pred: (h: (typeof inv.hooks)[number]) => boolean) => {
  const h = inv.hooks.find(pred);
  if (!h) throw new Error("hook not found");
  return h;
};
const rulesFor = (findings: ReturnType<typeof scan>["findings"], id: string) =>
  findings.filter((f) => f.hookId === id).map((f) => f.rule).sort();

describe("discovery", () => {
  it("finds hooks from every JSON source with the right owner", () => {
    const { inv } = scan();
    const kinds = new Set(inv.hooks.map((h) => h.owner.kind));
    expect([...kinds].sort()).toEqual(["flag", "managed", "plugin", "project", "skill", "user"]);
    expect(inv.parseErrors).toEqual([]);
  });

  it("attributes plugin hooks to the plugin, including manifest-referenced files", () => {
    const { inv } = scan();
    const plugin = inv.hooks.filter((h) => h.owner.kind === "plugin" && h.owner.name === "deploy-tools");
    expect(plugin.map((h) => h.event).sort()).toEqual(["Notification", "PreToolUse", "SessionStart"]);
    expect(new Set(plugin.map((h) => h.owner.name))).toEqual(new Set(["deploy-tools"]));
  });

  it("reads skill frontmatter hooks", () => {
    const { inv } = scan();
    const s = hook(inv, (h) => h.owner.kind === "skill");
    expect(s.owner.name).toBe("doc-sync");
    expect(s.event).toBe("PostToolUse");
  });

  it("finds plugin and session mods, and reports unvalidated ones honestly", () => {
    const { inv } = scan();
    expect(inv.mods.map((m) => `${m.plugin}:${m.origin}`).sort()).toEqual(["deploy-tools:plugin", "git-branch:session"]);
    const session = inv.mods.find((m) => m.origin === "session")!;
    expect(session.validation.ok).toBe(false);
  });

  it("reads global state", () => {
    const { inv } = scan();
    expect(inv.global.allowedHttpHookUrls).toEqual(["https://allowed.example.com/*"]);
    expect(inv.global.disableAllHooks).toBeNull();
  });
});

describe("lint rules", () => {
  const { inv, findings } = scan();

  it("dead if on a non-tool event", () => {
    const h = hook(inv, (h) => h.event === "SessionStart" && h.handler.type === "command");
    expect(rulesFor(findings, h.id)).toContain("dead-if");
  });

  it("unsupported handler type on SessionStart", () => {
    const h = hook(inv, (h) => h.event === "SessionStart" && h.handler.type === "http");
    expect(rulesFor(findings, h.id)).toEqual(["session-start-unsupported-handler"]);
  });

  it("mcp_tool on SessionStart may be skipped: info, likely, not 'never runs'", () => {
    const h = hook(inv, (h) => h.event === "SessionStart" && h.handler.type === "mcp_tool");
    const fs = findings.filter((f) => f.hookId === h.id);
    expect(fs.map((f) => f.rule)).toEqual(["session-start-mcp-tool-may-skip"]);
    expect(fs[0]).toMatchObject({ severity: "info", confidence: "likely" });
    expect(summarize(inv, findings).lines.join("\n")).not.toContain("mcp_tool");
  });

  it("prompt and agent handlers on SessionStart never run; http on Setup never runs; command on Setup is fine", () => {
    for (const [event, type] of [["SessionStart", "prompt"], ["SessionStart", "agent"], ["Setup", "http"]]) {
      const h = hook(inv, (x) => x.event === event && x.handler.type === type);
      expect(rulesFor(findings, h.id)).toEqual(["session-start-unsupported-handler"]);
    }
    const ok = hook(inv, (x) => x.event === "Setup" && x.handler.type === "command");
    expect(rulesFor(findings, ok.id)).toEqual([]);
  });

  it("unanchored regex, shell-form placeholder and default timeout on PreToolUse", () => {
    const h = hook(inv, (h) => h.matcher === "Edit.*");
    expect(rulesFor(findings, h.id)).toEqual(["default-timeout-on-blocking-event", "shell-form-placeholder", "unanchored-regex-matcher"]);
  });

  it("anchored regex is fine", () => {
    const h = hook(inv, (h) => h.matcher === "^Bash$");
    expect(rulesFor(findings, h.id)).toEqual([]);
  });

  it("broad matcher on a tool event", () => {
    const h = hook(inv, (h) => h.event === "PreToolUse" && h.matcher === undefined);
    expect(rulesFor(findings, h.id)).toEqual(["broad-matcher"]);
  });

  it("UserPromptSubmit output reaches context on every prompt, and its lowered 30s default isn't flagged", () => {
    const h = hook(inv, (h) => h.event === "UserPromptSubmit");
    expect(rulesFor(findings, h.id)).toEqual(["frequent-context-injection"]);
  });

  it("script-derived findings are likely, not certain", () => {
    const h = hook(inv, (h) => h.owner.kind === "skill");
    const fs = findings.filter((f) => f.hookId === h.id);
    expect(fs.map((f) => f.rule).sort()).toEqual(["frequent-context-injection", "suppress-output-ignored"]);
    expect(fs.every((f) => f.confidence === "likely")).toBe(true);
  });

  it("http hook outside the allowlist never runs", () => {
    const h = hook(inv, (h) => h.event === "PostToolUse" && h.handler.type === "http");
    expect(rulesFor(findings, h.id)).toEqual(["http-url-not-allowlisted"]);
  });

  it("plugin copy of a settings handler runs twice", () => {
    const h = hook(inv, (h) => h.event === "Notification" && h.owner.kind === "plugin");
    expect(rulesFor(findings, h.id)).toEqual(["double-run-copy"]);
  });

  it("Stop hook from --settings without timeout is flagged; with timeout it isn't", () => {
    const flag = hook(inv, (h) => h.event === "Stop" && h.owner.kind === "flag");
    const user = hook(inv, (h) => h.event === "Stop" && h.owner.kind === "user");
    expect(rulesFor(findings, flag.id)).toEqual(["default-timeout-on-blocking-event"]);
    expect(rulesFor(findings, user.id)).toEqual([]);
  });

  it("mod gating hook without .catch", () => {
    expect(findings.some((f) => f.rule === "mod-gating-without-catch")).toBe(true);
    expect(findings.some((f) => f.rule === "mod-unvalidated")).toBe(true);
  });

  it("disableAllHooks leaves only managed hooks linted", () => {
    const off = scan({ disableAllHooks: true });
    const ids = new Set(off.inv.hooks.filter((h) => h.owner.kind === "managed").map((h) => h.id));
    expect(off.findings.filter((f) => f.hookId).every((f) => ids.has(f.hookId!))).toBe(true);
  });
});

describe("source status", () => {
  it("tells missing, unreadable, invalid and found apart", () => {
    const { fx, inv } = scan();
    const status = (p: string) => inv.sources.find((s) => s.path === p)?.status;
    const allInv = discover({
      home: fx.home, cwd: fx.project, managedDir: fx.managedDir, allProjects: true,
      extraSettings: [fx.flagFile], validator: fakeValidator,
    });
    const st = (p: string) => allInv.sources.find((s) => s.path === p)?.status;
    expect(status(join(fx.home, ".claude", "settings.json"))).toBe("found");
    expect(status(join(fx.project, ".claude", "settings.local.json"))).toBe("missing");
    expect(st(join(fx.broken, ".claude", "settings.json"))).toBe("invalid");
    expect(st(join(fx.odd, ".claude", "settings.json"))).toBe("unreadable");
    const kinds = Object.fromEntries(allInv.parseErrors.map((e) => [e.file, e.kind]));
    expect(kinds[join(fx.broken, ".claude", "settings.json")]).toBe("invalid");
    expect(kinds[join(fx.odd, ".claude", "settings.json")]).toBe("unreadable");
    expect(allInv.sources.every((s) => s.found === (s.status === "found"))).toBe(true);
  });
});

describe("project labels", () => {
  const all = (fx: ReturnType<typeof buildFixture>) =>
    discover({ home: fx.home, cwd: fx.project, managedDir: fx.managedDir, allProjects: true, extraSettings: [fx.flagFile], validator: fakeValidator });

  it("keeps scratch workspaces, labelled, and doesn't change the project count", () => {
    const fx = buildFixture();
    const inv = all(fx);
    const scratchPath = inv.projects.find((p) => p.includes("scratch-workspaces"))!;
    expect(scratchPath).toBeDefined();
    expect(inv.projectDetails.map((d) => d.path)).toEqual(inv.projects);
    expect(inv.projectDetails.filter((d) => d.scratch).map((d) => d.path)).toEqual([scratchPath]);
  });

  it("skips .claude/worktrees with either path separator", () => {
    const fx = buildFixture();
    const inv = all(fx);
    expect(inv.projects.some((p) => /worktrees/.test(p))).toBe(false);
    expect(inv.hooks.some((h) => h.file.includes("worktrees"))).toBe(false);
    expect(isScratch("C:\\Users\\a\\Claude-Data\\x\\scratch-workspaces\\y")).toBe(true);
    expect(isScratch("/home/a/scratch-workspaces/y")).toBe(true);
    expect(isScratch("/home/a/work/app")).toBe(false);
  });
});

describe("mods report parsing", () => {
  it("parses validate notes and gating hooks", () => {
    const v = parseValidateReport((fakeValidator("/x") as { report: unknown }).report);
    expect(v).toMatchObject({
      ok: true,
      hooks: ["tool.call", "session.start"],
      calls: ["$.ui.invalidate", "$.command.register"],
      envReads: ["DEPLOY_TOKEN"],
      gatingWithoutCatch: ["tool.call"],
    });
  });
});

describe("redaction", () => {
  it("hides hosts, queries and tokens", () => {
    expect(redactUrl("https://hooks.internal.example.com/audit?team=core")).toBe("https://<host>/audit?<query>");
    expect(redactText("curl -H 'Authorization: Bearer abc.def' https://x.io/y API_TOKEN=s3cret")).toBe(
      "curl -H 'Authorization: Bearer <redacted>' https://<host>/y API_TOKEN=<redacted>",
    );
  });

  it("--json --redact leaks no secret, host or home path", () => {
    const { fx, inv, findings } = scan();
    const text = renderJson(inv, findings, summarize(inv, findings), "test", true);
    for (const leak of ["sk-live-abcdefghijklmnop", "hooks.internal.example.com", "team=core", fx.home, fx.project, "Check the command is safe"]) {
      expect(text).not.toContain(leak);
    }
  });
});

describe("allowlist matching", () => {
  it("supports * wildcards", () => {
    expect(_test.urlAllowed("https://allowed.example.com/start", ["https://allowed.example.com/*"])).toBe(true);
    expect(_test.urlAllowed("https://evil.example.com/start", ["https://allowed.example.com/*"])).toBe(false);
  });
});

describe("--live snapshot from the hook-xray-live mod", () => {
  it("reads the mod's snapshot format and lints it with the full rule set", async () => {
    // Build the snapshot with the mod's own code, so a format change on either side fails here.
    const { buildReport } = await import("../mods/hook-xray-live/hooks/lint.js");
    const snap = buildReport(
      [
        { source: "flag", settings: { hooks: { Stop: [{ hooks: [{ type: "command", command: "~/.claude/stop-hook-git-check.sh" }] }] } } },
        { source: "policy", settings: { hooks: { SessionStart: [{ hooks: [{ type: "agent", prompt: "check", timeout: 5 }] }] } } },
      ],
      {},
      "test",
    );
    const { fx, inv } = scan();
    const file = join(fx.root, "live.json");
    writeFileSync(file, JSON.stringify(snap));
    const before = inv.hooks.length;
    addLiveSnapshot(inv, file);
    const live = inv.hooks.slice(before);
    expect(live.map((h) => [h.event, h.owner.kind, h.owner.name])).toEqual([
      ["Stop", "flag", "live: --settings / SDK"],
      ["SessionStart", "managed", "live: managed policy"],
    ]);
    const rules = lint(inv).filter((f) => live.some((h) => h.id === f.hookId)).map((f) => f.rule).sort();
    expect(rules).toEqual(["default-timeout-on-blocking-event", "session-start-unsupported-handler"]);
  });

  it("reports a file that isn't a snapshot instead of guessing", () => {
    const { fx, inv } = scan();
    const file = join(fx.root, "nope.json");
    writeFileSync(file, "{}");
    addLiveSnapshot(inv, file);
    expect(inv.parseErrors.at(-1)?.error).toBe("not a hook-xray-live snapshot");
  });
});

describe("findings baseline (presentation changes must not change analysis)", () => {
  it("matches test/findings.baseline.json for this project and for --all-projects", () => {
    const expected = JSON.parse(readFileSync(new URL("./findings.baseline.json", import.meta.url), "utf8"));
    for (const [key, all] of [["cwdOnly", false], ["allProjects", true]] as const) {
      const { inv, findings } = baselineScan(all);
      expect(normalized(inv, findings)).toEqual(expected[key]);
    }
  });

  it("hooks of a disabled plugin stay in the inventory but get no findings", () => {
    const { inv, findings } = baselineScan(false);
    const off = inv.hooks.filter((h) => h.owner.name === "off-kit (disabled)");
    expect(off).toHaveLength(1);
    expect(findings.some((f) => f.hookId === off[0]!.id)).toBe(false);
    expect(summarize(inv, findings).lines.join("\n")).not.toContain("off-kit");
  });

  it("disableAllHooks in managed settings: no hook is linted, managed ones included", () => {
    const expected = JSON.parse(readFileSync(new URL("./findings.baseline.json", import.meta.url), "utf8"));
    const { inv, findings } = baselineScan(true, { managedDisableAllHooks: true });
    expect(inv.global.disableAllHooks).toEqual({ value: true, from: "managed" });
    expect(findings.some((f) => f.hookId)).toBe(false);
    expect(normalized(inv, findings)).toEqual(expected.managedDisableAllHooks);
  });
});
