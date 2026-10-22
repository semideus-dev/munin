/**
 * The product command table.
 *
 * Handlers are wired step by step in Phase 6. A command present here but
 * without a handler is recognised and reported as not implemented, rather
 * than mistaken for a typo.
 */
import type { ParsedArgs } from "./args.js";
import { runLive } from "./commands-live.js";
import {
  runPrivacy,
  runProfile,
  runProviders,
  runScan,
  runSessions,
  runShow,
  runTokens,
  runWaste,
  runWhy,
} from "./commands-report.js";

export type HelpGroup = "Start here" | "Change things" | "Look closer" | "About";

export interface CommandFlag {
  flag: string;
  what: string;
}

export interface CommandSpec {
  /** Canonical command word, e.g. `scan`. */
  name: string;
  /** How `munin help` shows it, e.g. `munin scan`. */
  usage: string;
  summary: string;
  group: HelpGroup;
  aliases?: string[];
  flags?: CommandFlag[];
  /** Stretch commands are hidden from `munin help` but shown by `help all`. */
  more?: boolean;
  run?: (args: ParsedArgs) => void | Promise<void>;
}

export const HELP_GROUP_TITLES: readonly HelpGroup[] = [
  "Start here",
  "Change things",
  "Look closer",
  "About",
];

export const COMMANDS: readonly CommandSpec[] = [
  {
    name: "profile",
    usage: "munin",
    summary: "your usage, waste and the biggest win",
    group: "Start here",
    run: runProfile,
  },
  {
    name: "scan",
    usage: "munin scan",
    summary: "spend, findings and data health",
    group: "Start here",
    flags: [
      { flag: "--full", what: "read every session and reconcile the ledger" },
      { flag: "--repair", what: "rewrite ledger slices when --full finds drift" },
    ],
    run: runScan,
  },
  {
    name: "sessions",
    usage: "munin sessions",
    summary: "costliest sessions and where the cost climbs",
    group: "Start here",
    flags: [{ flag: "--top N", what: "how many sessions to list (default 10)" }],
    run: runSessions,
  },
  {
    name: "live",
    usage: "munin live",
    summary: "watch calls as they happen",
    group: "Start here",
    aliases: ["watch"],
    flags: [{ flag: "--interval N", what: "poll interval in milliseconds (minimum 500)" }],
    run: runLive,
  },
  {
    name: "apply",
    usage: "munin apply <rule>",
    summary: "make a change Munin owns, or show the guided steps",
    group: "Change things",
    flags: [
      { flag: "--done", what: "record a change you made by hand" },
      { flag: "--dry-run", what: "say what would change, write nothing" },
      { flag: "--accept-risk", what: "apply on your own judgement when replay cannot settle it" },
    ],
  },
  {
    name: "undo",
    usage: "munin undo <rule>",
    summary: "restore the exact configuration Munin changed",
    group: "Change things",
  },
  {
    name: "results",
    usage: "munin results",
    summary: "before and after for each applied change",
    group: "Change things",
    aliases: ["result"],
  },
  {
    name: "verify",
    usage: "munin verify",
    summary: "replay saved events and fail closed on stale claims",
    group: "Change things",
    flags: [{ flag: "--replay", what: "run the offline replay check" }],
  },
  {
    name: "guard",
    usage: "munin guard on|off",
    summary: "hold a costly OpenCode tool action once",
    group: "Change things",
    flags: [
      { flag: "on|off", what: "enable or disable the OpenCode guard" },
      { flag: "(alone)", what: "show whether it is on" },
    ],
  },
  {
    name: "statusline",
    usage: "munin statusline on|off",
    summary: "cost and tokens in OpenCode's prompt footer",
    group: "Change things",
    flags: [{ flag: "on|off", what: "enable or disable the terminal statusline" }],
  },
  {
    name: "why",
    usage: "munin why",
    summary: "where the money goes: model, project and kind of work",
    group: "Look closer",
    flags: [
      { flag: "--depth N", what: "how many levels to print" },
      { flag: "--requests N", what: "example requests under each leaf (default 3)" },
    ],
    run: runWhy,
  },
  {
    name: "tokens",
    usage: "munin tokens",
    summary: "token analytics and the priciest calls",
    group: "Look closer",
    aliases: ["analytics"],
    run: runTokens,
  },
  {
    name: "waste",
    usage: "munin waste",
    summary: "only the opportunities, each with its fix",
    group: "Look closer",
    run: runWaste,
  },
  {
    name: "show",
    usage: "munin show <rule>",
    summary: "the calls a recommendation touches",
    group: "Look closer",
    flags: [{ flag: "<rule>", what: "the rule whose evidence to show" }],
    run: runShow,
  },
  {
    name: "report",
    usage: "munin report",
    summary: "write the profile as a self-contained HTML page",
    group: "Look closer",
    flags: [
      { flag: "--out FILE", what: "where to write it" },
      { flag: "--org NAME", what: "a name for the header" },
    ],
  },
  {
    name: "card",
    usage: "munin card",
    summary: "your last 30 days as an image",
    group: "Look closer",
    flags: [{ flag: "--out FILE", what: "where to write it" }],
    more: true,
  },
  {
    name: "simulate",
    usage: "munin simulate <rule>",
    summary: "what a change would cost before applying it",
    group: "Look closer",
    flags: [
      { flag: "<rule>", what: "the rule to simulate" },
      { flag: "--to MODEL", what: "the model to compare against" },
    ],
    more: true,
  },
  {
    name: "providers",
    usage: "munin providers",
    summary: "what can be read, and from where",
    group: "About",
    run: runProviders,
  },
  {
    name: "privacy",
    usage: "munin privacy",
    summary: "what is collected, stored and sent",
    group: "About",
    aliases: ["security"],
    run: runPrivacy,
  },
  {
    name: "help",
    usage: "munin help [command|all]",
    summary: "this help, or one command's flags",
    group: "About",
    flags: [{ flag: "[command|all]", what: "a command name, or all for stretch commands" }],
  },
];

export function findCommand(name: string): CommandSpec | undefined {
  return COMMANDS.find(
    (command) => command.name === name || command.aliases?.includes(name) === true,
  );
}

export function commandsInGroup(group: HelpGroup, all: boolean): CommandSpec[] {
  return COMMANDS.filter((command) => command.group === group && (all || !command.more));
}
