import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ResolvedCliExecutionContext } from "../src/cli-runtime.js";
import { resolveHostCommandTarget, resolveRepositoryCommandTarget } from "../src/repository-context.js";

function createContext(
  env: Record<string, string | undefined>,
  cwd = process.cwd()
): ResolvedCliExecutionContext {
  return {
    env,
    stdin: "",
    cwd,
    platform: process.platform
  };
}

function createConfigEnv(configRoot: string, env: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    HOME: configRoot,
    XDG_CONFIG_HOME: configRoot,
    APPDATA: configRoot,
    ...env
  };
}

test("repository target bypasses an unreadable Native Config Store when -R provides a Gitea Host", () => {
  const configRoot = mkdtempSync(join(tmpdir(), "gtea-repository-target-"));

  try {
    const configDirectory = join(configRoot, "gtea");
    mkdirSync(configDirectory, { recursive: true });
    writeFileSync(join(configDirectory, "config.json"), "{\n", "utf8");

    const result = resolveRepositoryCommandTarget(
      "127.0.0.1:3000/octo/project",
      { mode: "none" },
      createContext(createConfigEnv(configRoot), configRoot)
    );

    assert.equal(result.error, undefined);
    assert.equal(result.target?.repository.hostname, "127.0.0.1:3000");
    assert.equal(result.target?.repository.owner, "octo");
    assert.equal(result.target?.repository.repository, "project");
  } finally {
    rmSync(configRoot, { recursive: true, force: true });
  }
});

test("repository target scopes compatibility variable credentials to the resolved Gitea Host", () => {
  const mismatchResult = resolveRepositoryCommandTarget(
    "https://repo.example.com/octo/project",
    { mode: "optional" },
    createContext({
      GTEA_HOST: "https://other.example.com",
      GTEA_TOKEN: "env-token"
    })
  );

  assert.equal(mismatchResult.error, undefined);
  assert.equal(mismatchResult.target?.credential, undefined);

  const matchResult = resolveRepositoryCommandTarget(
    "https://other.example.com/octo/project",
    { mode: "optional" },
    createContext({
      GTEA_HOST: "https://other.example.com",
      GTEA_TOKEN: "env-token"
    })
  );

  assert.equal(matchResult.error, undefined);
  assert.equal(matchResult.target?.credential?.token, "env-token");
  assert.equal(matchResult.target?.credential?.source, "GTEA_TOKEN environment variable");
});

test("host target prefers GTEA compatibility variables and preserves explicit schemes", () => {
  const result = resolveHostCommandTarget(
    undefined,
    { mode: "optional" },
    createContext({
      GH_HOST: "https://legacy.example.com",
      GH_TOKEN: "legacy-token",
      GTEA_HOST: "http://native.example.com",
      GTEA_TOKEN: "native-token"
    })
  );

  assert.equal(result.error, undefined);
  assert.equal(result.target?.hostname, "http://native.example.com");
  assert.equal(result.target?.credential?.token, "native-token");
  assert.equal(result.target?.credential?.source, "GTEA_TOKEN environment variable");
});

test("host target rejects an invalid GTEA_HOST instead of falling back to stored host state", () => {
  const configRoot = mkdtempSync(join(tmpdir(), "gtea-host-target-"));

  try {
    const configDirectory = join(configRoot, "gtea");
    mkdirSync(configDirectory, { recursive: true });
    writeFileSync(
      join(configDirectory, "config.json"),
      `${JSON.stringify({
        activeHost: "stored.example.com",
        hosts: {
          "stored.example.com": {
            token: "stored-token"
          }
        }
      }, null, 2)}\n`,
      "utf8"
    );

    const result = resolveHostCommandTarget(
      undefined,
      { mode: "none" },
      createContext(createConfigEnv(configRoot, {
        GTEA_HOST: "not/a/host"
      }), configRoot)
    );

    assert.match(result.error?.stderr ?? "", /Invalid value for GTEA_HOST: not\/a\/host/i);
  } finally {
    rmSync(configRoot, { recursive: true, force: true });
  }
});

test("host target applies compatibility variable tokens to an explicit auth host", () => {
  const result = resolveHostCommandTarget(
    "stored.example.com",
    { mode: "optional" },
    createContext({
      GTEA_TOKEN: "env-token"
    })
  );

  assert.equal(result.error, undefined);
  assert.equal(result.target?.hostname, "stored.example.com");
  assert.equal(result.target?.credential?.token, "env-token");
  assert.equal(result.target?.credential?.source, "GTEA_TOKEN environment variable");
});