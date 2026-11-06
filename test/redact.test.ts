import { describe, expect, it } from "vitest";
import { makeRedactor } from "../src/report/redact.js";
import type { HookRecord } from "../src/types.js";
import { baselineScan } from "./baseline.js";

const win = { home: "C:\\Users\\u", projects: ["C:\\Users\\u\\work\\app", "C:\\Users\\u\\work\\app\\sub"] };
const hook = (handler: any): HookRecord =>
  ({ id: "h1", event: "Stop", handler, owner: { kind: "user", name: "user" }, file: "f", raw: handler }) as HookRecord;

describe("makeRedactor", () => {
  it("masks Windows project paths in text() and in parsed JSON values", () => {
    const rd = makeRedactor(win, { on: true });
    expect(rd.text("C:\\Users\\u\\work\\app\\x.sh")).toBe("…/app\\x.sh");
    const parsed = JSON.parse(JSON.stringify(rd.value({ a: ["C:\\Users\\u\\work\\app\\x.sh"] })));
    expect(parsed.a[0]).toBe("…/app\\x.sh");
    expect(JSON.stringify(parsed)).not.toContain("Users");
  });

  it("nested projects: the longest wins", () => {
    const rd = makeRedactor(win, { on: true });
    expect(rd.text("C:\\Users\\u\\work\\app\\sub\\y.sh")).toBe("…/sub\\y.sh");
  });

  it("home becomes ~ in text() in both modes", () => {
    const inv = { home: "/home/u", projects: [] };
    expect(makeRedactor(inv, { on: true }).text("/home/u/a")).toBe("~/a");
    expect(makeRedactor(inv, { on: false }).text("/home/u/a")).toBe("~/a");
  });

  it("off mode: value() is the identity (no home → ~), url() unchanged", () => {
    const rd = makeRedactor({ home: "/home/u", projects: [] }, { on: false });
    const v = { p: "/home/u/a" };
    expect(rd.value(v)).toBe(v);
    expect(rd.url("https://h.io/a?b=1")).toBe("https://h.io/a?b=1");
  });

  it("handler.line", () => {
    const inv = { home: "/home/u", projects: [] };
    const on = makeRedactor(inv, { on: true }).handler;
    const off = makeRedactor(inv, { on: false }).handler;
    const long = "x".repeat(70);
    expect(on.line(hook({ type: "command", command: "node", args: ["/home/u/a.js"] }))).toBe("node ~/a.js");
    expect(on.line(hook({ type: "http", url: "https://h.io/a?b=1" }))).toBe("https://<host>/a?<query>");
    expect(off.line(hook({ type: "http", url: "https://h.io/a?b=1" }))).toBe("https://h.io/a?b=1");
    expect(on.line(hook({ type: "mcp_tool", server: "s", tool: "t" }))).toBe("s → t");
    expect(on.line(hook({ type: "prompt", prompt: "hello" }))).toBe("<prompt, 5 chars>");
    expect(on.line(hook({ type: "agent", prompt: long }))).toBe("<prompt, 70 chars>");
    expect(off.line(hook({ type: "agent", prompt: long }))).toBe(JSON.stringify("x".repeat(60) + "…"));
    expect(off.line(hook({ type: "prompt", prompt: "hello" }))).toBe('"hello"');
  });

  it("handler.value keeps keys, hides header/env/input values on, untouched off", () => {
    const raw = { type: "http", url: "https://h.io/a?b=1", headers: { Authorization: "Bearer x" }, env: { K: "v" }, input: { a: 1 }, prompt: "hi" };
    const inv = { home: "/home/u", projects: [] };
    expect(makeRedactor(inv, { on: true }).handler.value(hook(raw))).toEqual({
      type: "http", url: "<url>" /* double pass, as today */, headers: { Authorization: "<redacted>" }, env: { K: "<redacted>" }, input: "<redacted>", prompt: "<prompt, 2 chars>",
    });
    expect(makeRedactor(inv, { on: false }).handler.value(hook(raw))).toBe(raw);
  });

  it("works on a real fixture inventory", () => {
    const { inv } = baselineScan(true);
    const rd = makeRedactor(inv, { on: true });
    const out = JSON.stringify(inv.hooks.map((h) => rd.handler.value(h)));
    expect(out).not.toContain("sk-live-abcdefghijklmnop");
  });
});
