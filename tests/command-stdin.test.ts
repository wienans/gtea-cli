import assert from "node:assert/strict";
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { getInteractiveStdinPrompt, isTokenAuthStdinCommand, readCommandStdin } from "../src/command-stdin.js";

async function withNonInteractiveStdin<T>(content: string, run: (stdin: NodeJS.ReadStream & { fd: number }) => Promise<T>): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), "gtea-command-stdin-"));
  const filePath = join(directory, "stdin.txt");

  writeFileSync(filePath, content, "utf8");

  const fd = openSync(filePath, "r");

  try {
    return await run({ fd, isTTY: false } as NodeJS.ReadStream & { fd: number });
  } finally {
    closeSync(fd);
    rmSync(directory, { recursive: true, force: true });
  }
}

test("token auth stdin detection covers login and refresh only when --with-token is present", () => {
  assert.equal(isTokenAuthStdinCommand(["auth", "login", "--with-token"]), true);
  assert.equal(isTokenAuthStdinCommand(["auth", "refresh", "--with-token"]), true);
  assert.equal(isTokenAuthStdinCommand(["auth", "login"]), false);
  assert.equal(isTokenAuthStdinCommand(["auth", "git-credential"]), false);
});

test("interactive auth token prompts tell Windows users how to submit for login and refresh", () => {
  const loginPrompt = getInteractiveStdinPrompt(["auth", "login", "--with-token"], {
    isTTY: true
  });
  const refreshPrompt = getInteractiveStdinPrompt(["auth", "refresh", "--with-token"], {
    isTTY: true
  });

  assert.equal(
    loginPrompt,
    "Paste the Personal Access Token and press Enter to submit.\n"
  );
  assert.equal(
    refreshPrompt,
    "Paste the Personal Access Token and press Enter to submit.\n"
  );
});

test("interactive auth token prompts use Enter on non-Windows terminals too", () => {
  const prompt = getInteractiveStdinPrompt(["auth", "login", "--with-token"], {
    isTTY: true
  });

  assert.equal(prompt, "Paste the Personal Access Token and press Enter to submit.\n");
});

test("interactive auth token reads a single submitted line from a TTY", async () => {
  const stdin = Readable.from(["tty-token\r\n"]);
  const stderrChunks: string[] = [];

  Object.assign(stdin, { isTTY: true });

  const value = await readCommandStdin(["auth", "login", "--with-token"], {
    stdin: stdin as NodeJS.ReadStream,
    stderr: {
      write(chunk: string | Uint8Array) {
        stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
        return true;
      }
    }
  });

  assert.equal(value, "tty-token");
  assert.equal(stderrChunks.join(""), "Paste the Personal Access Token and press Enter to submit.\n");
});

test("non-interactive auth token reads the full stdin stream unchanged", async () => {
  const stdinValue = "line-one\nline-two\n";

  const value = await withNonInteractiveStdin(stdinValue, async (stdin) => readCommandStdin(["auth", "login", "--with-token"], {
    stdin,
    stderr: {
      write() {
        return true;
      }
    }
  }));

  assert.equal(value, stdinValue);
});

test("issue edit body-file dash still reads stdin from non-interactive input", async () => {
  const stdinValue = "updated issue body\nwith multiple lines\n";

  const value = await withNonInteractiveStdin(stdinValue, async (stdin) => readCommandStdin(["issue", "edit", "123", "--body-file", "-"], {
    stdin,
    stderr: {
      write() {
        return true;
      }
    }
  }));

  assert.equal(value, stdinValue);
});

test("interactive auth token prompts stay quiet for non-interactive or unrelated commands", () => {
  assert.equal(
    getInteractiveStdinPrompt(["auth", "login", "--with-token"], {
      isTTY: false
    }),
    undefined
  );
  assert.equal(
    getInteractiveStdinPrompt(["issue", "edit", "--body-file=-"], {
      isTTY: true
    }),
    undefined
  );
});