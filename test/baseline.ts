import { discover } from "../src/discover/index.js";
import { lint } from "../src/lint/rules.js";
import type { Finding, Inventory } from "../src/types.js";
import { buildFixture, fakeValidator } from "./fixture.js";

/** Findings reduced to fields that don't depend on temp paths or hook numbering. */
export function normalized(inv: Inventory, findings: Finding[]) {
  const key = (id?: string) => {
    const h = inv.hooks.find((x) => x.id === id);
    if (h) return `${h.event}|${h.owner.kind}:${h.owner.name ?? ""}|${h.handler.type}|${h.matcher ?? ""}`;
    const m = inv.mods.find((x) => x.id === id);
    return m ? `mod|${m.plugin}` : "global";
  };
  return findings
    .map((f) => `${key(f.hookId ?? f.modId)}|${f.rule}|${f.severity}|${f.confidence}`)
    .sort();
}

export function baselineScan(allProjects: boolean) {
  const fx = buildFixture();
  const inv = discover({
    home: fx.home,
    cwd: fx.project,
    managedDir: fx.managedDir,
    allProjects,
    extraSettings: [fx.flagFile],
    validator: fakeValidator,
  });
  return { fx, inv, findings: lint(inv) };
}
