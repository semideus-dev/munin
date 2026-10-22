/**
 * Terminal rendering for the product CLI.
 *
 * Presentation rules live in `docs/diagnostics.md`: plain ASCII, no em dashes,
 * and colour only when the target stream is a TTY with `NO_COLOR` unset. Values
 * stay uncoloured so piped output is greppable; only labels, headings, rules and
 * tiers are painted. This is the CLI port of `scripts/lib/output.mjs`, which
 * stays the developer-harness copy.
 */
import type { SourceWarning } from "@munin/core";
import { successPayload } from "./exit.js";
import { err, out } from "./styles.js";

export const RULE_WIDTH = 72;
export const LABEL_WIDTH = 12;

/** Compact token counts, matching the reference's `tokens()`. */
export function tokens(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(Math.round(value));
}

/** Dollar formatting that keeps small findings readable. */
export function usd(value: number): string {
  if (!Number.isFinite(value) || value === 0) return "$0.00";
  if (Math.abs(value) < 0.01) return `$${value.toFixed(4)}`;
  if (Math.abs(value) < 1) return `$${value.toFixed(3)}`;
  if (Math.abs(value) >= 1000) return `$${Math.round(value).toLocaleString("en-US")}`;
  return `$${value.toFixed(2)}`;
}

export function group(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

export function pct(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(2)}%`;
}

/** Major section: a blank line, a bold title, and a full-width rule under it. */
export function heading(text: string): void {
  console.log("");
  console.log(out.bold(text));
  console.log(out.dim("-".repeat(RULE_WIDTH)));
}

/** Minor section: a blank line and a bold title, no rule. */
export function sub(text: string): void {
  console.log("");
  console.log(out.bold(text));
}

/** Full-width dim rule, for separating repeating blocks. */
export function hline(): void {
  console.log(out.dim("-".repeat(RULE_WIDTH)));
}

/** One `  label value` line, the label dimmed and padded to a shared column. */
export function kv(label: string, value: string): void {
  const width = Math.max(LABEL_WIDTH, label.length);
  console.log(`  ${out.dim(label.padEnd(width))} ${value}`);
}

/** Simple aligned table: bold header, dashed rule, two-space gaps. */
export function table(
  head: readonly string[],
  rows: readonly (readonly string[])[],
  aligns: readonly ("left" | "right")[] = [],
): void {
  const widths = head.map((heading, index) =>
    Math.max(heading.length, ...rows.map((cells) => String(cells[index] ?? "").length)),
  );
  const fit = (text: string, index: number): string =>
    aligns[index] === "right" ? text.padStart(widths[index]!) : text.padEnd(widths[index]!);
  console.log(head.map((heading, index) => out.bold(fit(heading, index))).join("  "));
  console.log(head.map((_heading, index) => out.dim("-".repeat(widths[index]!))).join("  "));
  for (const cells of rows) {
    console.log(cells.map((cell, index) => fit(String(cell), index)).join("  "));
  }
}

/** Greedy word wrap on spaces; never splits a word that fits. */
export function wrapText(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (line === "") line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== "") lines.push(line);
  return lines;
}

/** Warnings go to stderr, one line per code, aggregated by the caller. */
export function printWarnings(warnings: readonly SourceWarning[]): void {
  for (const warning of warnings) {
    const count = warning.count === undefined ? "" : ` (x${warning.count})`;
    console.error(`${err.yellow(`[${warning.code}]`)} ${warning.message}${count}`);
  }
}

/** The single `--json` document on stdout. */
export function emitJson(data: unknown, warnings: readonly SourceWarning[]): void {
  process.stdout.write(`${JSON.stringify(successPayload(data, warnings), null, 2)}\n`);
}
