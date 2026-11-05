import { describe, expect, test } from "claude-code/testing";

// Op stubs take ($, e) like any hook; e is the call's argument.
// What each settings source answers. The flag source mimics a launcher that injects a Stop hook
// while ~/.claude/settings.json is empty (seen in a real cloud workspace).
const SETTINGS: Record<string, Record<string, unknown>> = {
  user: { hooks: { Notification: [{ hooks: [{ type: "command", command: "notify-send hi", timeout: 5 }] }] } },
  project: {},
  local: {},
  flag: {
    hooks: {
      Stop: [{ matcher: "", hooks: [{ type: "command", command: "~/.claude/stop-hook-git-check.sh" }] }],
    },
  },
  policy: {
    allowedHttpHookUrls: ["https://audit.corp.example/*"],
    hooks: {
      PostToolUse: [
        {
          matcher: "Write",
          hooks: [
            {
              type: "http",
              url: "https://elsewhere.example/hook",
              headers: { Authorization: "Bearer sk-live-secret" },
              timeout: 5,
            },
          ],
        },
      ],
      SessionStart: [
        { hooks: [{ type: "mcp_tool", server: "audit", tool: "start", input: { token: "tok-123" }, timeout: 5 }] },
        { hooks: [{ type: "prompt", prompt: "summarise", timeout: 5 }] },
      ],
    },
  },
};

const MERGED = { ...SETTINGS.user, ...SETTINGS.flag, ...SETTINGS.policy };

/** Answers $.settings.read in Claude Code's place, and records which sources were read. */
function answerSettings(on: any, reads: string[] = []) {
  on("settings.read", (_$: any, e: any) => {
    reads.push(e?.source ?? "merged");
    return { value: e?.source ? (SETTINGS[e.source] ?? {}) : MERGED };
  });
  return reads;
}

describe("/hook-xray", () => {
  test("lists flag and policy hooks by default, and counts the ones it leaves out", async ($, on) => {
    answerSettings(on);
    const { text = "" } = await $.command.run({ command: "hook-xray", args: "" });
    expect(text).not.toContain("notify-send");
    expect(text).toContain("Also 1 hook in your settings files (1 user): /hook-xray all lists them.");
    expect(text).toContain("run the hook-xray CLI");
  });

  test("shows the launcher-injected Stop hook and its default-timeout finding", async ($, on) => {
    answerSettings(on);
    const { text = "" } = await $.command.run({ command: "hook-xray", args: "" });
    expect(text).toContain("4 hooks");
    expect(text).toContain("Stop · command · --settings / SDK · default timeout");
    expect(text).toContain("~/.claude/stop-hook-git-check.sh");
    expect(text).toContain("no timeout on Stop (default 600s)");
  });

  test("lints policy hooks: allowlist, unsupported SessionStart handler, mcp_tool may skip", async ($, on) => {
    answerSettings(on);
    const { text = "" } = await $.command.run({ command: "hook-xray", args: "" });
    expect(text).toContain("URL isn't in allowedHttpHookUrls: never runs");
    expect(text).toContain("prompt handler on SessionStart never runs");
    expect(text).toContain("mcp_tool on SessionStart is skipped if its server hasn't connected");
  });

  test("never prints header values, MCP inputs or prompt text", async ($, on) => {
    answerSettings(on);
    const { text = "" } = await $.command.run({ command: "hook-xray", args: "" });
    for (const secret of ["sk-live-secret", "tok-123", "summarise"]) expect(text).not.toContain(secret);
  });

  for (const arg of ["--all", "all", "-all", "ALL"]) {
    test(`"${arg}" also lists user, project and local hooks`, async ($, on) => {
      answerSettings(on);
      const { text = "" } = await $.command.run({ command: "hook-xray", args: arg });
      expect(text).toContain("5 hooks");
      expect(text).toContain("notify-send hi");
      expect(text).not.toContain("Also ");
    });
  }

  test(`"save" without dashes works too`, async ($, on) => {
    answerSettings(on);
    const writes: string[] = [];
    on("fs.write", (_$: any, e: any) => {
      writes.push(e.path);
      return { value: undefined };
    });
    await $.command.run({ command: "hook-xray", args: "all save snap.json" });
    expect(writes.length).toBe(1);
    expect(writes[0].endsWith("snap.json")).toBe(true);
  });

  test("writes nothing without --save", async ($, on) => {
    answerSettings(on);
    const writes: string[] = [];
    on("fs.write", (_$: any, e: any) => {
      writes.push(e.path);
      return { value: undefined };
    });
    await $.command.run({ command: "hook-xray", args: "" });
    expect(writes).toEqual([]);
  });

  test("--save writes a scrubbed snapshot to the named file", async ($, on) => {
    answerSettings(on);
    const writes: { path: string; text: string }[] = [];
    on("fs.write", (_$: any, e: any) => {
      writes.push({ path: e.path, text: e.text });
      return { value: undefined };
    });
    const { text = "" } = await $.command.run({ command: "hook-xray", args: "--save live.json" });
    expect(writes.length).toBe(1);
    // The engine resolves a relative path against the working directory.
    expect(writes[0].path.endsWith("live.json")).toBe(true);
    const snap = JSON.parse(writes[0].text);
    expect(snap.tool).toBe("hook-xray-live");
    expect(snap.hooks.length).toBe(4);
    expect(writes[0].text).not.toContain("sk-live-secret");
    expect(writes[0].text).not.toContain("tok-123");
    expect(text).toContain("hook-xray --live live.json");
  });

  test("explains an empty live view and points to --all", async ($, on) => {
    on("settings.read", () => ({ value: {} }));
    const { text = "" } = await $.command.run({ command: "hook-xray", args: "" });
    expect(text).toContain("No hooks from --settings / SDK or managed policy.");
    expect(text).toContain("That's normal without managed settings");
    expect(text).not.toContain("Also ");
  });

  test("rejects unknown arguments without reading anything", async ($, on) => {
    const reads = answerSettings(on);
    const { text = "" } = await $.command.run({ command: "hook-xray", args: "--delete-all" });
    expect(text).toContain("unknown argument --delete-all");
    expect(reads).toEqual([]);
  });
});
