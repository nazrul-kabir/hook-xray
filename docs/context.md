# Context: verified facts, decisions, open questions

Captured 2026-11-05 from the design sessions. Claude Code version checked: **2.1.318**. Re-check anything here before relying on it after a Claude Code upgrade.

## Verified Claude Code behavior

### Hooks ([hooks reference](https://code.claude.com/docs/en/hooks))

- Handler types: `command`, `http`, `mcp_tool`, `prompt`, `agent`.
- Sources: user, project and local settings, managed policy, `--settings` files and SDK inline settings, plugins, skill frontmatter, subagent frontmatter. Skill hooks register once the skill is invoked and stay for the session; subagent hooks run only while that subagent runs. Session hooks registered at runtime aren't on disk.
- `if` is evaluated only on `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `PermissionDenied`. On other events a hook with `if` never runs. On Bash, `if` is best-effort: when Claude Code can't tell which commands run, the hook runs anyway, so use permission rules for hard allow/deny.
- Matchers: only letters, digits, `_`, `-`, space, `,` and `|` keep a matcher an exact string or list. Anything else makes it an **unanchored** JS regex (`Edit.*` matches `NotebookEdit`). Commas and whitespace in matchers need v2.1.191+; hyphens in exact matches v2.1.195+.
- Identical handlers in several settings files run once. A plugin's or skill's copy stays separate and runs again.
- All matching hooks run **in parallel**; there is no order.
- Default timeouts: 600s for `command`/`http`/`mcp_tool`, 30s for `prompt`, 60s for `agent`. Lowered to 30s on `UserPromptSubmit`, `PreModelSwitch`, `PostModelSwitch` and 10s on `MessageDisplay` (for command/http/mcp_tool). `SessionEnd` hooks share a 1.5s budget, raisable to 60s.
- `SessionStart` supports only `command` and `mcp_tool`.
- `mcp_tool` on `SessionStart`/`Setup`: docs say these "should expect the 'not connected' error on first run". The 2.1.318 binary waits for the server up to the hook's timeout, then skips the hook with a non-blocking error. They are **not** skipped unconditionally.
- Plain stdout becomes context only on `SessionStart`, `UserPromptSubmit`, `UserPromptExpansion`, `PostModelSwitch`. JSON `additionalContext` also works on tool events, `PostToolBatch`, `Stop`, `SubagentStop`, `SubagentStart`.
- `suppressOutput` is accepted but has no effect (output-field table).
- `allowedHttpHookUrls` applies to hooks from every source; once set anywhere, a non-matching HTTP hook doesn't run.
- `disableAllHooks` in user, project or local settings doesn't disable managed hooks. **In managed settings** it turns off every hook, managed ones included, and the mods in every installed plugin ([admin page](https://code.claude.com/docs/en/plugins/mods/admin), "Choose how much to allow"). `allowManagedHooksOnly` blocks user, project, local and plugin hooks, and users' own mods.
- Shell form (no `args`) goes through a shell; exec form (`args`) spawns directly. Docs recommend exec form for hooks using `${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_PROJECT_DIR}`.
- HTTP hooks POST the full event JSON. Prompt hooks call a model; agent hooks spawn a subagent with tools such as Read, Grep, Glob.
- Cloud sessions (Claude Code on the web) don't read local `~/.claude/settings.json`.
- `/hooks` is a read-only browser of the current session's hooks (event, matcher, handler, source), grouping plugin hooks as "Plugin Hooks".

### Plugins ([plugins reference](https://code.claude.com/docs/en/plugins-reference))

- Plugin hooks: `hooks/hooks.json`, inline in `plugin.json`, or files referenced by the manifest's `hooks` field. Paths must stay inside the plugin root. How several files combine is not documented precisely ("own merge rules"); hook-xray reads all of them.
- Real-world: ponytail ships its hooks only in a manifest-referenced `claude-codex-hooks.json` (no `hooks/hooks.json`). A scanner that only reads `hooks/hooks.json` misses them.
- Installed plugins: `~/.claude/plugins/installed_plugins.json` → `installPath`.
- Old plugin versions stay cached for about 14 days (basis for a future update-diff feature).

### Mods ([create](https://code.claude.com/docs/en/plugins/mods/create), [admin](https://code.claude.com/docs/en/plugins/mods/admin))

- A mod is a plugin whose `hooks/hooks.json` has a `modules` key. On by default from v2.1.287. Session mods Claude writes live in `~/.claude/dev-mods/<session-id>/`.
- `claude plugin validate --json <dir>` analyses mods statically. Report shape: `manifest` and `contents[]`, each with `notes` lines like `./register.js hooks: …`, `calls: …`, `env reads: …`, `env writes: …`, `state reads: …`, `state writes: …` (values like `nothing on $` are not entries), plus `gatingHooks: [{ hook, hasCatch }]` and `errors`.
- Mods aren't sandboxed and run with the user's permissions. A mod sees every prompt and tool call and can change them.
- Built-in guard `sec-default@builtin` loads only when the machine has managed settings **or** the user is signed in with Team/Enterprise. Where it loads, a user's mod can't approve a call a `deny` rule refuses (unless `allowModsToOverrideDenyRules`).
- Deny rules never cover a mod's own `$.fs` / `$.process` calls, guard or not ("with `Read(.env)` denied, a mod can still read that file with `$.fs.read`").
- The admin page has the official table for reading `calls:` (`$.fs.*`, `$.process.*`, `$.http.fetch`, `$.env.get`/`$.settings.read`, `$.env.set`, `$.mcp.call`, `$.model.complete`, `$.prompt.submit`, `$.session.send`) and `hooks:` (`tool.call`, `prompt.submit`, `session.append`, `tool.check`, …). Use it verbatim for v0.2.
- Mods API used by the live view: `$.settings.read({ source })` with `user | project | local | flag | policy`; `$.settings.read()` returns merged settings. `flag` = `--settings` and SDK inline settings; `policy` = all managed tiers merged, including MDM, registry and server-managed.
- Mod tests (`claude plugin test`): stub an API call with `on('settings.read', ($, e) => ({ value: … }))`: the stub takes `($, e)` and returns `{ value }`. `$.fs.write` paths arrive resolved to absolute.

### Sandbox ([sandboxing](https://code.claude.com/docs/en/sandboxing))

- Command hooks, local MCP servers, plugin monitors, LSP servers, the status line and `apiKeyHelper` run outside the Bash sandbox with full access. Native Windows has no sandbox.

### Built-in Claude Code features that overlap

- `/hooks` (current session's hooks), `/doctor` a.k.a. `/checkup` (hook latency, unused plugins/MCP, CLAUDE.md bloat), `/skill-doctor` (skill context cost and use), `claude plugin details <name>` (components and projected token cost), `claude plugin eval` (plugin trigger evals), `claude plugin validate`. MCP tool schemas are deferred by default. Don't rebuild these.

## Competitors

- **Snyk Agent Scan** (Apache-2.0): MCP servers and skills across many agents. Sends component information to Snyk for analysis (needs a token) and warns "Scanning MCP configurations can execute commands or make outbound network requests"; it starts stdio MCP servers. hook-xray's difference: runs nothing, sends nothing. Don't compete on rule count.
- **cc-audit**: static security rules for skills, hooks, MCP.
- **cc-plugin-audit**: flags marketplace update changes for review.
- **mcpup, claudeup, mcp-sync**: cross-client MCP/plugin config management and profiles.
- **Loadout** (`dylandifilippo/loadout`, MIT): inventory of skills, agents, commands, MCP names; explicitly doesn't cover hooks. Fallback home for this work.

## Product decisions

- Free and open source. No paid tiers.
- Name `hook-xray` (`hookx` and `claude-hooks` are taken on npm; `hook-xray` was free on 2026-11-04).
- Tagline "See what runs automatically.", bounded description "reviewing Claude Code hooks and mods". Don't claim it covers everything that runs automatically.
- First public release is **0.1.0** (nothing published before it).
- Lead with verified facts only (README "Why it matters").
- Stop rule: little traction 2–4 weeks after launch (stars, issues with real configs) → stop, or contribute the hook and mod inventory to Loadout.

## Unverified: don't claim or encode yet

- That a user's mod can approve a call a `deny` rule refuses where the built-in guard isn't loaded. The admin page implies it but doesn't say it outright.
- That `/hooks` can't show launcher-injected (`--settings`) or managed-policy hooks. Untested; it probably can.
- That `mcp_tool` hooks skip permission rules for every server. Seen only as a 2.1.318 binary message about the Artifacts MCP server.
- That hooks a real launcher injects (not via `--settings`) appear in the `flag` source.
- That `http` handlers on `Setup` never run: observed in the 2.1.318 binary, not in the docs (the rule says so).

## Real-machine evidence (one Windows machine, 2026-11-04)

- 6 plugins, 3 with hooks (ponytail ×3 hooks, postman ×1, i-have-adhd ×1); 0 hooks in user or project settings across 9 projects, one of them a Claude desktop scratch workspace.
- Findings worth attention: ponytail `UserPromptSubmit` adds to context on every prompt; postman `SessionStart` has no timeout and passes `${DROID_PLUGIN_ROOT}`; i-have-adhd runs inline `node -e` code.
- Mod `fast-jev-compaction`: hooks `session.compact`, `turn.complete`; calls `$.http.fetch`, `$.env.get`; reads `TYPESAFE_API_KEY`; gating hook without `.catch`. Suspected (not confirmed) to send conversation content to an outside API.
- Output problems that shaped 0.1.0: repeated info notes buried the mod; `--sources` was 79 lines; scratch folder looked like a project; plugin findings read like the user's mistakes.
