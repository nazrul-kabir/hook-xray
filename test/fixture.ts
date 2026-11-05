import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Validator } from "../src/discover/mods.js";

function write(path: string, content: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content, null, 2));
}

/**
 * A fake machine with one of everything: user, project, managed and --settings hooks, a plugin with
 * hooks.json, a manifest-referenced hooks file and a mod, a skill with frontmatter hooks, and a session mod.
 * Every rule fires at least once. Nothing here is ever executed.
 */
export function buildFixture(opts: { disableAllHooks?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "hook-xray-"));
  const home = join(root, "home");
  const project = join(root, "work", "app");
  const managedDir = join(root, "managed");
  const plugin = join(home, ".claude", "plugins", "cache", "acme", "deploy-tools", "1.2.0");

  write(join(home, ".claude", "settings.json"), {
    enabledPlugins: { "deploy-tools@acme": true, "lint-kit@acme": true },
    allowedHttpHookUrls: ["https://allowed.example.com/*"],
    ...(opts.disableAllHooks ? { disableAllHooks: true } : {}),
    hooks: {
      SessionStart: [
        { matcher: "startup", hooks: [{ type: "command", command: "echo hi", if: "Bash(git *)", timeout: 5 }] },
        { matcher: "startup", hooks: [{ type: "http", url: "https://allowed.example.com/start", timeout: 5 }] },
        { matcher: "startup", hooks: [{ type: "prompt", prompt: "Summarise the repo", timeout: 5 }] },
        { matcher: "resume", hooks: [{ type: "agent", prompt: "Check the branch", timeout: 5 }] },
      ],
      Setup: [
        { matcher: "init", hooks: [{ type: "http", url: "https://allowed.example.com/setup", timeout: 5 }] },
        { matcher: "init", hooks: [{ type: "command", command: "npm ci", timeout: 120 }] },
      ],
      PreToolUse: [
        { matcher: "Edit.*", hooks: [{ type: "command", command: "${CLAUDE_PROJECT_DIR}/scripts/lint.sh" }] },
        { hooks: [{ type: "command", command: "node", args: ["guard.js"], timeout: 3 }] },
      ],
      UserPromptSubmit: [{ hooks: [{ type: "command", command: "git branch --show-current" }] }],
      PostToolUse: [
        {
          matcher: "Write",
          hooks: [
            {
              type: "http",
              url: "https://hooks.internal.example.com/audit?team=core",
              headers: { Authorization: "Bearer sk-live-abcdefghijklmnop" },
              timeout: 10,
            },
          ],
        },
      ],
      Notification: [{ hooks: [{ type: "command", command: "notify-send Claude" }] }],
      Stop: [{ hooks: [{ type: "command", command: "~/.claude/stop-check.sh", timeout: 30 }] }],
    },
  });

  // Filled in below, once every project folder exists.
  const projects: string[] = [project];

  write(join(project, ".claude", "settings.json"), {
    hooks: {
      PermissionRequest: [{ matcher: "^Bash$", hooks: [{ type: "agent", prompt: "Check the command is safe" }] }],
    },
  });
  write(join(project, "scripts", "lint.sh"), "#!/bin/sh\nnpx -y eslint .\n");

  // A skill whose hook script returns additionalContext and suppressOutput.
  write(
    join(home, ".claude", "skills", "doc-sync", "SKILL.md"),
    `---
name: doc-sync
description: Keep docs in sync
hooks:
  PostToolUse:
    - matcher: "Write|Edit"
      hooks:
        - type: command
          command: python3
          args: ["${home}/.claude/skills/doc-sync/hook.py"]
          timeout: 5
---
# Doc sync
`,
  );
  write(
    join(home, ".claude", "skills", "doc-sync", "hook.py"),
    `import json\nprint(json.dumps({"suppressOutput": True, "hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": "docs changed"}}))\n`,
  );

  // Plugin: hooks.json (with a mod), plus a hooks file referenced from the manifest.
  write(join(home, ".claude", "plugins", "installed_plugins.json"), {
    version: 2,
    plugins: {
      "deploy-tools@acme": [{ scope: "user", installPath: plugin, version: "1.2.0", lastUpdated: "2026-11-01" }],
      "lint-kit@acme": [{ scope: "user", installPath: join(home, ".claude", "plugins", "cache", "acme", "lint-kit", "0.4.0"), version: "0.4.0", lastUpdated: "2026-11-01" }],
    },
  });
  write(join(plugin, ".claude-plugin", "plugin.json"), { name: "deploy-tools", version: "1.2.0", hooks: "./config/extra-hooks.json" });
  write(join(plugin, "hooks", "hooks.json"), {
    modules: ["./register.js"],
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/scripts/check.sh", timeout: 5 }] }],
      Notification: [{ hooks: [{ type: "command", command: "notify-send Claude" }] }],
    },
  });
  write(join(plugin, "hooks", "register.js"), "export function register(on) { on('tool.call', async ($, e, next) => next(e)) }\n");
  write(join(plugin, "config", "extra-hooks.json"), {
    hooks: { SessionStart: [{ hooks: [{ type: "mcp_tool", server: "deploy", tool: "warmup", timeout: 5 }] }] },
  });

  // A second plugin with the same shell-form note as deploy-tools, so the note repeats across owners.
  const lintKit = join(home, ".claude", "plugins", "cache", "acme", "lint-kit", "0.4.0");
  write(join(lintKit, ".claude-plugin", "plugin.json"), { name: "lint-kit", version: "0.4.0" });
  write(join(lintKit, "hooks", "hooks.json"), {
    hooks: {
      SubagentStart: [{ hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/sub.js"', timeout: 5 }] }],
      PostToolUseFailure: [{ matcher: "Bash", hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/fail.js"', timeout: 5 }] }],
    },
  });

  // Projects only --all-projects reaches: a Claude desktop scratch workspace, one with invalid JSON,
  // and one whose settings path can't be read as a file.
  const scratch = join(root, "AppData", "Local", "Claude-Data", "claude_x", "scratch-workspaces", "a1", "b2", "scratch-2026-10-25-69cd4e");
  write(join(scratch, ".claude", "settings.local.json"), { permissions: { allow: [] } });
  const broken = join(root, "work", "broken");
  write(join(broken, ".claude", "settings.json"), "{ not json");
  const odd = join(root, "work", "odd");
  mkdirSync(join(odd, ".claude", "settings.json"), { recursive: true });

  // A session mod Claude wrote.
  const devMod = join(home, ".claude", "dev-mods", "3f2a9c1e", "git-branch");
  write(join(devMod, ".claude-plugin", "plugin.json"), { name: "git-branch", version: "0.1.0" });
  write(join(devMod, "hooks", "hooks.json"), { modules: ["./register.js"] });
  write(join(devMod, "hooks", "register.js"), "export function register(on) {}\n");

  // Managed policy and a --settings file.
  write(join(managedDir, "managed-settings.json"), {
    hooks: { SessionEnd: [{ hooks: [{ type: "command", command: "/usr/local/bin/audit-log" }] }] },
  });
  const flagFile = join(root, "launcher-settings.json");
  write(flagFile, { hooks: { Stop: [{ hooks: [{ type: "command", command: "~/.claude/stop-hook-git-check.sh" }] }] } });

  projects.push(scratch, broken, odd);
  write(join(home, ".claude.json"), { projects: Object.fromEntries(projects.map((p) => [p, {}])) });

  return { root, home, project, managedDir, plugin, devMod, flagFile, scratch, broken, odd };
}

/** Stands in for `claude plugin validate --json`, using the report shape Claude Code 2.1.318 prints. */
export const fakeValidator: Validator = (dir) => {
  if (dir.includes("dev-mods")) return { ok: false, reason: "claude CLI not found on PATH" };
  return {
    ok: true,
    report: {
      success: true,
      manifest: { notes: [], errors: [], gatingHooks: [] },
      contents: [
        {
          type: "hooks",
          errors: [],
          notes: [
            "./register.js hooks: tool.call, session.start",
            "./register.js gating hook without .catch: tool.call",
            "./register.js calls: $.ui.invalidate, $.command.register",
            "./register.js env reads: DEPLOY_TOKEN",
          ],
          gatingHooks: [{ module: "./register.js", pattern: "tool.call", hook: "tool.call", hasCatch: false }],
        },
      ],
    },
  };
};
