import { isAbsolute, resolve } from "node:path";
import { readText } from "../discover/fs.js";
import type { Finding, HookRecord, Inventory } from "../types.js";

// Facts below are from the hooks reference: https://code.claude.com/docs/en/hooks

/** Events where `if` is evaluated. On any other event a hook with `if` never runs. */
export const IF_EVENTS = new Set(["PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest", "PermissionDenied"]);

/** Tool events, where a matcher selects tools. */
const TOOL_EVENTS = IF_EVENTS;

/** Events whose plain stdout is added to Claude's context. */
export const STDOUT_CONTEXT_EVENTS = new Set(["SessionStart", "UserPromptSubmit", "UserPromptExpansion", "PostModelSwitch"]);

/** High-frequency events where injected context adds up: every prompt, or every tool call. */
const FREQUENT_EVENTS = new Set(["UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "PostToolBatch"]);

/** Handler types SessionStart supports. */
const SESSION_START_TYPES = new Set(["command", "mcp_tool"]);

/** Events where the 600s default for command/http/mcp_tool is lowered. */
const LOWERED_DEFAULT: Record<string, number> = {
  UserPromptSubmit: 30,
  PreModelSwitch: 30,
  PostModelSwitch: 30,
  MessageDisplay: 10,
};

/** Blocking or latency-sensitive events where a 600s default can stall a turn or startup. */
const LATENCY_SENSITIVE = new Set(["Stop", "SubagentStop", "SessionStart", "PreToolUse", "PermissionRequest"]);

/** Characters that keep a matcher an exact string or a | / , list. Anything else makes it an unanchored JS regex. */
const SIMPLE_MATCHER = /^[A-Za-z0-9_\- ,|]*$/;

export function defaultTimeout(h: HookRecord): number {
  const t = h.handler.type;
  if (t === "prompt") return 30;
  if (t === "agent") return 60;
  return LOWERED_DEFAULT[h.event] ?? 600;
}

export function where(h: HookRecord, shortProject = false): string {
  const o = h.owner;
  if (o.kind === "plugin") return `plugin:${o.name}`;
  if (o.kind === "skill" || o.kind === "agent") return `${o.kind}:${o.name}`;
  if (o.kind === "flag") return o.name?.startsWith("live:") ? o.name : `--settings ${o.name}`;
  if (o.kind === "managed") return o.name?.startsWith("live:") ? o.name : `managed (${o.name})`;
  if (!o.project) return o.kind;
  return `${o.kind} · ${shortProject ? "…/" + o.project.split(/[\\/]/).filter(Boolean).pop() : o.project}`;
}

/** The script files a command hook points at, resolved against the plugin root and project dir. */
export function referencedScripts(h: HookRecord, home = process.env.HOME ?? "~"): string[] {
  if (h.handler.type !== "command") return [];
  const words = [h.handler.command, ...(h.handler.args ?? [])].flatMap((w) => w.split(/\s+/));
  const projectDir = h.owner.project ?? process.cwd();
  const out: string[] = [];
  for (let w of words) {
    w = w.replace(/^["']|["']$/g, "");
    if (!/\.(sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl|ps1)$/.test(w)) continue;
    w = w
      .replace(/\$\{?CLAUDE_PLUGIN_ROOT\}?/g, h.pluginRoot ?? "${CLAUDE_PLUGIN_ROOT}")
      .replace(/\$\{?CLAUDE_PROJECT_DIR\}?/g, projectDir)
      .replace(/^~(?=\/)/, home);
    if (w.includes("${")) continue;
    out.push(isAbsolute(w) ? w : resolve(h.pluginRoot ?? projectDir, w));
  }
  return out;
}

/** The hook's command line plus the content of any script it references. */
function hookText(h: HookRecord, home?: string): string {
  if (h.handler.type !== "command") return "";
  const scripts = referencedScripts(h, home)
    .map((p) => readText(p) ?? "")
    .join("\n");
  return [h.handler.command, ...(h.handler.args ?? []), scripts].join("\n");
}

function handlerKey(h: HookRecord): string {
  const { type } = h.handler;
  const x = h.handler as Record<string, unknown>;
  return JSON.stringify([h.event, h.matcher ?? "", type, x.command, x.args, x.url, x.server, x.tool, x.prompt, x.if]);
}

type Rule = (h: HookRecord, inv: Inventory) => Finding[];

const deadIf: Rule = (h) =>
  h.handler.if && !IF_EVENTS.has(h.event)
    ? [
        {
          rule: "dead-if",
          severity: "warning",
          confidence: "certain",
          hookId: h.id,
          message: `\`if: "${h.handler.if}"\` on ${h.event}: this hook never runs`,
          why: "`if` is only evaluated on PreToolUse, PostToolUse, PostToolUseFailure, PermissionRequest and PermissionDenied. On other events a hook with `if` never runs.",
          fix: "Remove `if`, or move the hook to a tool event. Note `if` is best-effort even there: use permission rules for a hard allow or deny.",
        },
      ]
    : [];

const regexMatcher: Rule = (h) => {
  const m = h.matcher;
  if (!m || m === "*" || SIMPLE_MATCHER.test(m)) return [];
  const anchored = m.startsWith("^") && m.endsWith("$");
  if (anchored) return [];
  return [
    {
      rule: "unanchored-regex-matcher",
      severity: "info",
      confidence: "certain",
      hookId: h.id,
      message: `matcher "${m}" is an unanchored regular expression`,
      why: "A matcher with any character other than letters, digits, _, -, space, comma or | is evaluated as an unanchored JavaScript regex, so `Edit.*` also matches `NotebookEdit`.",
      fix: `Anchor it: "^(${m})$", or use an exact list like "Edit|Write".`,
    },
  ];
};

const broadMatcher: Rule = (h) =>
  TOOL_EVENTS.has(h.event) && (h.matcher === undefined || h.matcher === "" || h.matcher === "*")
    ? [
        {
          rule: "broad-matcher",
          severity: "info",
          confidence: "certain",
          hookId: h.id,
          message: `${h.event} hook matches every tool`,
          why: "An omitted, empty or `*` matcher runs the hook on every tool call, which adds latency to each one.",
          fix: "Match only the tools the hook needs, for example \"Bash\" or \"Edit|Write\".",
        },
      ]
    : [];

const shellPlaceholder: Rule = (h) => {
  if (h.handler.type !== "command" || h.handler.args) return [];
  const m = /\$\{?(CLAUDE_PLUGIN_ROOT|CLAUDE_PROJECT_DIR)\}?/.exec(h.handler.command);
  return m
    ? [
        {
          rule: "shell-form-placeholder",
          severity: "info",
          confidence: "certain",
          hookId: h.id,
          message: `shell-form command uses \${${m[1]}}`,
          why: "Without `args`, the command string goes through a shell, so a path with spaces or shell characters breaks it. The docs recommend exec form for any hook that uses a path placeholder.",
          fix: `Use exec form: { "command": "<interpreter or script>", "args": ["\${${m[1]}}/…"] }.`,
        },
      ]
    : [];
};

const contextInjection: Rule = (h, inv) => {
  if (!FREQUENT_EVENTS.has(h.event)) return [];
  if (h.handler.type !== "command") return [];
  const text = hookText(h, inv.home);
  const json = /additionalContext/.test(text);
  const plainStdout = STDOUT_CONTEXT_EVENTS.has(h.event);
  if (!json && !plainStdout) return [];
  const per = h.event === "UserPromptSubmit" ? "every prompt" : "every matching tool call";
  return [
    {
      rule: "frequent-context-injection",
      severity: "warning",
      confidence: "likely",
      hookId: h.id,
      message: json
        ? `${h.event} hook adds \`additionalContext\` to ${per}`
        : `anything this ${h.event} hook prints is added to context on ${per}`,
      why: plainStdout
        ? `On ${h.event}, plain stdout and JSON additionalContext both reach Claude, so whatever this prints costs context ${per === "every prompt" ? "on every prompt" : "repeatedly"}.`
        : "The script references additionalContext, which Claude Code inserts next to the tool result each time the hook fires.",
      fix: "Keep the output short, print only when something changed, or move static text to CLAUDE.md.",
    },
  ];
};

const sessionStartType: Rule = (h) => {
  if (h.event !== "SessionStart" && h.event !== "Setup") return [];
  const t = h.handler.type;
  // Docs: SessionStart supports only command and mcp_tool. Claude Code 2.1.318 also drops http handlers on Setup.
  const unsupported = h.event === "SessionStart" ? !SESSION_START_TYPES.has(t) : t === "http";
  if (unsupported) {
    return [
      {
        rule: "session-start-unsupported-handler",
        severity: "warning",
        confidence: "certain",
        hookId: h.id,
        message: `${t} handler on ${h.event} never runs`,
        why:
          h.event === "SessionStart"
            ? "SessionStart supports only `command` and `mcp_tool` handlers."
            : "Claude Code skips http handlers on Setup (observed in Claude Code 2.1.318).",
        fix: "Use a command hook, or move the logic to another event.",
      },
    ];
  }
  if (t === "mcp_tool") {
    return [
      {
        rule: "session-start-mcp-tool-may-skip",
        severity: "info",
        confidence: "likely",
        hookId: h.id,
        message: `mcp_tool hook on ${h.event} may be skipped at launch`,
        why:
          `${h.event} usually fires before MCP servers finish connecting. Claude Code waits for the server up to the hook's timeout; ` +
          `if it hasn't connected by then, the hook is skipped with a non-blocking "not connected" error and the session continues without it. ` +
          `Don't rely on it for anything that must happen on every startup.`,
        fix: "Use a command hook for launch-time work, and set an explicit short timeout so a slow server can't hold up startup.",
      },
    ];
  }
  return [];
};

const suppressOutput: Rule = (h, inv) => {
  const text = hookText(h, inv.home);
  return /suppressOutput/.test(text)
    ? [
        {
          rule: "suppress-output-ignored",
          severity: "info",
          confidence: "likely",
          hookId: h.id,
          message: "hook returns `suppressOutput`, which Claude Code ignores",
          why: "Claude Code accepts `suppressOutput` but doesn't act on it. A successful hook's stdout never shows in the transcript anyway.",
          fix: "Drop the field; it does nothing.",
        },
      ]
    : [];
};

const missingTimeout: Rule = (h) => {
  if (h.handler.timeout !== undefined || !LATENCY_SENSITIVE.has(h.event)) return [];
  const d = defaultTimeout(h);
  if (d < 600) return [];
  return [
    {
      rule: "default-timeout-on-blocking-event",
      severity: "info",
      confidence: "certain",
      hookId: h.id,
      message: `${h.event} hook has no timeout (default ${d}s)`,
      why: `${h.event} blocks the session while the hook runs. A hung ${h.handler.type} hook can stall it for up to ${d / 60} minutes.`,
      fix: "Set an explicit `timeout` in seconds that matches what the hook needs.",
    },
  ];
};

function urlAllowed(url: string, patterns: string[]): boolean {
  return patterns.some((p) => {
    const re = new RegExp("^" + p.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
    return re.test(url);
  });
}

const httpAllowlist: Rule = (h, inv) => {
  const list = inv.global.allowedHttpHookUrls;
  if (h.handler.type !== "http" || !list) return [];
  return urlAllowed(h.handler.url, list)
    ? []
    : [
        {
          rule: "http-url-not-allowlisted",
          severity: "warning",
          confidence: "certain",
          hookId: h.id,
          message: `HTTP hook URL isn't in allowedHttpHookUrls: it never runs`,
          why: "When allowedHttpHookUrls is set at any settings level, Claude Code runs an HTTP hook only if its URL matches the merged allowlist.",
          fix: "Add the URL pattern to allowedHttpHookUrls, or remove the hook.",
        },
      ];
};

const RULES: Rule[] = [
  deadIf,
  regexMatcher,
  broadMatcher,
  shellPlaceholder,
  contextInjection,
  sessionStartType,
  suppressOutput,
  missingTimeout,
  httpAllowlist,
];

/** Plugin or skill copies of a settings-file handler run separately, so the handler runs twice. */
function doubleRun(inv: Inventory): Finding[] {
  const settingsKinds = new Set(["user", "project", "local", "managed", "flag"]);
  const settings = new Map<string, HookRecord>();
  for (const h of inv.hooks) if (settingsKinds.has(h.owner.kind)) settings.set(handlerKey(h), h);
  const out: Finding[] = [];
  for (const h of inv.hooks) {
    if (h.owner.kind !== "plugin" && h.owner.kind !== "skill") continue;
    if (h.owner.name?.endsWith("(disabled)")) continue;
    const twin = settings.get(handlerKey(h));
    if (!twin) continue;
    out.push({
      rule: "double-run-copy",
      severity: "warning",
      confidence: "certain",
      hookId: h.id,
      message: `same handler as ${twin.id} (${where(twin)}): runs twice`,
      why: "Identical handlers across settings files run once, but a plugin's or skill's copy stays separate and runs again.",
      fix: "Remove one of the two copies.",
    });
  }
  return out;
}

function modFindings(inv: Inventory): Finding[] {
  const out: Finding[] = [];
  for (const m of inv.mods) {
    if (!m.validation.ok) {
      out.push({
        rule: "mod-unvalidated",
        severity: "info",
        confidence: "certain",
        modId: m.id,
        message: `mod ${m.plugin}: present, validation unavailable (${m.validation.reason})`,
        why: "Hook X-ray never parses mod code itself; it relies on `claude plugin validate`.",
      });
      continue;
    }
    for (const g of m.validation.gatingWithoutCatch) {
      out.push({
        rule: "mod-gating-without-catch",
        severity: "warning",
        confidence: "certain",
        modId: m.id,
        message: `mod ${m.plugin}: gating hook on ${g} has no .catch`,
        why: "`claude plugin validate` flags gating hooks without error handling; a throw there affects every matching event.",
      });
    }
  }
  return out;
}

export function lint(inv: Inventory): Finding[] {
  // disableAllHooks can't disable managed hooks, so those are still linted.
  const off = inv.global.disableAllHooks?.value === true;
  const managedOnly = inv.global.allowManagedHooksOnly;
  const live = inv.hooks.filter((h) => (!off && !managedOnly) || h.owner.kind === "managed");
  const findings = live.flatMap((h) => RULES.flatMap((r) => r(h, inv)));
  if (!off && !managedOnly) findings.push(...doubleRun(inv));
  findings.push(...modFindings(inv));
  return findings;
}

export const _test = { urlAllowed, handlerKey };
