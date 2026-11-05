# Hook X-ray — Roadmap

> Current work: `docs/plan-0.1.0.md` (first public 0.1.0). Facts and decisions: `docs/context.md`. Where this roadmap and the plan differ, the plan wins.

Build **Hook X-ray** as a local, read-only CLI whose job is: *"Show me every hook that can run on this machine, who owns it, what it does, what is misconfigured, and what looks risky."* Claude Code hooks can be `command`, `http`, `mcp_tool`, `prompt` or `agent` handlers, and they come from user, project, local, managed-policy, plugin, skill and subagent sources — so the core value is a trustworthy merged view plus config lint. [Hooks reference](https://code.claude.com/docs/en/hooks)

## Product positioning

**Name:** `hook-xray` (free on npm as of 2026-11-04; `hookx` and `claude-hooks` are taken. Check GitHub too).

**One-line pitch:**
> `npx hook-xray` — X-ray every Claude Code hook: source, owner, trigger, misconfigurations, and risk.

**Why not just `/hooks`?** Claude Code already ships `/hooks`, a read-only browser showing each hook's event, matcher, handler and source for the current session. Hook X-ray only earns its place by doing what `/hooks` can't:
- Scan **every project** on the machine, not just the current session.
- Show **dormant** skill and subagent hooks, which only register once the skill is invoked or while the subagent runs.
- Attribute plugin hooks to the **exact plugin** (`/hooks` groups them as "Plugin Hooks").
- **Lint** the config and **explain** the risk.
- Run in **CI**.

**Why not cc-audit or Snyk Agent Scan?** Both already flag risky hook commands (exfiltration, privilege escalation). Don't compete on a rule count. Compete on explainability, config-semantics lint, and owner attribution.

**Non-goals for v1:**
- No execution of hook commands.
- No automatic fixing or deletion.
- No claim of malware detection.
- No cloud service; all analysis stays local.

## Roadmap

### v0.1 — "Inventory + config lint + mods" — ~1 week (MVP)

**Goal:** one command lists every JSON hook and every mod on the machine, attributes each to its exact owner, and reports config mistakes nobody else reports. A bare table duplicates `/hooks`, so don't release one.

```bash
npx hook-xray
npx hook-xray --json --redact
npx hook-xray --event PreToolUse
```

**Discovery:**
- `~/.claude/settings.json`, plus `.claude/settings.json` and `.claude/settings.local.json` for the current directory and every project listed in `~/.claude.json`
- managed policy: `managed-settings.json` and `managed-settings.d/*.json` in `/Library/Application Support/ClaudeCode/` (macOS), `/etc/claude-code/` (Linux/WSL), `C:\Program Files\ClaudeCode\` (Windows). MDM plist, registry and server-managed settings are not readable from disk; say so in `sourcesScanned`.
- installed plugins: `hooks/hooks.json`, inline `hooks` in `plugin.json`, and files referenced by the manifest's `hooks` field. The docs say hooks have their "own merge rules", so verify the exact combining behavior before encoding precedence.
- skill and subagent frontmatter, including those shipped inside plugins
- **mods:** any plugin `hooks/hooks.json` with a `modules` key, and session mods under `~/.claude/dev-mods/<session-id>/`. For each, run `claude plugin validate --json <dir>` (static analysis, never executes the module) and read the `hooks:`, `calls:`, `env reads/writes:`, `state reads/writes:` notes and the `gatingHooks` array. If the `claude` CLI is missing or validation fails, report "mod present, validation unavailable" — never parse mod JS ourselves.
- an explicit `sourcesScanned` section listing every path checked and whether it existed

**Global state first:** report `disableAllHooks`, `allowManagedHooksOnly` and `allowedHttpHookUrls` at the top. Managed hooks can't be disabled by user settings. Cloud sessions don't read local `~/.claude/settings.json`, so this is a local-machine view.

**Ten lint rules:**
1. **Dead `if`:** `if` is only evaluated on `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest` and `PermissionDenied`; on other events the hook never runs. Explain that `if` is best-effort (a Bash hook runs anyway when Claude Code can't tell which commands it runs), so it's not a security boundary.
2. **Surprising regex matcher:** any character outside letters, digits, `_`, `-`, space, `,` and `|` makes it an unanchored JS regex (`Edit.*` also matches `NotebookEdit`). Suggest `^…$`.
3. **Broad matcher:** omitted, `""` or `*`.
4. **Double-run copy:** a plugin or skill handler identical to a settings-file handler runs separately, so it runs twice. (Identical handlers across settings files run once — not flagged.)
5. **Shell form with placeholders:** shell-form command using `${CLAUDE_PLUGIN_ROOT}` or `${CLAUDE_PROJECT_DIR}`; the docs recommend exec form (`args`).
6. **Context injection:** plain stdout reaches Claude on `SessionStart`, `UserPromptSubmit`, `UserPromptExpansion` and `PostModelSwitch`; JSON `additionalContext` also works on tool events, `PostToolBatch`, `Stop`, `SubagentStop` and `SubagentStart`. Flag high-frequency events (`UserPromptSubmit`, tool events) whose script contains `additionalContext`, marked **likely**.
7. **`SessionStart` / `Setup` handlers:** `SessionStart` supports only `command` and `mcp_tool`, so `http`, `prompt` and `agent` never run there (`session-start-unsupported-handler`); Claude Code 2.1.318 also drops `http` on `Setup`. An `mcp_tool` handler waits for its MCP server up to the hook's timeout and, if the server hasn't connected, is skipped with a non-blocking "not connected" error (`session-start-mcp-tool-may-skip`, info, likely). Source: hooks reference ("should expect the 'not connected' error on first run") and the 2.1.318 binary's hook log strings.
8. **`suppressOutput` is ignored:** Claude Code accepts the field but doesn't act on it (only detectable as likely, from script content).
9. **Missing timeout on latency-sensitive events:** defaults are 600s for `command`/`http`/`mcp_tool`, 30s for `prompt`, 60s for `agent`; lowered to 30s on `UserPromptSubmit`, `PreModelSwitch`, `PostModelSwitch` and 10s on `MessageDisplay`. Flag 600s-default hooks on `Stop`, `SubagentStop`, `SessionStart`, `PreToolUse` and `PermissionRequest`.
10. **HTTP URL not allowlisted:** only when `allowedHttpHookUrls` is set; a non-matching HTTP hook never runs.

Every finding derived from script content is marked `likely`, never certain.

**`--redact`:** strip header values, env values, token-like strings and URL hosts/queries. Ship it before asking anyone for samples.

**Sample summary:**

```text
18 hooks and 2 mods found across 6 projects

2 hooks never run:
  • dead if on SessionStart
  • http handler on SessionStart
1 plugin hook runs separately from a user-settings copy
1 UserPromptSubmit hook likely adds context to every prompt
1 mod reads environment variables and gates tool.call
3 hooks on blocking events rely on the 600s default timeout
```

**Acceptance test:** Hook X-ray finds every hook defined in discoverable config files and every mod discoverable through `hooks.json` `modules` or `~/.claude/dev-mods/`, attributes each to its exact owner, reports at least one real lint finding, never executes a hook, and its `--json --redact` output is safe to paste into a GitHub issue. (No parity claim with `/hooks`, which also shows session hooks registered at runtime.)

### v0.1.x — "Live view" companion mod — ✅ built

`mods/hook-xray-live/` registers `/hook-xray`. It calls `$.settings.read({ source })` for `flag` and `policy` (`--all` adds `user`, `project`, `local`) plus the merged settings, and lints with the config-only rules in `hooks/lint.js`.
- `flag` holds what `--settings` and SDK inline settings carry; `policy` is every managed tier merged, including MDM, registry and server-managed settings.
- Read-only. Writes a file only with `--save [file]`; the snapshot drops header values and MCP inputs. Returns no `context`, so nothing reaches the model.
- `hook-xray --live <file>` loads the snapshot and runs the full CLI rule set on it.
- Verified: `claude plugin validate` passes; 8 `claude plugin test` cases; a real `claude -p "/hook-xray --save …" --plugin-dir …` session in a cloud workspace showed the launcher's `Stop` hook, and the CLI read the snapshot.
- Known debt: `hooks/lint.js` duplicates the config-only rules from `src/lint/rules.ts`. A test builds the snapshot with the mod's own code so format drift fails CI; rule drift still needs a shared core (v0.2).
- Don't rebuild plugin token costs: `claude plugin details <name>` already reports components and projected token cost.

### v0.2 — "Explain the risk" — ~1 week

**Goal:** turn the inventory into prioritized, explained findings.

Static analysis per handler type:
- **command:** network (`curl`, `wget`, `nc`, URLs), package execution (`npx`, `npx -y`, `pnpm dlx`, `bunx`, `uvx`, `pip install`, `npm install`), filesystem writes (redirects, `tee`, `cp`, `mv`, `rm`), settings/permission mutation (writes to `.claude/settings*`), credential exposure (env vars, token-like strings), shell interpretation (pipes, `$(…)`, backticks, `&&`, `||`). Follow referenced script files inside the plugin root and scan those too.
- **http:** outbound by definition — report the host and that the full event JSON is POSTed.
- **mcp_tool:** report the server and tool; link to that server's owner.
- **prompt / agent:** model calls on every match — report the cost and that event data is sent to a model.

Three levels, not a binary "dangerous" flag:
- `info` — observable but normal
- `warning` — needs review
- `attention` — combines privileged execution with network, settings writes, or opaque remote code

`hook-xray explain <hook-id>`: resolved command (with `${CLAUDE_PLUGIN_ROOT}` expanded to the installed path, which changes on every plugin update), referenced files, findings, and why each matters.

Example output:

```text
⚠ SessionStart · user · ~/.claude/settings.json
  command: npx -y @vendor/setup-tool
  findings: downloads and executes an npm package at session start; stdout is added to context
  why it matters: runs before you approve any tool call

⚠ PreToolUse · plugin:deploy-tools
  command: "${CLAUDE_PLUGIN_ROOT}/scripts/check.sh"
  findings: plugin-owned executable; shell form with a path placeholder (use exec form)
```

**Mod review, from the official guidance** ([Manage mods](https://code.claude.com/docs/en/plugins/mods/admin), "Review what a mod can do"):
- Translate each `calls:` entry from `claude plugin validate` into the doc's own meaning: `$.fs.*` reads/writes files anywhere the user can, `$.process.*` starts programs, `$.http.fetch` makes network requests, `$.env.get`/`$.settings.read` can read API keys, `$.env.set` changes what later commands and MCP servers run, `$.model.complete` uses the user's plan, `$.prompt.submit` can send prompts as the user, `$.session.send` messages other sessions.
- Same for `hooks:`: `tool.call` and `prompt.submit` see and can change every tool call and prompt; `session.append` can rewrite stored conversation rows; `tool.check` can approve or deny a call before the permission prompt.
- Combination finding: a hook on conversation content (`session.compact`, `turn.complete`, `prompt.submit`, `session.append`) plus `$.http.fetch` → "may send conversation content off the machine" (likely).
- Built-in guard status: the guard (`sec-default@builtin`) loads only with managed settings or a Team/Enterprise sign-in. With no managed settings found, report "built-in guard likely inactive: a mod can approve calls your deny rules refuse, unless you're signed in with Team/Enterprise". Deny rules never cover a mod's own `$.fs`/`$.process` calls, guard or not.

### v0.3 — "Conflicts" — ~1 week

**Goal:** surface hooks that interfere with each other.

All matching hooks run **in parallel** — there is no execution order to show. Instead flag:
- Two or more hooks on the same event and tool that both return permission decisions.
- Hooks on the same event that write the same file or setting.
- Several `SessionStart` / `UserPromptSubmit` hooks that together inject a lot of context.
- `--owner <plugin>` filter and `--markdown` output.

### v0.4 — "CI and team trust" — 1–2 weeks

- `hook-xray check --fail-on attention` for CI.
- Baseline: `hook-xray baseline --save`, then `hook-xray check --against .hook-xray-baseline.json`. CI fails only on **new** findings.
- SARIF and JSON output for GitHub Code Scanning and PR comments.
- `--profile strict|balanced|audit`.

### v1.0 — "The hook review layer" — 3–4 weeks

- `hook-xray watch`: re-scan when settings or plugin hook files change.
- `--dry-run <payload.json>`: simulate matcher and `if` evaluation for a tool-call payload, without executing the handler.
- Plugin update diff: compare a plugin's hooks against the previous cached version.
- Loadout integration: offer the merged table and findings as JSON.
- Docs site with real-world cases: slow `npx -y` Stop hooks, double-running plugin copies, every-turn `UserPromptSubmit` injection, dead `if` conditions.

## Technical architecture

```text
hook-xray/
├── src/
│   ├── discover/       # settings, managed, plugin, skill, subagent sources; all projects
│   ├── parse/          # zod schemas for hook config and handlers
│   ├── resolve/        # owner, source, ${CLAUDE_PLUGIN_ROOT}/${CLAUDE_PROJECT_DIR}, exec vs shell form
│   ├── lint/           # config-semantics rules (v0.1)
│   ├── analyze/        # risk heuristics per handler type (v0.2)
│   ├── report/         # terminal, JSON, Markdown, SARIF; redaction
│   └── cli.ts
├── fixtures/           # real-world hook configs, one folder per rule
└── docs/
```

**Stack:**
- TypeScript + Node for `npx` distribution.
- `commander` for the CLI.
- `zod` for schema parsing.
- `picocolors` + `cli-table3` for terminal output.
- Vitest for fixture-driven tests.
- No telemetry.

## Launch plan

1. **Week 1:** ship v0.1 with `--redact`. Private alpha with 5–10 Claude Code power users; ask for redacted `--json` samples only.
2. **Week 2:** publish to GitHub and npm. Demo: "You have 14 hooks across 6 projects. 2 never run, 1 runs twice, 1 adds to every prompt."
3. **Week 3:** v0.2 risk analysis + `explain`. Open a focused Loadout PR or integration proposal: "Hook inventory and findings."
4. **Week 4:** v0.3 conflicts.
5. **Month 2:** CI baseline mode; pitch to teams with shared `.claude/settings.json` or internal plugin marketplaces.

## Metrics

From GitHub and npm only, no telemetry:
- Weekly npm downloads and repeat runs implied by version upgrades.
- GitHub issues containing a real (redacted) hook config.
- Stars and forks after the demo.
- Loadout or other tooling integrations.
- Repos with `hook-xray check` in CI.

## First-week build checklist

- [ ] Discover all seven JSON sources plus mods across every project in `~/.claude.json`.
- [ ] zod schemas for all five handler types, including exec form (`args`).
- [ ] Report `disableAllHooks` / `allowManagedHooksOnly` state.
- [ ] Merged terminal table with exact plugin owner.
- [ ] The ten v0.1 lint rules, each with fixtures.
- [ ] `--json`, `--redact`, `--event`.
- [ ] 20 fixtures, one per rule plus clearly labeled malicious-looking cases.
- [ ] 45-second demo recording.

**MVP definition:** v0.1 = inventory + config lint + mod inventory. Lint is what `/hooks`, cc-audit and Snyk don't do, and it's what makes the first post shareable.
