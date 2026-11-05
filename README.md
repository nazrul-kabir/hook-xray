# hook-xray

**See what runs automatically.**

hook-xray is a free, open-source, local tool for reviewing Claude Code hooks and mods.

Find what is configured, see where it came from, and catch configuration mistakes. Scan supported sources across projects, or use the live companion mod to inspect session settings. Export a redacted JSON report for review.

> **Status: pre-release.** Not on npm yet, so `npx hook-xray` won't work until 0.1.0 is published. Run it from source:
>
> ```bash
> git clone <repo-url> hook-xray && cd hook-xray
> npm install
> npx tsx src/cli.ts
> ```

hook-xray does not run the hooks it inspects, start MCP servers, change your settings, or make network requests. Mods are analysed with `claude plugin validate`, which reads their code without running it. It does not certify that a plugin is safe.

Current focus: inventory, ownership and configuration lint. Broader risk analysis is planned.

## Why it matters

Installing a plugin adds behavior to your development environment. Claude Code's documentation is explicit about where that behavior runs:

- Command hooks, local MCP servers, plugin monitors and LSP servers run outside the Bash sandbox, with your full access. On native Windows there is no sandbox at all. ([Sandboxing](https://code.claude.com/docs/en/sandboxing))
- A mod is a plugin that runs code inside Claude Code with your permissions, and mods aren't sandboxed. A mod sees every prompt and tool call and can change them. Permission deny rules apply to Claude's tool calls, not to a mod's own file and process calls: with `Read(.env)` denied, a mod can still read that file. ([Manage mods](https://code.claude.com/docs/en/plugins/mods/admin))

Before deciding what to trust, it helps to know what is installed.

## Why not `/hooks`?

`/hooks` shows the hooks of the current session. hook-xray adds:

- **Every source, before it activates**: user, project, local, managed policy, `--settings` files, plugins (`hooks/hooks.json`, inline and manifest-referenced files), and skill and subagent frontmatter, which only register once the skill or subagent runs.
- **The exact owner** of each plugin hook.
- **Mods**: plugins with a hooks module, including session mods in `~/.claude/dev-mods/`, with the events, API calls and env/state access `claude plugin validate` reports.
- **Config lint**: hooks that never run, run twice, or cost context on every prompt.
- **Every project** with `--all-projects`.

## Usage

From source, replace `npx hook-xray` with `npx tsx src/cli.ts`.

```bash
npx hook-xray                        # this project + user + managed + plugins
npx hook-xray --all-projects         # every project in ~/.claude.json
npx hook-xray --event PreToolUse     # one event
npx hook-xray --json --redact        # for sharing; see the redaction note below
npx hook-xray --settings ./launcher-settings.json   # files passed to claude --settings
npx hook-xray --sources              # list every path checked
npx hook-xray --live live.json       # add hooks saved by the live-view mod
```

## Live view (companion mod)

A disk scan can't see some hooks: those a launcher or wrapper passes with `--settings` (a file you may not know about) or as SDK inline settings, and managed policy delivered by MDM, the Windows registry or server-managed settings. The `mods/hook-xray-live` mod reads them from inside a running session with `$.settings.read({ source })`.

```bash
claude --plugin-dir ./mods/hook-xray-live
# in the session:
/hook-xray                  # hooks from --settings / SDK and managed policy, with findings
/hook-xray all              # also user, project and local settings (dashes optional)
/hook-xray save live.json   # write a snapshot (header values and MCP inputs removed)
```

It only reads. It writes a file only when you pass `save`, and it adds nothing to Claude's context. Plugin, skill and subagent hooks aren't visible to it; the CLI covers those. Needs a Claude Code version with mods (2.1.287+).

To check it works, start a session with a harmless test hook: `claude --plugin-dir ./mods/hook-xray-live --settings ./mods/hook-xray-live/positive-control.settings.json`, then `/hook-xray` should list one `Setup [maintenance]` hook. It only fires with `claude -p --maintenance`.

## Redaction

`--redact` hides header and env values, token-like strings, URL hosts and queries, prompts, MCP inputs and your home path, and shortens project paths in hooks and findings.

**Known gaps, fixed before 0.1.0:** project paths outside your home folder still appear in `--json --redact` source lists and read errors on Windows, and in the terminal's `--sources` and "Could not read" lists on every OS. Check the output before sharing it.

## Rules (v0.1)

| Rule | Confidence | What it catches |
|---|---|---|
| `dead-if` | certain | `if` on a non-tool event: the hook never runs |
| `session-start-unsupported-handler` | certain | `http`, `prompt` or `agent` on SessionStart (documented), or `http` on Setup (observed in Claude Code 2.1.318): never runs |
| `http-url-not-allowlisted` | certain | URL outside `allowedHttpHookUrls` (only when that's set): never runs |
| `double-run-copy` | certain | a plugin or skill copy of a settings handler: runs twice |
| `frequent-context-injection` | likely | output added to context on every prompt or tool call |
| `default-timeout-on-blocking-event` | certain | Stop, SubagentStop, SessionStart, PreToolUse or PermissionRequest hook on the 600s default |
| `unanchored-regex-matcher` | certain | `Edit.*` also matches `NotebookEdit` |
| `broad-matcher` | certain | tool event matching every tool |
| `shell-form-placeholder` | certain | `${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_PROJECT_DIR}` in shell form; use exec form (`args`) |
| `session-start-mcp-tool-may-skip` | likely | `mcp_tool` on SessionStart/Setup: skipped with a non-blocking error if the server hasn't connected within the hook's timeout |
| `suppress-output-ignored` | likely | `suppressOutput` is accepted but does nothing |
| `mod-gating-without-catch` | certain | from `claude plugin validate` |
| `mod-unvalidated` | certain | a mod was found but `claude plugin validate` couldn't run |

"Likely" findings come from reading the hook's command and the script files it references. hook-xray never guesses at mod code: when `claude` isn't on PATH it reports the mod as present but unvalidated.

`disableAllHooks` and `allowManagedHooksOnly` are read first; when they're on, only managed hooks are linted. `disableAllHooks` set in *managed* settings turns off every hook, managed ones included, so no hooks are linted then.

## What it can't see

- MDM plists, the Windows registry, server-managed settings and launcher-injected `--settings` from the CLI alone: use the live-view mod above.
- Hooks registered at runtime (session hooks).
- Plugins loaded only with `claude --plugin-dir`; hook-xray reads installed plugins.
- Cloud sessions don't read your local `~/.claude/settings.json`; this is a local-machine view.

## Develop

```bash
npm install
npm test            # fixture-driven, no Claude Code needed
npm run test:mod    # the mod's tests and validation (needs the claude CLI)
npm run typecheck
npx tsx src/cli.ts --sources
npm run build
```

In PowerShell, `npm run dev -- <flags>` can drop the flags; call `npx tsx src/cli.ts <flags>` directly.

Contributor notes: [CLAUDE.md](CLAUDE.md), [docs/context.md](docs/context.md) (verified Claude Code behavior), [docs/plan-0.1.0.md](docs/plan-0.1.0.md) (current work).

See [roadmap.md](roadmap.md) for what comes after 0.1.0.

## License

MIT
