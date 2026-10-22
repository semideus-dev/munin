/**
 * Help and environment output.
 *
 * Help runs before any command handler and never reads source history. The
 * environment block resolves the same XDG-based OpenCode path the rest of the
 * runtime uses, plus the Munin state directory, so a first run can see where
 * data will come from and where derived state will live.
 */
import { MuninError, type SourceWarning } from "@munin/core";
import { inspectSourceDatabase, loadConfig, type DbOrigin } from "@munin/local";
import { flagValue, type ParsedArgs } from "./args.js";
import {
  commandsInGroup,
  findCommand,
  HELP_GROUP_TITLES,
  type CommandFlag,
  type CommandSpec,
} from "./commands.js";
import { printWarnings } from "./render.js";
import { out } from "./styles.js";
import { VERSION } from "./version.js";

export interface EnvironmentSummary {
  dbPath: string;
  dbOrigin: DbOrigin;
  dbState: "ready" | "missing" | "unreadable";
  stateDir: string;
  settingsPath: string;
  node: string;
  platform: string;
  arch: string;
  warnings: SourceWarning[];
}

const COMMON_FLAGS: readonly CommandFlag[] = [
  { flag: "--days N", what: "only the last N days" },
  { flag: "--project STR", what: "filter by project path" },
  { flag: "--tz ZONE", what: "day-bucket zone: utc, local or an IANA name" },
  { flag: "--db PATH", what: "OpenCode database path" },
  { flag: "--state-dir PATH", what: "Munin state directory" },
  { flag: "--why", what: "show every calculation and assumption" },
  { flag: "--json", what: "machine-readable output" },
];

export function readEnvironment(flags: ParsedArgs["flags"]): EnvironmentSummary {
  const db = flagValue(flags, "db");
  const stateDir = flagValue(flags, "state-dir");
  const config = loadConfig({
    ...(db === undefined ? {} : { db }),
    ...(stateDir === undefined ? {} : { stateDir }),
  });
  const source = inspectSourceDatabase(config.dbPath);
  return {
    dbPath: config.dbPath,
    dbOrigin: config.dbOrigin,
    dbState: source.kind,
    stateDir: config.paths.stateDir,
    settingsPath: config.paths.settingsPath,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    warnings: config.warnings,
  };
}

function printFlags(flags: readonly CommandFlag[]): void {
  const width = Math.max(...flags.map(({ flag }) => flag.length)) + 3;
  for (const { flag, what } of flags) {
    console.log(`    ${flag.padEnd(width)}${out.dim(what)}`);
  }
}

function printEnvironment(summary: EnvironmentSummary): void {
  console.log(`  ${out.bold("Environment")}`);
  const width = 8;
  console.log(
    `    ${out.dim("database".padEnd(width))} ${summary.dbPath} ${out.dim(`(${summary.dbOrigin}, ${summary.dbState})`)}`,
  );
  console.log(`    ${out.dim("state".padEnd(width))} ${summary.stateDir}`);
  console.log(`    ${out.dim("settings".padEnd(width))} ${summary.settingsPath}`);
  console.log(
    `    ${out.dim("runtime".padEnd(width))} node ${summary.node} ${summary.platform} ${summary.arch}`,
  );
  console.log("");
}

function printCommandHelp(command: CommandSpec): void {
  console.log("");
  console.log(`  ${out.blue(command.usage)} ${out.dim(`- ${command.summary}`)}`);
  if (command.aliases !== undefined && command.aliases.length > 0) {
    console.log(
      `  ${out.dim(`also: ${command.aliases.map((alias) => `munin ${alias}`).join(", ")}`)}`,
    );
  }
  if (command.flags !== undefined && command.flags.length > 0) {
    console.log("");
    printFlags(command.flags);
  }
  console.log("");
  console.log(`  ${out.dim("It also takes")}`);
  printFlags(COMMON_FLAGS);
  console.log("");
}

function printGeneralHelp(all: boolean, environment: EnvironmentSummary): void {
  console.log("");
  console.log(
    `  ${out.bold("munin")} ${out.dim(VERSION)} ${out.dim("| spend fewer tokens on the same work")}`,
  );
  console.log("");

  const groups = HELP_GROUP_TITLES.map((title) => ({
    title,
    commands: commandsInGroup(title, all),
  })).filter((group) => group.commands.length > 0);
  const width =
    Math.max(...groups.flatMap((group) => group.commands.map((c) => c.usage.length))) + 2;

  for (const group of groups) {
    console.log(`  ${out.bold(group.title)}`);
    for (const command of group.commands) {
      console.log(`    ${out.blue(command.usage.padEnd(width))}${out.dim(command.summary)}`);
    }
    console.log("");
  }

  console.log(`  ${out.bold("Most commands take")}`);
  printFlags(COMMON_FLAGS);
  console.log("");
  console.log(`  ${out.dim("munin <command> --help   that command's own flags")}`);
  if (!all) {
    console.log(
      `  ${out.dim("munin help all           every command, including stretch commands")}`,
    );
  }
  console.log("");
  printEnvironment(environment);
}

/** Print a help page. Throws a usage error for an unknown command topic. */
export function printHelp(topic: string | undefined, flags: ParsedArgs["flags"]): void {
  const environment = readEnvironment(flags);
  printWarnings(environment.warnings);

  const all = topic === "all";
  const command = topic === undefined || all ? undefined : findCommand(topic);
  if (topic !== undefined && !all && command === undefined) {
    throw new MuninError({
      code: "cli.unknown-command",
      kind: "usage",
      message: `Unknown command "${topic}". Run "munin help" to list commands.`,
    });
  }
  if (command !== undefined) {
    printCommandHelp(command);
    return;
  }
  printGeneralHelp(all, environment);
}
