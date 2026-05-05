#!/usr/bin/env node

import { readCommandStdin } from "./command-stdin.js";
import { executeCli } from "./cli.js";

const args = process.argv.slice(2);
const stdin = await readCommandStdin(args, {
  stdin: process.stdin,
  stderr: process.stderr
});
const result = await executeCli(args, stdin === undefined ? {} : { stdin });

if (result.stdout.length > 0) {
  process.stdout.write(result.stdout);
}

if (result.stderr.length > 0) {
  process.stderr.write(result.stderr);
}

process.exitCode = result.exitCode;
