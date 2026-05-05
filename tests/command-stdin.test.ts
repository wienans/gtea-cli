import assert from "node:assert/strict";
import test from "node:test";

import { getInteractiveStdinPrompt, isTokenAuthStdinCommand } from "../src/command-stdin.js";

test("token auth stdin detection covers login and refresh only when --with-token is present", () => {
  assert.equal(isTokenAuthStdinCommand(["auth", "login", "--with-token"]), true);
  assert.equal(isTokenAuthStdinCommand(["auth", "refresh", "--with-token"]), true);
  assert.equal(isTokenAuthStdinCommand(["auth", "login"]), false);
  assert.equal(isTokenAuthStdinCommand(["auth", "git-credential"]), false);
});

test("interactive auth token prompts tell Windows users how to submit for login and refresh", () => {
  const loginPrompt = getInteractiveStdinPrompt(["auth", "login", "--with-token"], {
    isTTY: true,
    platform: "win32"
  });
  const refreshPrompt = getInteractiveStdinPrompt(["auth", "refresh", "--with-token"], {
    isTTY: true,
    platform: "win32"
  });

  assert.equal(
    loginPrompt,
    "Paste the Personal Access Token, then press Ctrl+Z followed by Enter to submit.\n"
  );
  assert.equal(
    refreshPrompt,
    "Paste the Personal Access Token, then press Ctrl+Z followed by Enter to submit.\n"
  );
});

test("interactive auth token prompts keep Ctrl+D on non-Windows terminals", () => {
  const prompt = getInteractiveStdinPrompt(["auth", "login", "--with-token"], {
    isTTY: true,
    platform: "linux"
  });

  assert.equal(prompt, "Paste the Personal Access Token, then press Ctrl+D to submit.\n");
});

test("interactive auth token prompts stay quiet for non-interactive or unrelated commands", () => {
  assert.equal(
    getInteractiveStdinPrompt(["auth", "login", "--with-token"], {
      isTTY: false,
      platform: "win32"
    }),
    undefined
  );
  assert.equal(
    getInteractiveStdinPrompt(["issue", "edit", "--body-file=-"], {
      isTTY: true,
      platform: "linux"
    }),
    undefined
  );
});