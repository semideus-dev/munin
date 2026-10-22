#!/usr/bin/env node
// Command handlers are wired in a later phase; --version must stay usable while
// the engine is being ported so the package remains installable end to end.
import { VERSION } from "./version.js";

const argv = process.argv.slice(2);

if (argv.includes("--version") || argv.includes("-v")) {
  console.log(VERSION);
  process.exit(0);
}

console.log(`munin ${VERSION}`);
console.log("Commands are not wired yet. See docs/parity-matrix.md for the planned surface.");
process.exit(1);
