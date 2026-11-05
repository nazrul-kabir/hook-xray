import type { Finding, Inventory } from "../types.js";
import { redactText, redactValue } from "./redact.js";
import type { Summary } from "./summary.js";

export function renderJson(inv: Inventory, findings: Finding[], summary: Summary, version: string, redact: boolean): string {
  const home = inv.home;
  const p = (s: string) => (redact ? redactText(s, home) : s);
  // Project paths can name clients or employers; under --redact keep only the last folder.
  const proj = (s?: string) => (s && redact ? `…/${s.split(/[\\/]/).filter(Boolean).pop()}` : s);
  const report = {
    tool: "hook-xray",
    version,
    redacted: redact,
    summary: { hooks: summary.hooks, mods: summary.mods, projects: summary.projects, lines: summary.lines },
    global: inv.global.allowedHttpHookUrls && redact
      ? { ...inv.global, allowedHttpHookUrls: inv.global.allowedHttpHookUrls.map(() => "<redacted>") }
      : inv.global,
    projects: inv.projects.map((x) => proj(x)),
    hooks: inv.hooks.map((h) => ({
      id: h.id,
      event: h.event,
      matcher: h.matcher ?? null,
      type: h.handler.type,
      owner: { ...h.owner, project: proj(h.owner.project) },
      file: redact ? (h.owner.project ? h.file.replace(h.owner.project, proj(h.owner.project)!) : p(h.file)) : h.file,
      handler: redact ? redactValue(h.raw, "", home) : h.raw,
    })),
    mods: inv.mods.map((m) => ({ ...m, dir: p(m.dir) })),
    findings: redact ? findings.map((f) => ({ ...f, message: p(f.message) })) : findings,
    sources: inv.sources.map((s) => ({ ...s, path: redact ? p(s.path) : s.path })),
    parseErrors: inv.parseErrors.map((e) => ({ ...e, file: p(e.file) })),
  };
  let text = JSON.stringify(report, null, 2);
  if (redact) {
    // Longest first, so a nested project isn't half-replaced by its parent.
    for (const pr of [...inv.projects].sort((x, y) => y.length - x.length)) text = text.split(pr).join(proj(pr)!);
    if (home && home !== "/") text = text.split(home).join("~");
  }
  return text;
}
