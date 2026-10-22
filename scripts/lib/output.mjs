// Shared terminal presentation for the development harness scripts
// (scripts/analyze-local.mjs and scripts/read-local.mjs).
//
// Rules (docs/plans/phase-1-completion.md, "Plain text rules"): plain ASCII,
// no em dashes, no emoji, no box drawing. Colour is applied only when the
// target stream is a TTY, NO_COLOR is unset or empty, and TERM is not "dumb".
// Data values mostly stay uncoloured so piped output stays greppable; only
// labels, headings, rules, and severity tiers are painted.
import process from "node:process";

export const RULE_WIDTH = 72;
export const LABEL_WIDTH = 12;
// Column where a kv() value starts: two-space indent + padded label + one space.
export const LIST_INDENT = " ".repeat(3 + LABEL_WIDTH);

export const usd = (value) => `$${value.toFixed(6)}`;
export const group = (value) => value.toLocaleString("en-US");
export const pct = (value) => (value === null ? "n/a" : `${(value * 100).toFixed(2)}%`);

function colorEnabled(stream) {
  if (!stream.isTTY) return false;
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") return false;
  if (process.env.TERM === "dumb") return false;
  return true;
}

function stylesFor(stream) {
  if (!colorEnabled(stream)) {
    const plain = (text) => String(text);
    return {
      bold: plain,
      dim: plain,
      red: plain,
      green: plain,
      yellow: plain,
      cyan: plain,
    };
  }
  const paint = (code) => (text) => `\x1b[${code}m${String(text)}\x1b[0m`;
  return {
    bold: paint(1),
    dim: paint(2),
    red: paint(31),
    green: paint(32),
    yellow: paint(33),
    cyan: paint(36),
  };
}

export const out = stylesFor(process.stdout);
export const err = stylesFor(process.stderr);

// Dim field separator for inline key=value lists.
export const sep = () => out.dim(" | ");

// Major section: a blank line, a bold title, and a full-width rule under it.
export function heading(text) {
  console.log("");
  console.log(out.bold(text));
  console.log(out.dim("-".repeat(RULE_WIDTH)));
}

// Minor section: a blank line and a bold title, no rule.
export function sub(text) {
  console.log("");
  console.log(out.bold(text));
}

// Full-width dim rule, for separating repeating blocks (findings, events).
export function hline() {
  console.log(out.dim("-".repeat(RULE_WIDTH)));
}

// One `  label value` line, the label dimmed and padded to a shared column so
// blocks read as an aligned list.
export function kv(label, value) {
  const width = Math.max(LABEL_WIDTH, String(label).length);
  console.log(`  ${out.dim(String(label).padEnd(width))} ${value}`);
}

// Simple aligned table: bold header, dashed rule under it, two-space gaps.
// `aligns` is per-column, "right" or anything else for left.
export function table(head, rows, aligns = []) {
  const widths = head.map((heading, i) =>
    Math.max(heading.length, ...rows.map((cells) => String(cells[i]).length)),
  );
  const fit = (text, i) =>
    aligns[i] === "right" ? text.padStart(widths[i]) : text.padEnd(widths[i]);
  console.log(head.map((heading, i) => out.bold(fit(heading, i))).join("  "));
  console.log(head.map((heading, i) => out.dim("-".repeat(widths[i]))).join("  "));
  for (const cells of rows) {
    console.log(cells.map((cell, i) => fit(String(cell), i)).join("  "));
  }
}
