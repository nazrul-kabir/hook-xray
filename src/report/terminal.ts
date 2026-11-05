import pc from "picocolors";
import type { Finding, HookRecord, Inventory, ModRecord } from "../types.js";
import { defaultTimeout, where } from "../lint/rules.js";
import { redactText, redactUrl } from "./redact.js";
import type { Summary } from "./summary.js";

const ICON = { attention: pc.red("✖"), warning: pc.yellow("⚠"), info: pc.cyan("ℹ") } as const;

export interface TerminalOptions {
  redact: boolean;
  showSources: boolean;
  version: string;
}

let HOME = "";
function tilde(s: string) {
  const h = HOME;
  return h && h !== "/" ? s.split(h).join("~") : s;
}

function whatRuns(h: HookRecord, redact: boolean): string {
  const x = h.handler;
  const r = (s: string) => (redact ? redactText(s, HOME) : tilde(s));
  switch (x.type) {
    case "command":
      return r([x.command, ...(x.args ?? [])].join(" "));
    case "http":
      return redact ? redactUrl(x.url) : x.url;
    case "mcp_tool":
      return `${x.server} → ${x.tool}`;
    case "prompt":
    case "agent":
      return redact ? `<prompt, ${x.prompt.length} chars>` : JSON.stringify(x.prompt.slice(0, 60) + (x.prompt.length > 60 ? "…" : ""));
  }
}

function clip(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

export function renderTerminal(inv: Inventory, findings: Finding[], summary: Summary, o: TerminalOptions): string {
  HOME = inv.home;
  const out: string[] = [];
  const width = Math.max(80, Math.min(process.stdout.columns ?? 100, 140));

  out.push(pc.bold(`hook-xray ${o.version}`) + pc.dim("  · read-only, nothing was executed"));
  out.push("");
  const nScratch = inv.projectDetails.filter((d) => d.scratch).length;
  const pj = (summary.projects === 1 ? "1 project" : `${summary.projects} projects`) + (nScratch ? ` (${nScratch} scratch)` : "");
  const scratchSet = new Set(inv.projectDetails.filter((d) => d.scratch).map((d) => d.path));
  const scratch = (h: { owner: { project?: string } }) => !!h.owner.project && scratchSet.has(h.owner.project);
  const n = (c: number, w: string) => `${c} ${w}${c === 1 ? "" : "s"}`;
  out.push(pc.bold(`${n(summary.hooks, "hook")} and ${n(summary.mods, "mod")} found across ${pj}`));

  const g = inv.global;
  if (g.disableAllHooks?.value)
    out.push(
      pc.yellow(
        g.disableAllHooks.from === "managed"
          ? "disableAllHooks is on (from managed settings): no hooks run, managed ones included"
          : `disableAllHooks is on (from ${g.disableAllHooks.from}): only managed hooks run`,
      ),
    );
  if (g.allowManagedHooksOnly) out.push(pc.yellow("allowManagedHooksOnly is on: user, project, local and plugin hooks don't run"));
  if (g.allowedHttpHookUrls) out.push(pc.dim(`allowedHttpHookUrls is set (${n(g.allowedHttpHookUrls.length, "pattern")})`));
  out.push("");
  if (summary.lines.length) {
    for (const l of summary.lines) out.push(l.startsWith("  ") ? pc.dim(l) : l);
  } else out.push(pc.green("No findings."));
  out.push("");

  // Hooks grouped by event, findings under each hook.
  const byHook = new Map<string, Finding[]>();
  for (const f of findings) if (f.hookId) byHook.set(f.hookId, [...(byHook.get(f.hookId) ?? []), f]);
  const events = [...new Set(inv.hooks.map((h) => h.event))].sort();
  for (const ev of events) {
    out.push(pc.bold(pc.underline(ev)));
    for (const h of inv.hooks.filter((x) => x.event === ev)) {
      const matcher = h.matcher ? pc.magenta(`[${h.matcher}]`) + " " : "";
      const timeout = h.handler.timeout ?? defaultTimeout(h);
      const tlabel = h.handler.timeout === undefined ? pc.dim(`${timeout}s default`) : `${timeout}s`;
      const head = `  ${pc.dim(h.id.padEnd(4))} ${matcher}${pc.cyan(h.handler.type)} ${pc.dim("·")} ${o.redact ? where(h, true, scratch(h)) : tilde(where(h, false, scratch(h)))} ${pc.dim("·")} ${tlabel}`;
      out.push(head);
      out.push(`       ${clip(whatRuns(h, o.redact), width - 8)}`);
      const sorted = (byHook.get(h.id) ?? []).sort((a, b) => rank(b) - rank(a));
      for (const f of sorted) {
        const tag = f.confidence === "likely" ? pc.dim(" (likely)") : "";
        out.push(`       ${ICON[f.severity]} ${f.message}${tag}`);
        if (f.fix) out.push(pc.dim(`         fix: ${f.fix}`));
      }
    }
    out.push("");
  }

  if (inv.mods.length) {
    out.push(pc.bold(pc.underline("Mods")));
    for (const m of inv.mods) out.push(...renderMod(m, findings, o.redact));
    out.push("");
  }

  if (inv.parseErrors.length) {
    out.push(pc.bold(pc.underline("Could not read")));
    for (const e of inv.parseErrors) out.push(`  ${pc.red("✖")} ${tilde(e.file)}: ${e.error}`);
    out.push("");
  }

  if (o.showSources) {
    out.push(pc.bold(pc.underline("Sources scanned")));
    for (const s of inv.sources) {
      const mark = s.found ? pc.green("✓") : pc.dim("–");
      out.push(`  ${mark} ${pc.dim(s.kind.padEnd(13))} ${tilde(s.path)}${s.note ? pc.dim(`  (${s.note})`) : ""}`);
    }
  } else {
    const found = inv.sources.filter((s) => s.found).length;
    out.push(pc.dim(`${found} of ${inv.sources.length} sources present · --sources to list them · --json for the full report`));
  }
  return out.join("\n");
}

function renderMod(m: ModRecord, findings: Finding[], redact: boolean): string[] {
  const lines = [`  ${pc.dim(m.id.padEnd(4))} ${pc.bold(m.plugin)} ${pc.dim(`(${m.origin}) · ${redact ? redactText(m.dir, HOME) : tilde(m.dir)}`)}`];
  const v = m.validation;
  if (!v.ok) {
    lines.push(`       ${ICON.info} validation unavailable: ${v.reason}`);
    return lines;
  }
  const row = (label: string, xs: string[]) => xs.length && lines.push(`       ${pc.dim(label.padEnd(12))} ${xs.join(", ")}`);
  row("hooks", v.hooks);
  row("calls", v.calls);
  row("env reads", v.envReads);
  row("env writes", v.envWrites);
  row("state reads", v.stateReads);
  row("state writes", v.stateWrites);
  for (const f of findings.filter((f) => f.modId === m.id && f.rule !== "mod-unvalidated")) {
    lines.push(`       ${ICON[f.severity]} ${f.message}`);
  }
  return lines;
}

const rank = (f: Finding) => ({ attention: 2, warning: 1, info: 0 })[f.severity];
