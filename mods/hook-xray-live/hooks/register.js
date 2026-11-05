// hook-xray live view. Read-only: it reads settings through the mods API and writes a file
// only when you pass --save. It never runs, edits or disables a hook.
import { ALL_SOURCES, LIVE_SOURCES, buildReport, parseArgs, render } from "./lint.js";

const VERSION = "0.1.0";

/** @type {import('claude-code').Register} */
export function register(on) {
  on("session.start", async ($, e, next) => {
    await $.command.register({
      name: "hook-xray",
      description: "List hooks injected by --settings/SDK and managed policy, with findings (read-only)",
      argumentHint: "[all] [save [file]]",
    });
    return next(e);
  });

  on("command.run", { command: "hook-xray" }, async ($, e) => {
    const args = parseArgs(e.args);
    if (args.unknown.length) {
      return { text: `hook-xray: unknown argument ${args.unknown.join(" ")}. Usage: /hook-xray [all] [save [file]]` };
    }
    // Always read every source so the default view can say what it isn't showing.
    const perSource = [];
    for (const source of ALL_SOURCES) {
      const settings = await $.settings.read({ source });
      perSource.push({ source, settings });
    }
    const merged = await $.settings.read();
    const report = buildReport(perSource, merged, VERSION, args.all ? ALL_SOURCES : LIVE_SOURCES);
    if (args.save) {
      await $.fs.write(args.save, JSON.stringify(report, null, 2) + "\n");
    }
    // No `context`: the output is for you, not the model.
    return { text: render(report, args.save) };
  });
}
