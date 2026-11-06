#!/usr/bin/env node
import { Command } from "commander";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { defaultManagedDir, discover } from "./discover/index.js";
import { claudeValidator } from "./discover/mods.js";
import { addLiveSnapshot } from "./discover/live.js";
import { lint } from "./lint/rules.js";
import { renderJson } from "./report/json.js";
import { summarize } from "./report/summary.js";
import { renderTerminal } from "./report/terminal.js";

const version = (() => {
  try {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string;
  } catch {
    return "dev";
  }
})();

const program = new Command()
  .name("hook-xray")
  .description("X-ray every Claude Code hook and mod: source, owner, trigger and config mistakes. Read-only: never runs a hook.")
  .version(version)
  .option("--json", "print the full report as JSON")
  .option("--redact", "hide tokens, header and env values, hosts, prompts and home paths")
  .option("--event <name>", "only show hooks on this event, e.g. PreToolUse")
  .option("--all-projects", "also scan every project listed in ~/.claude.json")
  .option("--settings <file...>", "extra settings files to scan, like Claude Code's --settings flag")
  .option("--live <file>", "add hooks from a snapshot saved with /hook-xray --save in a running session")
  .option("--no-validate", "don't run `claude plugin validate` on mods")
  .option("--claude-bin <path>", "claude CLI used to validate mods", "claude")
  .option("--sources", "list every source path checked")
  .option("--expand", "list every hook behind each collapsed note, and every missing source with --sources")
  .option("--cwd <dir>", "project directory to scan", process.cwd())
  .option("--home <dir>", "home directory to scan (for testing)", homedir())
  .option("--managed-dir <dir>", "managed settings directory", defaultManagedDir());

program.parse();
const o = program.opts<{
  json?: boolean;
  redact?: boolean;
  event?: string;
  allProjects?: boolean;
  settings?: string[];
  live?: string;
  validate: boolean;
  claudeBin: string;
  sources?: boolean;
  expand?: boolean;
  cwd: string;
  home: string;
  managedDir: string;
}>();

const inv = discover({
  home: o.home,
  cwd: o.cwd,
  managedDir: o.managedDir,
  allProjects: !!o.allProjects,
  extraSettings: o.settings ?? [],
  validator: o.validate ? claudeValidator(o.claudeBin) : null,
});

if (o.live) addLiveSnapshot(inv, o.live);

let findings = lint(inv);
if (o.event) {
  inv.hooks = inv.hooks.filter((h) => h.event === o.event);
  const ids = new Set(inv.hooks.map((h) => h.id));
  findings = findings.filter((f) => (f.hookId ? ids.has(f.hookId) : false));
  inv.mods = [];
}
const summary = summarize(inv, findings);

process.stdout.write(
  (o.json
    ? renderJson(inv, findings, summary, version, !!o.redact)
    : renderTerminal(inv, findings, summary, { redact: !!o.redact, showSources: !!o.sources, expand: !!o.expand, event: o.event, version })) + "\n",
);
