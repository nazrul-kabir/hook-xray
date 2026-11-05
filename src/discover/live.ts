import { Handler } from "../schema.js";
import type { Inventory, Owner } from "../types.js";
import { obj, readJson } from "./fs.js";

/**
 * Adds hooks from a snapshot the hook-xray-live mod wrote with `/hook-xray --save <file>`.
 * The snapshot holds what this session got from --settings / SDK inline settings ("flag") and
 * managed policy ("policy"), including MDM, registry and server-managed tiers that aren't files.
 */
export function addLiveSnapshot(inv: Inventory, file: string): void {
  const r = readJson(file);
  inv.sources.push({ path: file, kind: "note", found: r.ok, note: "live snapshot from /hook-xray --save" });
  if (!r.ok) {
    inv.parseErrors.push({ file, error: r.missing ? "live snapshot not found" : (r.error ?? "unreadable") });
    return;
  }
  const snap = obj(r.value);
  if (snap.tool !== "hook-xray-live" || !Array.isArray(snap.hooks)) {
    inv.parseErrors.push({ file, error: "not a hook-xray-live snapshot" });
    return;
  }
  for (const raw of snap.hooks.map(obj)) {
    const h = Handler.safeParse(raw.handler);
    if (!h.success || typeof raw.event !== "string") {
      inv.parseErrors.push({ file, error: `live hook ${String(raw.id)} doesn't match the hooks schema` });
      continue;
    }
    const source = raw.source === "policy" ? "policy" : raw.source === "flag" ? "flag" : String(raw.source);
    const owner: Owner =
      source === "policy"
        ? { kind: "managed", name: "live: managed policy" }
        : source === "flag"
          ? { kind: "flag", name: "live: --settings / SDK" }
          : { kind: source === "user" || source === "project" || source === "local" ? source : "flag", name: `live: ${source}` };
    inv.hooks.push({
      id: `h${inv.hooks.length + 1}`,
      event: raw.event,
      matcher: typeof raw.matcher === "string" ? raw.matcher : undefined,
      handler: h.data,
      owner,
      file,
      raw: raw.handler,
    });
  }
}
