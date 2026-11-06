import type { Handler } from "./schema.js";

export type SourceKind =
  | "user"
  | "project"
  | "local"
  | "managed"
  /** a file passed with --settings, as Claude Code's own --settings flag would load it */
  | "flag"
  | "plugin"
  | "skill"
  | "agent";

export interface Owner {
  kind: SourceKind;
  /** plugin name, skill name, agent name, or project label */
  name?: string;
  /** project path for project/local/skill/agent sources */
  project?: string;
}

export interface HookRecord {
  id: string;
  event: string;
  matcher?: string;
  handler: Handler;
  owner: Owner;
  /** file the hook was read from */
  file: string;
  /** absolute plugin root, used to resolve ${CLAUDE_PLUGIN_ROOT} */
  pluginRoot?: string;
  /** the handler exactly as configured, for --json */
  raw: unknown;
}

export interface ModRecord {
  id: string;
  plugin: string;
  dir: string;
  modules: string[];
  /** "plugin" for installed or --plugin-dir mods, "session" for ~/.claude/dev-mods */
  origin: "plugin" | "session";
  validation:
    | {
        ok: true;
        hooks: string[];
        calls: string[];
        envReads: string[];
        envWrites: string[];
        stateReads: string[];
        stateWrites: string[];
        gatingWithoutCatch: string[];
        errors: string[];
      }
    | { ok: false; reason: string };
}

export interface GlobalState {
  disableAllHooks: { value: boolean; from?: string } | null;
  allowManagedHooksOnly: boolean;
  allowedHttpHookUrls: string[] | null;
}

export type SourceStatus = "found" | "missing" | "unreadable" | "invalid";

export interface ScannedSource {
  path: string;
  kind: SourceKind | "mods" | "global-config" | "note";
  found: boolean;
  status: SourceStatus;
  note?: string;
}

export type Severity = "info" | "warning" | "attention";
export type Confidence = "certain" | "likely";

export interface Finding {
  rule: string;
  severity: Severity;
  confidence: Confidence;
  hookId?: string;
  modId?: string;
  message: string;
  why?: string;
  fix?: string;
}

export interface Inventory {
  /** home directory that was scanned; redaction replaces it with ~ */
  home: string;
  hooks: HookRecord[];
  mods: ModRecord[];
  global: GlobalState;
  sources: ScannedSource[];
  projects: string[];
  parseErrors: { file: string; error: string; kind?: "unreadable" | "invalid" | "schema" }[];
}
