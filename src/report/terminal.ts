import { isAbsolute, relative } from "node:path";
import pc from "picocolors";
import type { Finding, HookRecord, Inventory, ModRecord } from "../types.js";
import { defaultTimeout, where } from "../lint/rules.js";
import { groupFindings } from "./group.js";
import { redactText, redactUrl } from "./redact.js";
import type { Summary } from "./summary.js";

const ICON = { attention: pc.red("✖"), warning: pc.yellow("⚠"), info: pc.cyan("ℹ") } as const;

export interface TerminalOptions {
  redact: boolean;
  showSources: boolean;
  /** list every hook behind each collapsed note */
  expand?: boolean;
  /** set when --event filtered the hooks; mods are not scanned then, so the Mods section is skipped */
  event?: string;
  version: string;
}

const n = (c: number, w: string) => `${c} ${w}${c === 1 ? "" : "s"}`;
const clip = (s: string, len: number) => (s.length > len ? s.slice(0, len - 1) + "…" : s);
const head = (s: string) => pc.bold(pc.underline(s));

export function renderTerminal(inv: Inventory, findings: Finding[], summary: Summary, o: TerminalOptions): string {
  const out: string[] = [];
  const width = Math.max(80, Math.min(process.stdout.columns ?? 100, 140));
  const hooks = new Map(inv.hooks.map((h) => [h.id, h] as const));
  const scratchSet = new Set(inv.projectDetails.filter((d) => d.scratch).map((d) => d.path));
  const scratch = (h: HookRecord) => !!h.owner.project && scratchSet.has(h.owner.project);

  // One helper for every message, fix, command and path: with --redact, project paths shrink to …/<folder>
  // and secrets, hosts and the home folder are masked; otherwise the home folder becomes ~.
  const projects = [...inv.projects].sort((a, b) => b.length - a.length);
  const r = (s: string) => {
    if (!o.redact) return inv.home && inv.home !== "/" ? s.split(inv.home).join("~") : s;
    for (const p of projects) s = s.split(p).join(`…/${p.split(/[\\/]/).filter(Boolean).pop()}`);
    return redactText(s, inv.home);
  };
  const owner = (h: HookRecord) => r(where(h, o.redact, scratch(h)));
  const isPlugin = (h?: HookRecord) => h?.owner.kind === "plugin";

  const whatRuns = (h: HookRecord): string => {
    const x = h.handler;
    switch (x.type) {
      case "command":
        return r([x.command, ...(x.args ?? [])].join(" "));
      case "http":
        return o.redact ? redactUrl(x.url) : x.url;
      case "mcp_tool":
        return `${x.server} → ${x.tool}`;
      case "prompt":
      case "agent":
        return o.redact ? `<prompt, ${x.prompt.length} chars>` : JSON.stringify(x.prompt.slice(0, 60) + (x.prompt.length > 60 ? "…" : ""));
    }
  };

  const hookLine = (h: HookRecord) => {
    const matcher = h.matcher ? pc.magenta(`[${h.matcher}]`) + " " : "";
    const timeout = h.handler.timeout === undefined ? pc.dim(`${defaultTimeout(h)}s default`) : `${h.handler.timeout}s`;
    return `${pc.dim(h.id.padEnd(4))} ${h.event} ${matcher}${pc.cyan(h.handler.type)} ${pc.dim("·")} ${owner(h)} ${pc.dim("·")} ${timeout}`;
  };

  /** One block per finding: hook line, what it runs, message, fix, ownership line. */
  const block = (f: Finding) => {
    const h = hooks.get(f.hookId ?? "");
    if (!h) return;
    const tag = f.confidence === "likely" ? pc.dim(" (likely)") : "";
    out.push(`  ${ICON[f.severity]} ${hookLine(h)}`);
    out.push(`       ${clip(whatRuns(h), width - 8)}`);
    out.push(`       ${r(f.message)}${tag}`);
    if (f.fix) out.push(pc.dim(`       fix: ${r(f.fix)}`));
    if (isPlugin(h)) out.push(pc.dim("       Plugin-owned: report it to the author; disable the plugin if the behavior is unwanted."));
    out.push("");
  };

  // Header
  const nScratch = scratchSet.size;
  const plugins = new Set([...inv.hooks.filter(isPlugin).map((h) => h.owner.name), ...inv.mods.map((m) => m.plugin)]).size;
  out.push(pc.bold(`hook-xray ${o.version}`) + pc.dim("  · read-only, nothing was executed"));
  out.push(
    [n(summary.hooks, "hook"), n(plugins, "plugin"), n(summary.mods, "mod"), n(summary.projects, "project") + (nScratch ? ` (${nScratch} scratch)` : "")].join(" · "),
  );
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
  const top = summary.lines.filter((l) => !l.startsWith("  "));
  out.push(...(top.length ? top : [pc.green("No findings.")]), "");

  const grouped = groupFindings(inv, findings);

  if (grouped.blocking.length) {
    out.push(head("Never runs or runs twice"));
    grouped.blocking.forEach(block);
  }
  if (grouped.warnings.length) {
    out.push(head("Warnings"));
    grouped.warnings.forEach(block);
  }

  if (!o.event) {
    out.push(head("Mods"));
    if (inv.mods.length) for (const m of inv.mods) out.push(...renderMod(m, findings, r));
    else out.push("  No mods found.");
    out.push("");
  }

  if (grouped.notes.length) {
    out.push(head("Notes"));
    for (const note of grouped.notes) {
      const tag = note.confidence === "likely" ? pc.dim(" (likely)") : "";
      out.push(`  ${ICON.info} ${r(note.message)}${tag}`);
      out.push(pc.dim(`       ${n(note.hookIds.length, "hook")}: ${note.owners.map((x) => `${r(x.label)} ×${x.count}`).join(", ")}`));
      if (note.fix) out.push(pc.dim(`       fix: ${r(note.fix)}`));
      const plugged = note.owners.filter((x) => x.plugin).length;
      if (plugged === note.owners.length) out.push(pc.dim("       Plugin-owned: report it to the author."));
      else if (plugged) out.push(pc.dim("       Plugin-owned ones: report them to the author."));
      if (o.expand)
        for (const id of note.hookIds) {
          const h = hooks.get(id);
          if (h) out.push(`         ${pc.dim(h.id.padEnd(4))} ${h.event} ${pc.dim("·")} ${owner(h)}`);
        }
    }
    out.push("");
  }

  // Hooks by owner: your own config first, then each plugin.
  if (inv.hooks.length) {
    out.push(head("Hooks by owner"));
    const byOwner = new Map<string, HookRecord[]>();
    for (const h of [...inv.hooks].sort((a, b) => Number(isPlugin(a)) - Number(isPlugin(b)))) {
      const k = owner(h);
      byOwner.set(k, [...(byOwner.get(k) ?? []), h]);
    }
    for (const [label, hs] of byOwner) {
      out.push(`  ${pc.bold(label)}`);
      for (const h of hs) {
        const matcher = h.matcher ? pc.magenta(`[${h.matcher}]`) + " " : "";
        out.push(`    ${pc.dim(h.id.padEnd(4))} ${h.event} ${matcher}${pc.cyan(h.handler.type)} ${pc.dim("·")} ${clip(whatRuns(h), width - 40)}`);
      }
    }
    out.push("");
  }

  if (inv.parseErrors.length) {
    out.push(head("Could not read"));
    const label = { unreadable: "unreadable", invalid: "invalid JSON", schema: "schema error" } as const;
    for (const kind of ["unreadable", "invalid", "schema"] as const)
      for (const e of inv.parseErrors.filter((x) => (x.kind ?? "invalid") === kind))
        out.push(`  ${pc.red("✖")} ${pc.dim(label[kind].padEnd(13))} ${r(e.file)}: ${r(e.error)}`);
    out.push("");
  }

  const found = inv.sources.filter((s) => s.found).length;
  if (o.showSources) {
    out.push(head("Sources"));
    const mark = { found: pc.green("✓"), unreadable: pc.red("✖"), invalid: pc.red("✖"), missing: pc.dim("–") } as const;
    for (const s of inv.sources.filter((x) => o.expand || x.status !== "missing")) {
      const status = s.status === "found" ? "" : pc.dim(` [${s.status}]`);
      out.push(`  ${mark[s.status]} ${pc.dim(s.kind.padEnd(13))} ${r(s.path)}${status}${s.note ? pc.dim(`  (${r(s.note)})`) : ""}`);
    }
    out.push("");
    // A source belongs to the longest project path that prefixes it.
    const inside = (proj: string, file: string) => {
      const rel = relative(proj, file);
      return !rel.startsWith("..") && !isAbsolute(rel);
    };
    const withConfig = new Set(
      inv.sources
        .filter((x) => x.found && ["project", "local", "skill", "agent"].includes(x.kind))
        .map((s) => projects.find((p) => inside(p, s.path))),
    );
    withConfig.delete(undefined);
    const np = inv.projects.length;
    out.push(
      `${n(np, "project")} checked: ${withConfig.size} with .claude config, ${np - withConfig.size} without` +
        (nScratch ? `, ${n(nScratch, "scratch workspace")} (temporary)` : ""),
    );
    const withHooks = new Set(inv.hooks.filter(isPlugin).map((h) => h.owner.name?.replace(/ \(disabled\)$/, "")));
    const withHooksN = inv.pluginNames.filter((x) => withHooks.has(x)).length;
    out.push(`${n(inv.pluginNames.length, "plugin")}: ${withHooksN} with hooks, ${inv.pluginNames.length - withHooksN} without (normal)`);
    out.push(`managed settings: ${inv.sources.some((x) => x.kind === "managed" && x.found) ? "found" : "none found"}`);
  } else {
    out.push(pc.dim(`${found} of ${inv.sources.length} sources present · --sources for details · --json for everything`));
  }
  return out.join("\n");
}

function renderMod(m: ModRecord, findings: Finding[], r: (s: string) => string): string[] {
  const lines = [`  ${pc.dim(m.id.padEnd(4))} ${pc.bold(m.plugin)} ${pc.dim(`(${m.origin}) · ${r(m.dir)}`)}`];
  const v = m.validation;
  if (!v.ok) {
    lines.push(`       ${ICON.info} validation unavailable: ${r(v.reason)}`);
    return lines;
  }
  const row = (label: string, xs: string[]) => xs.length && lines.push(`       ${pc.dim(label.padEnd(12))} ${xs.join(", ")}`);
  row("hooks", v.hooks);
  row("calls", v.calls);
  row("env reads", v.envReads);
  row("env writes", v.envWrites);
  row("state reads", v.stateReads);
  row("state writes", v.stateWrites);
  for (const f of findings.filter((f) => f.modId === m.id && f.rule !== "mod-unvalidated")) lines.push(`       ${ICON[f.severity]} ${r(f.message)}`);
  return lines;
}
