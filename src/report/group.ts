import type { Confidence, Finding, HookRecord, Inventory } from "../types.js";
import { where } from "../lint/rules.js";
import { NEVER_RUNS } from "./summary.js";

export interface NoteGroup {
  rule: string;
  message: string;
  fix?: string;
  why?: string;
  confidence: Confidence;
  hookIds: string[];
  /** "lint-kit ×2, deploy-tools ×1" */
  owners: { label: string; count: number; plugin: boolean }[];
}

export interface Grouped {
  /** hooks that never run, or run twice: one per finding */
  blocking: Finding[];
  /** other warning/attention hook findings: one per finding, never collapsed */
  warnings: Finding[];
  modFindings: Finding[];
  /** info hook findings, collapsed by rule + exact message */
  notes: NoteGroup[];
}

const isBlocking = (f: Finding) => NEVER_RUNS.has(f.rule) || f.rule === "double-run-copy";

/** Pure: groups findings for display. Does not change which findings exist. */
export function groupFindings(inv: Inventory, findings: Finding[]): Grouped {
  const hooks = new Map<string, HookRecord>(inv.hooks.map((h) => [h.id, h]));
  const isPlugin = (id?: string) => (id && hooks.get(id)?.owner.kind === "plugin" ? 1 : 0);
  const event = (id?: string) => (id && hooks.get(id)?.event) || "";
  // user's own config first, then plugins; then by event. Array.sort is stable.
  const order = (a: Finding, b: Finding) =>
    isPlugin(a.hookId) - isPlugin(b.hookId) || event(a.hookId).localeCompare(event(b.hookId));

  const blocking: Finding[] = [];
  const warnings: Finding[] = [];
  const modFindings: Finding[] = [];
  const noteMap = new Map<string, Finding[]>();

  for (const f of findings) {
    if (f.modId) modFindings.push(f);
    else if (!f.hookId) continue; // ponytail: no rule emits global findings today; add a bucket when one does
    else if (isBlocking(f)) blocking.push(f);
    else if (f.severity === "info") {
      const k = `${f.rule}\0${f.message}`;
      noteMap.set(k, [...(noteMap.get(k) ?? []), f]);
    } else warnings.push(f);
  }

  const notes: NoteGroup[] = [...noteMap.values()].map((fs) => {
    fs.sort(order);
    const counts = new Map<string, { label: string; count: number; plugin: boolean }>();
    for (const f of fs) {
      const h = hooks.get(f.hookId!);
      const plugin = h?.owner.kind === "plugin";
      const label = h ? (plugin ? (h.owner.name ?? "plugin") : where(h, true)) : "unknown";
      const c = counts.get(label) ?? { label, count: 0, plugin };
      c.count++;
      counts.set(label, c);
    }
    const first = fs[0]!;
    return {
      rule: first.rule,
      message: first.message,
      fix: first.fix,
      why: first.why,
      confidence: fs.some((f) => f.confidence === "likely") ? "likely" : "certain",
      hookIds: fs.map((f) => f.hookId!),
      owners: [...counts.values()],
    };
  });
  notes.sort((a, b) => b.hookIds.length - a.hookIds.length || a.rule.localeCompare(b.rule));

  return { blocking: blocking.sort(order), warnings: warnings.sort(order), modFindings, notes };
}
