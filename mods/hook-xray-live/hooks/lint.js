// Pure functions: no mods API calls, no I/O. Mirrors the config-only rules of the hook-xray CLI
// (src/lint/rules.ts); rules that need to read script files stay in the CLI.
// Facts from https://code.claude.com/docs/en/hooks unless noted.

const IF_EVENTS = new Set(["PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest", "PermissionDenied"]);
const STDOUT_CONTEXT_EVENTS = new Set(["SessionStart", "UserPromptSubmit", "UserPromptExpansion", "PostModelSwitch"]);
const SESSION_START_TYPES = new Set(["command", "mcp_tool"]);
const LOWERED_DEFAULT = { UserPromptSubmit: 30, PreModelSwitch: 30, PostModelSwitch: 30, MessageDisplay: 10 };
const LATENCY_SENSITIVE = new Set(["Stop", "SubagentStop", "SessionStart", "PreToolUse", "PermissionRequest"]);
const SIMPLE_MATCHER = /^[A-Za-z0-9_\- ,|]*$/;

/** Which sources the live view reads by default: the ones a disk scan can't see. */
export const LIVE_SOURCES = ["flag", "policy"];
export const ALL_SOURCES = ["user", "project", "local", "flag", "policy"];

const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});

/** settings.hooks -> one record per handler. */
export function hooksOf(settings, source) {
  const out = [];
  for (const [event, groups] of Object.entries(obj(obj(settings).hooks))) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      const g = obj(group);
      for (const handler of Array.isArray(g.hooks) ? g.hooks : []) {
        const h = obj(handler);
        if (typeof h.type !== "string") continue;
        out.push({ source, event, matcher: typeof g.matcher === "string" ? g.matcher : undefined, handler: h });
      }
    }
  }
  return out;
}

export function defaultTimeout(r) {
  if (r.handler.type === "prompt") return 30;
  if (r.handler.type === "agent") return 60;
  return LOWERED_DEFAULT[r.event] ?? 600;
}

function urlAllowed(url, patterns) {
  return patterns.some((p) => {
    const re = new RegExp("^" + String(p).split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
    return re.test(url);
  });
}

/** Findings for one hook record. `merged` is the session's merged settings. */
export function lintHook(r, merged) {
  const f = [];
  const h = r.handler;
  const add = (rule, severity, message) => f.push({ rule, severity, message });

  if (h.if && !IF_EVENTS.has(r.event)) add("dead-if", "warning", `\`if\` on ${r.event}: this hook never runs`);

  if (r.event === "SessionStart" && !SESSION_START_TYPES.has(h.type)) {
    add("session-start-unsupported-handler", "warning", `${h.type} handler on SessionStart never runs`);
  } else if (r.event === "Setup" && h.type === "http") {
    // Observed in Claude Code 2.1.318; not stated in the docs.
    add("session-start-unsupported-handler", "warning", "http handler on Setup never runs");
  } else if ((r.event === "SessionStart" || r.event === "Setup") && h.type === "mcp_tool") {
    add("session-start-mcp-tool-may-skip", "info", `mcp_tool on ${r.event} is skipped if its server hasn't connected within the timeout`);
  }

  if (r.matcher && r.matcher !== "*" && !SIMPLE_MATCHER.test(r.matcher) && !(r.matcher.startsWith("^") && r.matcher.endsWith("$"))) {
    add("unanchored-regex-matcher", "info", `matcher "${r.matcher}" is an unanchored regex`);
  }
  if (IF_EVENTS.has(r.event) && (r.matcher === undefined || r.matcher === "" || r.matcher === "*")) {
    add("broad-matcher", "info", `${r.event} hook matches every tool`);
  }
  if (h.type === "command" && !h.args && /\$\{?(CLAUDE_PLUGIN_ROOT|CLAUDE_PROJECT_DIR)\}?/.test(String(h.command ?? ""))) {
    add("shell-form-placeholder", "info", "shell-form command with a path placeholder; use exec form (args)");
  }
  if (h.type === "command" && r.event === "UserPromptSubmit" && STDOUT_CONTEXT_EVENTS.has(r.event)) {
    add("frequent-context-injection", "warning", "anything it prints is added to context on every prompt (likely)");
  }
  if (h.timeout === undefined && LATENCY_SENSITIVE.has(r.event) && defaultTimeout(r) >= 600) {
    add("default-timeout-on-blocking-event", "info", `no timeout on ${r.event} (default ${defaultTimeout(r)}s)`);
  }
  const allow = obj(merged).allowedHttpHookUrls;
  if (h.type === "http" && Array.isArray(allow) && !urlAllowed(String(h.url ?? ""), allow)) {
    add("http-url-not-allowlisted", "warning", "URL isn't in allowedHttpHookUrls: never runs");
  }
  return f;
}

/** Strips values a snapshot shouldn't carry: header and env values, MCP inputs. Keeps structure for linting. */
export function scrubHandler(h) {
  const out = { ...h };
  if (out.headers && typeof out.headers === "object") {
    out.headers = Object.fromEntries(Object.keys(out.headers).map((k) => [k, "<redacted>"]));
  }
  if ("input" in out) out.input = "<redacted>";
  if (out.env && typeof out.env === "object") out.env = Object.fromEntries(Object.keys(out.env).map((k) => [k, "<redacted>"]));
  return out;
}

/** Builds the report from per-source settings and the merged settings. */
export function buildReport(perSource, merged, version, shown = null) {
  const m = obj(merged);
  const isShown = (source) => !shown || shown.includes(source);
  const hooks = [];
  for (const { source, settings } of perSource) if (isShown(source)) hooks.push(...hooksOf(settings, source));
  const notShown = perSource
    .filter(({ source }) => !isShown(source))
    .map(({ source, settings }) => ({ source, hookCount: hooksOf(settings, source).length }))
    .filter((s) => s.hookCount > 0);
  return {
    tool: "hook-xray-live",
    version,
    view: "live session: hooks from --settings / SDK inline settings (flag) and managed policy (policy)",
    global: {
      disableAllHooks: m.disableAllHooks === true,
      allowManagedHooksOnly: m.allowManagedHooksOnly === true,
      allowedHttpHookUrls: Array.isArray(m.allowedHttpHookUrls) ? m.allowedHttpHookUrls.length : null,
    },
    sources: perSource.filter(({ source }) => isShown(source)).map(({ source, settings }) => ({ source, hookCount: hooksOf(settings, source).length })),
    notShown,
    hooks: hooks.map((r, i) => ({
      id: `L${i + 1}`,
      source: r.source,
      event: r.event,
      matcher: r.matcher ?? null,
      type: r.handler.type,
      handler: scrubHandler(r.handler),
      findings: lintHook(r, merged),
    })),
  };
}

function whatRuns(h) {
  if (h.type === "command") return [h.command, ...(Array.isArray(h.args) ? h.args : [])].join(" ");
  if (h.type === "http") return String(h.url ?? "");
  if (h.type === "mcp_tool") return `${h.server} → ${h.tool}`;
  return `<${h.type} prompt, ${String(h.prompt ?? "").length} chars>`;
}

const LABEL = { flag: "--settings / SDK", policy: "managed policy", user: "user", project: "project", local: "local" };
const ICON = { warning: "⚠", info: "ℹ", attention: "✖" };

/** Plain-text rendering for the transcript. */
export function render(report, savedTo) {
  const lines = [];
  lines.push(`hook-xray live view · read-only · ${report.view}`);
  const g = report.global;
  if (g.disableAllHooks) lines.push("disableAllHooks is on: only managed hooks run");
  if (g.allowManagedHooksOnly) lines.push("allowManagedHooksOnly is on: only managed hooks run");
  if (!report.hooks.length) {
    lines.push("", `No hooks from ${report.sources.map((s) => LABEL[s.source] ?? s.source).join(" or ")}.`);
  } else {
    const n = report.hooks.length;
    const issues = report.hooks.reduce((a, h) => a + h.findings.length, 0);
    lines.push("", `${n} hook${n === 1 ? "" : "s"}, ${issues} finding${issues === 1 ? "" : "s"}`);
    for (const h of report.hooks) {
      const matcher = h.matcher ? ` [${h.matcher}]` : "";
      const t = h.handler.timeout === undefined ? "default timeout" : `${h.handler.timeout}s`;
      lines.push("", `${h.id} ${h.event}${matcher} · ${h.type} · ${LABEL[h.source] ?? h.source} · ${t}`);
      lines.push(`   ${whatRuns(h.handler).slice(0, 160)}`);
      for (const f of h.findings) lines.push(`   ${ICON[f.severity] ?? "-"} ${f.message}`);
    }
  }
  const hidden = report.notShown ?? [];
  if (hidden.length) {
    const n = hidden.reduce((a, s) => a + s.hookCount, 0);
    const where = hidden.map((s) => `${s.hookCount} ${LABEL[s.source] ?? s.source}`).join(", ");
    lines.push("", `Also ${n} hook${n === 1 ? "" : "s"} in your settings files (${where}): /hook-xray all lists them.`);
  } else if (!report.hooks.length) {
    lines.push("That's normal without managed settings or a launcher passing --settings.");
  }
  if (!hidden.length && report.hooks.length) lines.push("");
  lines.push("Plugin, skill and subagent hooks aren't visible from here: run the hook-xray CLI for those.");
  lines.push("");
  lines.push(savedTo ? `Snapshot saved to ${savedTo} (header values and MCP inputs removed). Run: hook-xray --live ${savedTo}` : "Add save <file> to write a snapshot for `hook-xray --live <file>`.");
  return lines.join("\n");
}

/** `/hook-xray [all] [save [file]]`, dashes optional */
export function parseArgs(args) {
  const words = String(args ?? "").trim().split(/\s+/).filter(Boolean);
  const out = { all: false, save: null, unknown: [] };
  // Accept `--all`, `-all` and `all` alike: slash-command users often skip the dashes.
  const flag = (w) => w.replace(/^-{1,2}/, "").toLowerCase();
  for (let i = 0; i < words.length; i++) {
    const w = flag(words[i]);
    if (w === "all") out.all = true;
    else if (w === "save") {
      const next = words[i + 1];
      out.save = next && !["all", "save"].includes(flag(next)) ? (i++, next) : "hook-xray-live.json";
    } else out.unknown.push(words[i]);
  }
  return out;
}
