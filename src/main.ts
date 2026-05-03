#!/usr/bin/env node

import { readFileSync } from "node:fs";

import { executeCli } from "./cli.js";

function commandReadsStdin(args: string[]): boolean {
  const [group, subcommand] = args;

  if (group === "auth") {
    if ((subcommand === "login" || subcommand === "refresh") && args.includes("--with-token")) {
      return true;
    }

    return subcommand === "git-credential";
  }

  if (group !== "issue" || subcommand !== "edit") {
    return false;
  }

  for (let index = 2; index < args.length; index += 1) {
    const token = args[index];

    if (token === "--body-file" && args[index + 1] === "-") {
      return true;
    }

    if (token === "--body-file=-") {
      return true;
    }
  }

  return false;
}

function readCommandStdin(args: string[]): string | undefined {
  if (!commandReadsStdin(args)) {
    return undefined;
  }

  if (process.stdin.isTTY && (args[1] === "login" || args[1] === "refresh") && args.includes("--with-token")) {
    process.stderr.write("Paste the Personal Access Token, then press Ctrl+D to submit.\n");
  }

  return readFileSync(process.stdin.fd, "utf8");
}

const args = process.argv.slice(2);
const stdin = readCommandStdin(args);
const result = await executeCli(args, stdin === undefined ? {} : { stdin });

if (result.stdout.length > 0) {
  process.stdout.write(result.stdout);
}

if (result.stderr.length > 0) {
  process.stderr.write(result.stderr);
}

process.exitCode = result.exitCode;
