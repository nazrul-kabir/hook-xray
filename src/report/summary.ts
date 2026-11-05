import type { Finding, Inventory } from "../types.js";

export const NEVER_RUNS = new Set(["dead-if", "session-start-unsupported-handler", "http-url-not-allowlisted"]);

export interface Summary {
  hooks: number;
  mods: number;
  projects: number;
  lines: string[];
}

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;
/** "1 hook runs" / "2 hooks run" */
const verb = (n: number, one: string, many: string) => (n === 1 ? one : many);

export function summarize(inv: Inventory, findings: Finding[]): Summary {
  const lines: string[] = [];
  const by = (rule: string) => findings.filter((f) => f.rule === rule);

  const never = findings.filter((f) => NEVER_RUNS.has(f.rule));
  if (never.length) {
    lines.push(`${plural(never.length, "hook")} never ${verb(never.length, "runs", "run")}:`);
    for (const f of never) lines.push(`  • ${f.message}`);
  }
  const twice = by("double-run-copy");
  if (twice.length) lines.push(`${plural(twice.length, "plugin or skill hook")} ${verb(twice.length, "duplicates a settings hook and runs", "duplicate settings hooks and run")} twice`);
  const ctx = by("frequent-context-injection");
  if (ctx.length) lines.push(`${plural(ctx.length, "hook")} likely ${verb(ctx.length, "adds", "add")} context on every prompt or tool call`);
  const timeouts = by("default-timeout-on-blocking-event");
  if (timeouts.length) lines.push(`${plural(timeouts.length, "hook")} on blocking events ${verb(timeouts.length, "relies", "rely")} on the 600s default timeout`);
  const regex = by("unanchored-regex-matcher").length + by("broad-matcher").length;
  if (regex) lines.push(`${plural(regex, "matcher")} ${verb(regex, "matches more than it looks", "match more than they look")}`);

  const modEnv = inv.mods.filter((m) => m.validation.ok && (m.validation.envReads.length || m.validation.envWrites.length));
  if (modEnv.length) lines.push(`${plural(modEnv.length, "mod")} ${verb(modEnv.length, "reads or writes", "read or write")} environment variables`);
  const gating = by("mod-gating-without-catch");
  if (gating.length) lines.push(`${plural(gating.length, "mod gating hook")} without error handling`);
  const unval = by("mod-unvalidated");
  if (unval.length) lines.push(`${plural(unval.length, "mod")} present but not validated`);

  return { hooks: inv.hooks.length, mods: inv.mods.length, projects: inv.projects.length, lines };
}
