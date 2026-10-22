#!/usr/bin/env node
/**
 * The product CLI entry point.
 *
 * Help and version run before any command handler, so a broken config or a
 * missing database cannot make the command table unreachable. Every expected
 * failure goes through the exit/JSON contract in `exit.ts`.
 */
import { MuninError } from "@munin/core";
import { parseArgs, wantsJson } from "./args.js";
import { findCommand } from "./commands.js";
import { errorPayload, exitCodeFor } from "./exit.js";
import { printHelp } from "./help.js";
import { err } from "./styles.js";
import { VERSION } from "./version.js";

function notImplemented(name: string): MuninError {
  return new MuninError({
    code: "cli.not-implemented",
    kind: "action",
    message: `munin ${name} is not wired yet. Run "munin help" to see the command table.`,
  });
}

async function main(argv: readonly string[]): Promise<void> {
  const args = parseArgs(argv);

  // Help wins over version and commands, and never loads source history.
  if (args.flags.help || args.command === "help") {
    const topic =
      args.command === "help" ? args.positional[0] : args.commandGiven ? args.command : undefined;
    printHelp(topic, args.flags);
    return;
  }

  if (args.flags.version || args.command === "version") {
    console.log(VERSION);
    return;
  }

  // Help and version are handled above. Every other invocation, including the
  // bare command, dispatches through the command table.
  const command = findCommand(args.command);
  if (command === undefined) {
    throw new MuninError({
      code: "cli.unknown-command",
      kind: "usage",
      message: `Unknown command "${args.command}". Run "munin help" to list commands.`,
    });
  }
  if (command.run === undefined) throw notImplemented(command.name);
  await command.run(args);
}

const argv = process.argv.slice(2);
const json = wantsJson(argv);

main(argv).catch((error: unknown) => {
  if (json) {
    process.stdout.write(`${JSON.stringify(errorPayload(error))}\n`);
  } else {
    const code = error instanceof MuninError ? `[${error.code}] ` : "";
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${err.red("munin:")} ${code}${message}`);
    if (process.env.MUNIN_DEBUG === "1" && error instanceof Error && error.stack !== undefined) {
      console.error(error.stack);
    }
  }
  process.exitCode = exitCodeFor(error);
});
