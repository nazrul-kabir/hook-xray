import type { HookRecord, Inventory } from "../types.js";

const TOKEN = /\b(?:sk|pk|ghp|gho|ghs|xox[abpr]|AKIA|eyJ)[A-Za-z0-9_\-.]{8,}|\b[A-Fa-f0-9]{32,}\b|\b[A-Za-z0-9+_-]{40,}={0,2}/g;
const BEARER = /\b(Bearer|Basic|token)\s+[^\s"']+/gi;
const ASSIGN = /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASS|AUTH|CREDENTIALS?))=("[^"]*"|'[^']*'|\S+)/g;
const URL_RE = /\bhttps?:\/\/[^\s"'<>]+/g;

/** Masks a URL to its scheme and path shape: host, credentials and query are hidden. */
export function redactUrl(u: string): string {
  try {
    const url = new URL(u);
    const path = url.pathname.split("/").map((seg) => (seg.length > 24 ? "<id>" : seg)).join("/");
    return `${url.protocol}//<host>${path}${url.search ? "?<query>" : ""}`;
  } catch {
    return "<url>";
  }
}

export function redactText(s: string, home: string): string {
  let out = s.replace(URL_RE, redactUrl);
  out = out.replace(BEARER, (_m, kind) => `${kind} <redacted>`);
  out = out.replace(ASSIGN, (_m, k) => `${k}=<redacted>`);
  out = out.replace(TOKEN, "<redacted>");
  if (home && home !== "/") out = out.split(home).join("~");
  return out;
}

/** Deep-redacts a handler or any JSON value. Header and env values, prompts and MCP inputs are hidden outright. */
export function redactValue(v: unknown, key: string, home: string): unknown {
  if (typeof v === "string") {
    if (key === "url") return redactUrl(v);
    if (key === "prompt") return `<prompt, ${v.length} chars>`;
    return redactText(v, home);
  }
  if (Array.isArray(v)) return v.map((x) => redactValue(x, key, home));
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      if (k === "headers" || k === "env") {
        o[k] = Object.fromEntries(Object.keys(val as object).map((h) => [h, "<redacted>"]));
      } else if (k === "input") {
        o[k] = "<redacted>";
      } else o[k] = redactValue(val, k, home);
    }
    return o;
  }
  return v;
}

/**
 * Redacts one string: project paths shrink to …/<last folder> (longest first, so a nested project isn't
 * half-replaced by its parent), then secrets, hosts and the home folder are masked. Works on raw strings,
 * so call it before JSON.stringify, where backslashes are already escaped.
 */
export function pathRedactor(projects: string[], home: string): (s: string) => string {
  const sorted = [...projects].sort((a, b) => b.length - a.length);
  return (s) => {
    for (const p of sorted) s = s.split(p).join(`…/${p.split(/[\\/]/).filter(Boolean).pop()}`);
    return redactText(s, home);
  };
}

/** Applies f to every string in a JSON-like value, keys untouched. */
export function mapStrings(v: unknown, f: (s: string) => string): unknown {
  if (typeof v === "string") return f(v);
  if (Array.isArray(v)) return v.map((x) => mapStrings(x, f));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapStrings(x, f)]));
  return v;
}

export interface Redactor {
  /** Any string: project paths, secrets, hosts, home. Off mode: only home → ~ */
  text(s: string): string;
  /** URL → https://<host>/path?<query>. Off mode: unchanged */
  url(u: string): string;
  /**
   * Any JSON-like value; keys untouched, strings through text(). Off mode is the identity: unlike text(),
   * it does NOT apply home → ~ (today's --json shows raw values).
   */
  value<T>(v: T): T;
  handler: {
    /** what the terminal prints for "what runs" */
    line(h: HookRecord): string;
    /** what --json prints as hooks[].handler */
    value(h: HookRecord): unknown;
  };
}

export function makeRedactor(inv: Pick<Inventory, "home" | "projects">, o: { on: boolean }): Redactor {
  const { home } = inv;
  const mask = pathRedactor(inv.projects, home);
  const text = (s: string) => (o.on ? mask(s) : home && home !== "/" ? s.split(home).join("~") : s);
  const url = (u: string) => (o.on ? redactUrl(u) : u);
  return {
    text,
    url,
    value: <T>(v: T) => (o.on ? (mapStrings(v, mask) as T) : v),
    handler: {
      line(h) {
        const x = h.handler;
        switch (x.type) {
          case "command":
            return text([x.command, ...(x.args ?? [])].join(" "));
          case "http":
            return url(x.url);
          case "mcp_tool":
            return `${x.server} → ${x.tool}`;
          case "prompt":
          case "agent":
            return o.on ? `<prompt, ${x.prompt.length} chars>` : JSON.stringify(x.prompt.slice(0, 60) + (x.prompt.length > 60 ? "…" : ""));
        }
      },
      value: (h) => (o.on ? redactValue(mapStrings(h.raw, mask), "", home) : h.raw),
    },
  };
}
