import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { executeCli } from "../src/cli.js";
import { collectManifestPaths, supportManifest, validateSupportManifest } from "../src/support-manifest.js";

test("root help shows the broad-first command groups", () => {
  const result = executeCli(["--help"]);

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /\bauth\b/);
  assert.match(result.stdout, /\bbrowse\b/);
  assert.match(result.stdout, /\bissue\b/);
  assert.match(result.stdout, /\bpr\b/);
  assert.match(result.stdout, /\brelease\b/);
  assert.match(result.stdout, /\brepo\b/);
});

test("issue list fails as an explicit unsupported command", () => {
  const result = executeCli(["issue", "list"]);

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /gtea issue list is currently unsupported/i);
  assert.match(result.stderr, /pending the issue read slice/i);
});

test("issue help exposes the full manifest-backed issue tree", () => {
  const result = executeCli(["issue", "--help"]);

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /list/);
  assert.match(result.stdout, /view/);
  assert.match(result.stdout, /status/);
  assert.match(result.stdout, /create/);
  assert.match(result.stdout, /comment/);
  assert.match(result.stdout, /edit/);
  assert.match(result.stdout, /close/);
  assert.match(result.stdout, /reopen/);
});

test("browse help renders as a top-level unsupported command", () => {
  const result = executeCli(["browse", "--help"]);

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /Open repository routes in the browser/);
  assert.match(result.stdout, /Pending Repository Context resolution and browse routing/);
  assert.match(result.stdout, /--no-browser/);
});

test("support manifest validation and CLI surface stay synchronized", () => {
  const manifestJson = JSON.parse(
    readFileSync(new URL("../support-manifest.json", import.meta.url), "utf8")
  ) as Parameters<typeof validateSupportManifest>[0];
  const validationErrors = validateSupportManifest(manifestJson);

  assert.deepEqual(validationErrors, []);

  for (const entry of collectManifestPaths()) {
    const helpResult = executeCli([...entry.path, "--help"]);

    assert.equal(helpResult.exitCode, 0, `help failed for ${entry.path.join(" ")}`);
    assert.match(helpResult.stdout, new RegExp(entry.node.name));

    if (entry.node.kind === "command") {
      const executeResult = executeCli(entry.path);

      assert.equal(executeResult.exitCode, 1, `expected explicit unsupported result for ${entry.path.join(" ")}`);
      assert.match(
        executeResult.stderr,
        new RegExp(`${supportManifest.cliName} ${entry.path.join(" ")} is currently ${entry.node.status}`, "i")
      );
    }
  }
});