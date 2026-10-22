/**
 * Terminal styles for the CLI.
 *
 * Presentation rules live in docs/diagnostics.md: colour only on a TTY,
 * `NO_COLOR` unset, and `TERM` not "dumb". Piped output stays plain ASCII.
 */
import process from "node:process";

export interface Styles {
  bold: (text: string) => string;
  dim: (text: string) => string;
  red: (text: string) => string;
  green: (text: string) => string;
  yellow: (text: string) => string;
  blue: (text: string) => string;
}

function colorEnabled(stream: NodeJS.WriteStream): boolean {
  if (!stream.isTTY) return false;
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") return false;
  if (process.env.TERM === "dumb") return false;
  return true;
}

function stylesFor(stream: NodeJS.WriteStream): Styles {
  if (!colorEnabled(stream)) {
    const plain = (text: string) => String(text);
    return {
      bold: plain,
      dim: plain,
      red: plain,
      green: plain,
      yellow: plain,
      blue: plain,
    };
  }

  const paint = (code: number) => (text: string) => `\x1b[${code}m${String(text)}\x1b[0m`;
  return {
    bold: paint(1),
    dim: paint(2),
    red: paint(31),
    green: paint(32),
    yellow: paint(33),
    blue: paint(34),
  };
}

export const out = stylesFor(process.stdout);
export const err = stylesFor(process.stderr);
