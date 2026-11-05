import { homedir } from "node:os";

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

export function redactText(s: string, home = homedir()): string {
  let out = s.replace(URL_RE, redactUrl);
  out = out.replace(BEARER, (_m, kind) => `${kind} <redacted>`);
  out = out.replace(ASSIGN, (_m, k) => `${k}=<redacted>`);
  out = out.replace(TOKEN, "<redacted>");
  if (home && home !== "/") out = out.split(home).join("~");
  return out;
}

/** Deep-redacts a handler or any JSON value. Header and env values, prompts and MCP inputs are hidden outright. */
export function redactValue(v: unknown, key = "", home = homedir()): unknown {
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
