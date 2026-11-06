import type { Finding, Inventory } from "../types.js";
import { groupFindings } from "./group.js";
import { makeRedactor } from "./redact.js";
import type { Summary } from "./summary.js";

export function renderJson(inv: Inventory, findings: Finding[], summary: Summary, version: string, redact: boolean): string {
  // Redaction runs on raw strings before JSON.stringify: afterwards every backslash is escaped to \\
  // and Windows project paths no longer match. Every string field goes through `r`.
  const rd = makeRedactor(inv, { on: redact });
  const r = rd.value;
  const proj = (s?: string) => (s === undefined ? s : r(s));
  const groups = groupFindings(inv, findings).notes;
  const report = {
    tool: "hook-xray",
    version,
    redacted: redact,
    summary: { hooks: summary.hooks, mods: summary.mods, projects: summary.projects, lines: r(summary.lines) },
    global: inv.global.allowedHttpHookUrls && redact
      ? { ...inv.global, allowedHttpHookUrls: inv.global.allowedHttpHookUrls.map(() => "<redacted>") }
      : inv.global,
    projects: r(inv.projects),
    projectDetails: r(inv.projectDetails),
    pluginNames: inv.pluginNames,
    hooks: inv.hooks.map((h) => ({
      id: h.id,
      event: h.event,
      matcher: h.matcher ?? null,
      type: h.handler.type,
      owner: { ...h.owner, project: proj(h.owner.project) },
      file: r(h.file),
      handler: rd.handler.value(h),
    })),
    mods: r(inv.mods),
    findings: r(findings),
    groups: r(groups),
    sources: r(inv.sources),
    parseErrors: r(inv.parseErrors),
  };
  return JSON.stringify(report, null, 2);
}
