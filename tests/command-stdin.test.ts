import assert from "node:assert/strict";
import test from "node:test";

import { getInteractiveStdinPrompt } from "../src/command-stdin.js";

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