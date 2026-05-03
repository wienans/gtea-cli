import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("auth login persists a PAT and status reports the active host", () => {
  const configRoot = mkdtempSync(join(tmpdir(), "gtea-auth-"));

  try {
    const env = {
      HOME: configRoot,
      XDG_CONFIG_HOME: configRoot
    };

    const loginResult = executeCli(["auth", "login", "--hostname", "gitea.example.com", "--with-token"], {
      env,
      stdin: "pat-example\n"
    });

    assert.equal(loginResult.exitCode, 0);
    assert.match(loginResult.stdout, /Logged in to gitea\.example\.com/i);

    const statusResult = executeCli(["auth", "status"], { env });

    assert.equal(statusResult.exitCode, 0);
    assert.match(statusResult.stdout, /Active host:\s+gitea\.example\.com/i);
    assert.match(statusResult.stdout, /Credential source:\s+native config store/i);
  } finally {
    rmSync(configRoot, { force: true, recursive: true });
  }
});

test("auth token prefers GTEA compatibility variables over GH and stored config", () => {
  const configRoot = mkdtempSync(join(tmpdir(), "gtea-auth-"));

  try {
    const persistedEnv = {
      HOME: configRoot,
      XDG_CONFIG_HOME: configRoot
    };

    const loginResult = executeCli(["auth", "login", "--hostname", "stored.example.com", "--with-token"], {
      env: persistedEnv,
      stdin: "stored-token\n"
    });

    assert.equal(loginResult.exitCode, 0);

    const tokenResult = executeCli(["auth", "token"], {
      env: {
        ...persistedEnv,
        GH_HOST: "legacy.example.com",
        GH_TOKEN: "legacy-token",
        GTEA_HOST: "native.example.com",
        GTEA_TOKEN: "native-token"
      }
    });

    assert.equal(tokenResult.exitCode, 0);
    assert.equal(tokenResult.stdout, "native-token\n");
  } finally {
    rmSync(configRoot, { force: true, recursive: true });
  }
});

test("auth switch and logout manage the active host across multiple stored hosts", () => {
  const configRoot = mkdtempSync(join(tmpdir(), "gtea-auth-"));

  try {
    const env = {
      HOME: configRoot,
      XDG_CONFIG_HOME: configRoot
    };

    assert.equal(
      executeCli(["auth", "login", "--hostname", "first.example.com", "--with-token"], {
        env,
        stdin: "first-token\n"
      }).exitCode,
      0
    );

    assert.equal(
      executeCli(["auth", "login", "--hostname", "second.example.com", "--with-token"], {
        env,
        stdin: "second-token\n"
      }).exitCode,
      0
    );

    const switchResult = executeCli(["auth", "switch", "--hostname", "first.example.com"], { env });

    assert.equal(switchResult.exitCode, 0);
    assert.match(switchResult.stdout, /Switched active host to first\.example\.com/i);

    const switchedStatus = executeCli(["auth", "status"], { env });

    assert.equal(switchedStatus.exitCode, 0);
    assert.match(switchedStatus.stdout, /Active host:\s+first\.example\.com/i);

    const logoutResult = executeCli(["auth", "logout", "--hostname", "first.example.com"], { env });

    assert.equal(logoutResult.exitCode, 0);
    assert.match(logoutResult.stdout, /Removed the stored credential for first\.example\.com/i);

    const fallbackStatus = executeCli(["auth", "status"], { env });

    assert.equal(fallbackStatus.exitCode, 0);
    assert.match(fallbackStatus.stdout, /Active host:\s+second\.example\.com/i);
  } finally {
    rmSync(configRoot, { force: true, recursive: true });
  }
});

test("auth refresh replaces the stored PAT for an existing host", () => {
  const configRoot = mkdtempSync(join(tmpdir(), "gtea-auth-"));

  try {
    const env = {
      HOME: configRoot,
      XDG_CONFIG_HOME: configRoot
    };

    assert.equal(
      executeCli(["auth", "login", "--hostname", "refresh.example.com", "--with-token"], {
        env,
        stdin: "old-token\n"
      }).exitCode,
      0
    );

    const refreshResult = executeCli(["auth", "refresh", "--hostname", "refresh.example.com", "--with-token"], {
      env,
      stdin: "new-token\n"
    });

    assert.equal(refreshResult.exitCode, 0);
    assert.match(refreshResult.stdout, /Refreshed the stored credential for refresh\.example\.com/i);

    const tokenResult = executeCli(["auth", "token", "--hostname", "refresh.example.com"], { env });

    assert.equal(tokenResult.exitCode, 0);
    assert.equal(tokenResult.stdout, "new-token\n");
  } finally {
    rmSync(configRoot, { force: true, recursive: true });
  }
});

test("auth setup-git configures git to use the gtea credential helper for the selected host", () => {
  const configRoot = mkdtempSync(join(tmpdir(), "gtea-auth-"));

  try {
    const gitConfigPath = join(configRoot, ".gitconfig");
    const env = {
      HOME: configRoot,
      XDG_CONFIG_HOME: configRoot,
      GIT_CONFIG_GLOBAL: gitConfigPath
    };

    assert.equal(
      executeCli(["auth", "login", "--hostname", "git.example.com", "--with-token"], {
        env,
        stdin: "git-token\n"
      }).exitCode,
      0
    );

    const setupResult = executeCli(["auth", "setup-git", "--hostname", "git.example.com"], { env });

    assert.equal(setupResult.exitCode, 0);
    assert.match(setupResult.stdout, /Configured Git credential helper for git\.example\.com/i);

    const helperConfig = spawnSync(
      "git",
      ["config", "--global", "--get", "credential.https://git.example.com.helper"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          ...env
        }
      }
    );

    assert.equal(helperConfig.status, 0);
    assert.match(helperConfig.stdout, /!gtea auth git-credential --hostname git\.example\.com/);
  } finally {
    rmSync(configRoot, { force: true, recursive: true });
  }
});

test("auth login rejects github.com as a non-eligible host", () => {
  const configRoot = mkdtempSync(join(tmpdir(), "gtea-auth-"));

  try {
    const env = {
      HOME: configRoot,
      XDG_CONFIG_HOME: configRoot
    };

    const result = executeCli(["auth", "login", "--hostname", "github.com", "--with-token"], {
      env,
      stdin: "pat-example\n"
    });

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /github\.com is not an Eligible Host/i);
  } finally {
    rmSync(configRoot, { force: true, recursive: true });
  }
});

test("auth git-credential returns oauth2 credentials for the configured host", () => {
  const configRoot = mkdtempSync(join(tmpdir(), "gtea-auth-"));

  try {
    const env = {
      HOME: configRoot,
      XDG_CONFIG_HOME: configRoot
    };

    assert.equal(
      executeCli(["auth", "login", "--hostname", "helper.example.com", "--with-token"], {
        env,
        stdin: "helper-token\n"
      }).exitCode,
      0
    );

    const result = executeCli(["auth", "git-credential", "--hostname", "helper.example.com", "get"], {
      env,
      stdin: "protocol=https\nhost=helper.example.com\n\n"
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "username=oauth2\npassword=helper-token\n");
  } finally {
    rmSync(configRoot, { force: true, recursive: true });
  }
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

      if (entry.node.status === "unsupported") {
        assert.equal(executeResult.exitCode, 1, `expected explicit unsupported result for ${entry.path.join(" ")}`);
        assert.match(
          executeResult.stderr,
          new RegExp(`${supportManifest.cliName} ${entry.path.join(" ")} is currently ${entry.node.status}`, "i")
        );
        continue;
      }

      assert.doesNotMatch(
        executeResult.stderr,
        /is currently unsupported|has no handler yet|Unknown command/i,
        `expected ${entry.path.join(" ")} to dispatch to a concrete handler`
      );
    }
  }
});