# hook-xray

A free, open-source, local CLI that shows which Claude Code hooks and mods are configured, who owns them, and which configuration mistakes they have. Plus a companion mod (`mods/hook-xray-live`) for settings a disk scan can't see.

## Read first

- `docs/plan-0.1.0.md`: the current work. Follow its steps in order and update its Status table as you go.
- `docs/context.md`: verified facts about Claude Code behavior (with sources), product decisions, and claims that are **not** verified. Check it before stating or encoding any Claude Code behavior.
- `roadmap.md`: longer-term plan; `docs/plan-0.1.0.md` wins where they differ.

## Rules

- **Read-only product.** hook-xray never runs a hook, starts an MCP server, edits settings or makes a network request. The only subprocess is `claude plugin validate --json`, which is static.
- **Never parse mod JavaScript.** Mod facts come only from `claude plugin validate`. If it's unavailable, report "present, validation unavailable".
- **Confidence is part of every finding.** `certain` only for facts from config; anything read from script contents is `likely`.
- **Don't change analysis while changing presentation.** `test/findings.baseline.json` must keep passing. Never regenerate it to make a test pass; fix the change instead.
- **JSON output is additive.** Add fields; don't rename or remove.
- **Redaction applies everywhere** under `--redact`: terminal, JSON, grouped notes, errors. Test with Windows paths too (backslashes), and check parsed JSON values, not raw text.
- **Don't encode a Claude Code behavior that's only in the "Unverified" list** of `docs/context.md`.

## Commands

```bash
npm test            # vitest, fixture-driven; never executes fixture hooks
npm run test:mod    # claude plugin test + validate for mods/hook-xray-live
npm run typecheck
npm run build       # tsc → dist/
npx tsx src/cli.ts --all-projects --sources   # run on this machine
```

In PowerShell, `npm run dev -- <flags>` can drop the flags; call `npx tsx src/cli.ts <flags>` directly.

## Layout

- `src/discover/`: sources (`index.ts`), file helpers (`fs.ts`), mods via `claude plugin validate` (`mods.ts`), live snapshots (`live.ts`)
- `src/lint/rules.ts`: all lint rules and the Claude Code facts they rely on
- `src/report/`: terminal, JSON, summary, redaction
- `test/`: `fixture.ts` builds a fake machine in a temp folder; `baseline.ts` + `findings.baseline.json` guard the analysis
- `mods/hook-xray-live/`: the companion mod; `hooks/lint.js` duplicates the config-only rules (known debt, see roadmap)

Stack: TypeScript, Node ≥ 20, ESM, zod, commander, picocolors, yaml, vitest.

## Git

- Work in chunks: one plan step (or one bug fix) per commit, with tests and README updated in that same commit.
- **Never push**, never add a remote, never publish to npm. The maintainer decides when to push.
- Show `git status` and the proposed commit message before committing if the user hasn't said to commit.
