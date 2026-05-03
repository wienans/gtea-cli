import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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

test("browse help shows the supported routing flags", () => {
  const result = executeCli(["browse", "--help"]);

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /Open repository routes in the browser/);
  assert.match(result.stdout, /supported/i);
  assert.match(result.stdout, /--settings/);
  assert.match(result.stdout, /--wiki/);
  assert.match(result.stdout, /--releases/);
  assert.match(result.stdout, /--no-browser/);
  assert.match(result.stdout, /--repo/);
  assert.doesNotMatch(result.stdout, /Pending Repository Context resolution/i);
});

test("browse --no-browser uses the active host when -R omits it", () => {
  const configRoot = mkdtempSync(join(tmpdir(), "gtea-browse-"));

  try {
    const env = {
      HOME: configRoot,
      XDG_CONFIG_HOME: configRoot
    };

    assert.equal(
      executeCli(["auth", "login", "--hostname", "browse.example.com", "--with-token"], {
        env,
        stdin: "browse-token\n"
      }).exitCode,
      0
    );

    const result = executeCli(["browse", "--no-browser", "-R", "octo/project"], { env });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "https://browse.example.com/octo/project\n");
    assert.equal(result.stderr, "");
  } finally {
    rmSync(configRoot, { force: true, recursive: true });
  }
});

test("browse --no-browser infers the repository from the current git remote", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "gtea-browse-repo-"));

  try {
    const initResult = spawnSync("git", ["init", "--initial-branch=trunk"], {
      cwd: repoRoot,
      encoding: "utf8"
    });

    assert.equal(initResult.status, 0, initResult.stderr);

    const remoteResult = spawnSync("git", ["remote", "add", "origin", "https://gitea.example.com/octo/project.git"], {
      cwd: repoRoot,
      encoding: "utf8"
    });

    assert.equal(remoteResult.status, 0, remoteResult.stderr);

    const result = executeCli(["browse", "--no-browser"], { cwd: repoRoot });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "https://gitea.example.com/octo/project\n");
    assert.equal(result.stderr, "");
  } finally {
    rmSync(repoRoot, { force: true, recursive: true });
  }
});

test("browse synthesizes deterministic routes for issues, pull requests, commits, files, and browse sections", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "gtea-browse-routes-"));

  try {
    assert.equal(
      spawnSync("git", ["init", "--initial-branch=trunk"], {
        cwd: repoRoot,
        encoding: "utf8"
      }).status,
      0
    );
    assert.equal(
      spawnSync("git", ["config", "user.email", "browse@example.com"], {
        cwd: repoRoot,
        encoding: "utf8"
      }).status,
      0
    );
    assert.equal(
      spawnSync("git", ["config", "user.name", "Browse Test"], {
        cwd: repoRoot,
        encoding: "utf8"
      }).status,
      0
    );
    assert.equal(
      spawnSync("git", ["remote", "add", "origin", "https://gitea.example.com/octo/project.git"], {
        cwd: repoRoot,
        encoding: "utf8"
      }).status,
      0
    );

    mkdirSync(join(repoRoot, "src"), { recursive: true });
    writeFileSync(join(repoRoot, "src", "example.ts"), "console.log('browse');\nconsole.log('routes');\n", "utf8");

    assert.equal(
      spawnSync("git", ["add", "."], {
        cwd: repoRoot,
        encoding: "utf8"
      }).status,
      0
    );
    assert.equal(
      spawnSync("git", ["commit", "-m", "add browse example"], {
        cwd: repoRoot,
        encoding: "utf8"
      }).status,
      0
    );

    const commitShaResult = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8"
    });

    assert.equal(commitShaResult.status, 0, commitShaResult.stderr);

    const commitSha = commitShaResult.stdout.trim();

    const cases = [
      {
        args: ["browse", "--no-browser", "12"],
        expectedUrl: "https://gitea.example.com/octo/project/issues/12"
      },
      {
        args: ["browse", "--no-browser", "pulls/34"],
        expectedUrl: "https://gitea.example.com/octo/project/pulls/34"
      },
      {
        args: ["browse", "--no-browser", commitSha],
        expectedUrl: `https://gitea.example.com/octo/project/commit/${commitSha}`
      },
      {
        args: ["browse", "--no-browser", "src/example.ts"],
        expectedUrl: "https://gitea.example.com/octo/project/src/branch/trunk/src/example.ts"
      },
      {
        args: ["browse", "--no-browser", "src/example.ts:2"],
        expectedUrl: "https://gitea.example.com/octo/project/src/branch/trunk/src/example.ts#L2"
      },
      {
        args: ["browse", "--no-browser", "--settings"],
        expectedUrl: "https://gitea.example.com/octo/project/settings"
      },
      {
        args: ["browse", "--no-browser", "--wiki"],
        expectedUrl: "https://gitea.example.com/octo/project/wiki"
      },
      {
        args: ["browse", "--no-browser", "--releases"],
        expectedUrl: "https://gitea.example.com/octo/project/releases"
      }
    ];

    for (const browseCase of cases) {
      const result = executeCli(browseCase.args, { cwd: repoRoot });

      assert.equal(result.exitCode, 0, `expected success for ${browseCase.args.join(" ")}`);
      assert.equal(result.stdout, `${browseCase.expectedUrl}\n`);
      assert.equal(result.stderr, "");
    }
  } finally {
    rmSync(repoRoot, { force: true, recursive: true });
  }
});

test("browse honors a host-qualified -R target over the stored active host", () => {
  const configRoot = mkdtempSync(join(tmpdir(), "gtea-browse-host-"));

  try {
    const env = {
      HOME: configRoot,
      XDG_CONFIG_HOME: configRoot
    };

    assert.equal(
      executeCli(["auth", "login", "--hostname", "stored.example.com", "--with-token"], {
        env,
        stdin: "stored-token\n"
      }).exitCode,
      0
    );

    const result = executeCli(["browse", "--no-browser", "-R", "alt.example.com/octo/project"], { env });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "https://alt.example.com/octo/project\n");
    assert.equal(result.stderr, "");
  } finally {
    rmSync(configRoot, { force: true, recursive: true });
  }
});

test("browse rejects github.com as a non-eligible host", () => {
  const result = executeCli(["browse", "--no-browser", "-R", "github.com/octo/project"]);

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /github\.com is not an Eligible Host/i);
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

test("auth login reads a PAT from real stdin in the shell entrypoint", () => {
  const configRoot = mkdtempSync(join(tmpdir(), "gtea-auth-"));

  try {
    const result = spawnSync("bun", ["run", "cli", "auth", "login", "--hostname", "stdin.example.com", "--with-token"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: configRoot,
        XDG_CONFIG_HOME: configRoot
      },
      input: "stdin-token\n"
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Logged in to stdin\.example\.com/i);

    const statusResult = executeCli(["auth", "status"], {
      env: {
        HOME: configRoot,
        XDG_CONFIG_HOME: configRoot
      }
    });

    assert.equal(statusResult.exitCode, 0);
    assert.match(statusResult.stdout, /Active host:\s+stdin\.example\.com/i);
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

test("auth status rejects an invalid explicit hostname instead of falling back to the active host", () => {
  const configRoot = mkdtempSync(join(tmpdir(), "gtea-auth-"));

  try {
    const env = {
      HOME: configRoot,
      XDG_CONFIG_HOME: configRoot
    };

    assert.equal(
      executeCli(["auth", "login", "--hostname", "valid.example.com", "--with-token"], {
        env,
        stdin: "valid-token\n"
      }).exitCode,
      0
    );

    const result = executeCli(["auth", "status", "--hostname", "not/a/host"], { env });

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /Invalid value for --hostname: not\/a\/host/i);
  } finally {
    rmSync(configRoot, { force: true, recursive: true });
  }
});

test("auth status rejects an invalid GTEA_HOST instead of falling back to stored config", () => {
  const configRoot = mkdtempSync(join(tmpdir(), "gtea-auth-"));

  try {
    const persistedEnv = {
      HOME: configRoot,
      XDG_CONFIG_HOME: configRoot
    };

    assert.equal(
      executeCli(["auth", "login", "--hostname", "valid.example.com", "--with-token"], {
        env: persistedEnv,
        stdin: "valid-token\n"
      }).exitCode,
      0
    );

    const result = executeCli(["auth", "status"], {
      env: {
        ...persistedEnv,
        GTEA_HOST: "not/a/host"
      }
    });

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /Invalid value for GTEA_HOST: not\/a\/host/i);
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