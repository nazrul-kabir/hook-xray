# Plan: one Redactor module

**Origin:** architecture review, candidate 1. Presentation-only refactor. No analysis change, no output change.

**Decisions (assumed from the recommended answers; change here if you disagree):**

1. One factory in `src/report/redact.ts`: `makeRedactor(inv, { on })`. Off mode (`on: false`) uses the same factory, so the `home → ~` replacement that only `terminal.ts` does today moves in.
2. Two handler views built on the same masking primitives: `handler.line(h)` (terminal one-liner) and `handler.value(h)` (structured, for `--json`).
3. No `homedir()` defaults. `home` and `projects` come from the Inventory.
4. Out of scope: `where()` in `lint/rules.ts`, label logic in `report/group.ts`. Existing tests and `test/findings.baseline.json` stay untouched.

## Where it sits

Do this after plan step 8 of `docs/plan-0.1.0.md` (or on its own branch from `main`, e.g. `refactor/redactor`). It is not part of the 0.1.0 scope. Do not edit the 0.1.0 Status table for it.

## Target interface

```ts
// src/report/redact.ts
export interface Redactor {
  /** any string: project paths, secrets, hosts, home. Off mode: only home → ~ */
  text(s: string): string;
  /** URL → https://<host>/path?<query>. Off mode: unchanged */
  url(u: string): string;
  /** any JSON-like value; keys untouched, strings through text() */
  value<T>(v: T): T;
  handler: {
    line(h: HookRecord): string; // what terminal prints for "what runs"
    value(h: HookRecord): unknown; // what --json prints as hooks[].handler
  };
}
export function makeRedactor(inv: Pick<Inventory, "home" | "projects">, o: { on: boolean }): Redactor;
```

Keep exporting `redactText` and `redactUrl` (existing tests import them). `pathRedactor`, `mapStrings` and `redactValue` become internal.

## Steps (one commit each, tests + README in the same commit)

### 1. Add `makeRedactor`, no callers yet

- Implement on top of the existing functions. Remove the `homedir()` default from `redactText` and `redactValue` (they stay exported; make `home` required; update the one test call that relies on the default, if any).
- `handler.value(h)` must reproduce today's JSON exactly: `redact ? redactValue(mapStrings(h.raw, text), "", home) : h.raw`. Keep the double pass. `prompt` length is measured after path redaction today; preserve that.
- `handler.line(h)` must reproduce `whatRuns` in `terminal.ts` exactly, including `<prompt, N chars>` in redact mode and the 60-char JSON-quoted prompt in off mode.
- New file `test/redact.test.ts` against the interface (see Tests).
- Commit: `refactor(report): add makeRedactor`

### 2. Switch `json.ts`

- Replace `pathRedactor` / `mapStrings` / `redactValue` use with the Redactor. `const r = rd.value`, `proj`, `handler: rd.handler.value(h)`.
- `groupFindings(...).notes` and the `global.allowedHttpHookUrls` masking stay as they are; only the plumbing changes.
- Gate: `test/json.test.ts` and the redact assertions in `hook-xray.test.ts` pass unchanged.
- Commit: `refactor(report): json uses Redactor`

### 3. Switch `terminal.ts`

- Delete the local `redactAll`, `r` and `whatRuns`. `r = rd.text`, `whatRuns = rd.handler.line`.
- The sorted `projects` array is still needed for the `--sources` summary. Leave it.
- Gate: `test/terminal.test.ts` passes unchanged.
- Commit: `refactor(report): terminal uses Redactor`

### 4. Remove dead exports

- Un-export `pathRedactor`, `mapStrings`, `redactValue` if nothing else imports them (`Grep` first).
- Commit: `refactor(report): hide redaction primitives`

## Tests (`test/redact.test.ts`, step 1)

Build with `fixture.ts`; assert on the **parsed** Redactor output, not raw text.

| Case | Expect |
|---|---|
| Windows project path `C:\Users\u\work\app\x.sh` in `text()` | `…/app\x.sh`, no `C:\Users` left |
| Same path after `JSON.parse(JSON.stringify(rd.value(...)))` | still no original path |
| Nested projects (`work/app` and `work/app/sub`) | longest wins, no half-replaced parent |
| Home path | `~` in both on and off modes |
| `handler.line` for command / http / mcp_tool / prompt / agent | on: URL masked, prompt `<prompt, N chars>`; off: raw URL, prompt clipped at 60 |
| `handler.value` with `headers`, `env`, `input` | keys kept, values `<redacted>` (on); untouched (off) |
| Off mode `value()` | identity except `home → ~` is **not** applied to JSON (today JSON off-mode returns raw; keep that: `value` is identity when `on` is false) |

Last row matters: off-mode `text()` applies `~`, off-mode `value()` does not. Today's behavior; preserve it, document it on the interface.

## Gates for every step

- `npm test`, `npm run typecheck`, `npm run build` green.
- `test/findings.baseline.json` unchanged (`git diff --stat` must not list it).
- Snapshot check, once before step 2 and once after step 3: run `npx tsx src/cli.ts --all-projects --sources --redact` and `... --json --redact` on this machine, save both to the scratchpad, diff. Must be empty.
- JSON stays additive: no field renamed or removed.

## Glossary

Add `GLOSSARY.md` when step 1 lands, with **Redactor** (masks paths, secrets, hosts, prompts and home in one pass; same interface on and off) and **Redaction** (the user-facing `--redact` behavior).

## Risks

- Off-mode asymmetry above (`text` applies `~`, `value` doesn't) is easy to "fix" by accident. Test it.
- Double redaction in `handler.value` is intentional (path pass, then key-aware pass). Collapsing it can change `<prompt, N chars>` counts.
- CLAUDE.md: don't commit on `step-6-additive-json`. Branch from `main` after that work is merged.
