import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { executeCli } from "../src/cli.js";
import { collectManifestPaths, supportManifest, validateSupportManifest } from "../src/support-manifest.js";

function getServerPort(server: ReturnType<typeof createServer>): number {
  const address = server.address();

  assert.notEqual(address, null);
  assert.equal(typeof address, "object");

  return (address as AddressInfo).port;
}

test("root help shows the broad-first command groups", async () => {
  const result = await executeCli(["--help"]);

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /\bauth\b/);
  assert.match(result.stdout, /\bbrowse\b/);
  assert.match(result.stdout, /\bissue\b/);
  assert.match(result.stdout, /\bpr\b/);
  assert.match(result.stdout, /\brelease\b/);
  assert.match(result.stdout, /\brepo\b/);
});

test("repo view help classifies repository targeting and structured output flags", async () => {
  const result = await executeCli(["repo", "view", "--help"]);

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /--repo, -R[\s\S]*\[supported\]/i);
  assert.match(result.stdout, /--json[\s\S]*\[supported\]/i);
  assert.match(result.stdout, /--jq[\s\S]*\[emulated\]/i);
  assert.match(result.stdout, /--template[\s\S]*\[emulated\]/i);
});

test("repo admin help classifies supported, emulated, and unsupported flags", async () => {
  const createHelp = await executeCli(["repo", "create", "--help"]);
  const forkHelp = await executeCli(["repo", "fork", "--help"]);
  const renameHelp = await executeCli(["repo", "rename", "--help"]);

  assert.equal(createHelp.exitCode, 0);
  assert.match(createHelp.stdout, /--clone, -c[\s\S]*\[emulated\]/i);
  assert.match(createHelp.stdout, /--description, -d[\s\S]*\[supported\]/i);
  assert.match(createHelp.stdout, /--private[\s\S]*\[supported\]/i);
  assert.match(createHelp.stdout, /--template, -p[\s\S]*\[unsupported\]/i);

  assert.equal(forkHelp.exitCode, 0);
  assert.match(forkHelp.stdout, /--clone[\s\S]*\[emulated\]/i);
  assert.match(forkHelp.stdout, /--fork-name[\s\S]*\[supported\]/i);
  assert.match(forkHelp.stdout, /--org[\s\S]*\[supported\]/i);
  assert.match(forkHelp.stdout, /--remote[\s\S]*\[unsupported\]/i);

  assert.equal(renameHelp.exitCode, 0);
  assert.match(renameHelp.stdout, /--repo, -R[\s\S]*\[supported\]/i);
  assert.match(renameHelp.stdout, /--yes, -y[\s\S]*\[emulated\]/i);
});

test("repo view reads a single repository from the selected Gitea host", async () => {
  const server = createServer((request, response) => {
    if (request.url !== "/api/v1/repos/octo/project") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "not found" }));
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        name: "project",
        full_name: "octo/project",
        private: false,
        html_url: `http://127.0.0.1:${getServerPort(server)}/octo/project`,
        owner: {
          login: "octo"
        },
        description: "Repository read slice"
      })
    );
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const port = getServerPort(server);

  try {
    const result = await executeCli(["repo", "view", "-R", `127.0.0.1:${port}/octo/project`]);

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /octo\/project/);
    assert.match(result.stdout, /public/i);
    assert.match(result.stdout, new RegExp(`http://127\\.0\\.0\\.1:${port}/octo/project`));
    assert.equal(result.stderr, "");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve();
      })
    );
  }
});

test("repo view requires --json when --jq is provided", async () => {
  const result = await executeCli([
    "repo",
    "view",
    "-R",
    "https://example.com/octo/project",
    "--jq",
    ".name"
  ]);

  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "--jq requires --json.\n");
});

test("repo list rejects --template without --json and disallows combining it with --jq", async () => {
  const missingJsonResult = await executeCli([
    "repo",
    "list",
    "-R",
    "https://example.com/octo/project",
    "--template",
    "{{.name}}"
  ]);

  assert.equal(missingJsonResult.exitCode, 1);
  assert.equal(missingJsonResult.stdout, "");
  assert.equal(missingJsonResult.stderr, "--template requires --json.\n");

  const conflictingFlagsResult = await executeCli([
    "repo",
    "list",
    "-R",
    "https://example.com/octo/project",
    "--json",
    "name",
    "--jq",
    ".[].name",
    "--template",
    "{{.name}}"
  ]);

  assert.equal(conflictingFlagsResult.exitCode, 1);
  assert.equal(conflictingFlagsResult.stdout, "");
  assert.equal(conflictingFlagsResult.stderr, "Choose at most one of --jq and --template.\n");
});

test("repo list reads repositories for the selected owner on the selected Gitea host", async () => {
  let port = 0;

  const server = createServer((request, response) => {
    if (request.url !== "/api/v1/users/octo/repos") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "not found" }));
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify([
        {
          name: "project",
          private: false,
          html_url: `http://127.0.0.1:${port}/octo/project`,
          owner: {
            login: "octo"
          }
        },
        {
          name: "private-project",
          private: true,
          html_url: `http://127.0.0.1:${port}/octo/private-project`,
          owner: {
            login: "octo"
          }
        }
      ])
    );
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = getServerPort(server);

  try {
    const result = await executeCli(["repo", "list", "-R", `127.0.0.1:${port}/octo/project`]);

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /octo\/project \[public\]/);
    assert.match(result.stdout, /octo\/private-project \[private\]/);
    assert.equal(result.stderr, "");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve();
      })
    );
  }
});

test("repo list supports manifest-backed json output fields", async () => {
  let port = 0;

  const server = createServer((request, response) => {
    if (request.url !== "/api/v1/users/octo/repos") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "not found" }));
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify([
        {
          name: "project",
          private: false,
          html_url: `http://127.0.0.1:${port}/octo/project`,
          owner: {
            login: "octo"
          }
        },
        {
          name: "private-project",
          private: true,
          html_url: `http://127.0.0.1:${port}/octo/private-project`,
          owner: {
            login: "octo"
          }
        }
      ])
    );
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = getServerPort(server);

  try {
    const result = await executeCli([
      "repo",
      "list",
      "-R",
      `127.0.0.1:${port}/octo/project`,
      "--json",
      "name,visibility,url",
      "--jq",
      ".[].name"
    ]);

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "\"project\"\n\"private-project\"\n");
    assert.equal(result.stderr, "");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve();
      })
    );
  }
});

test("repo clone uses the Git Toolchain to clone the selected repository", async () => {
  let port = 0;
  const remoteRoot = mkdtempSync(join(tmpdir(), "gtea-repo-clone-remote-"));
  const sourceRoot = mkdtempSync(join(tmpdir(), "gtea-repo-clone-source-"));
  const cloneParent = mkdtempSync(join(tmpdir(), "gtea-repo-clone-parent-"));
  const cloneRoot = join(cloneParent, "project-checkout");

  const server = createServer((request, response) => {
    if (request.url !== "/api/v1/repos/octo/project") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "not found" }));
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        name: "project",
        private: false,
        html_url: `http://127.0.0.1:${port}/octo/project`,
        clone_url: remoteRoot,
        owner: {
          login: "octo"
        }
      })
    );
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = getServerPort(server);

  try {
    assert.equal(spawnSync("git", ["init", "--bare", remoteRoot], {
      encoding: "utf8"
    }).status, 0);
    assert.equal(spawnSync("git", ["init", "--initial-branch=main"], {
      cwd: sourceRoot,
      encoding: "utf8"
    }).status, 0);
    assert.equal(spawnSync("git", ["config", "user.email", "clone@example.com"], {
      cwd: sourceRoot,
      encoding: "utf8"
    }).status, 0);
    assert.equal(spawnSync("git", ["config", "user.name", "Clone Test"], {
      cwd: sourceRoot,
      encoding: "utf8"
    }).status, 0);

    writeFileSync(join(sourceRoot, "README.md"), "repo read slice\n", "utf8");

    assert.equal(spawnSync("git", ["add", "README.md"], {
      cwd: sourceRoot,
      encoding: "utf8"
    }).status, 0);
    assert.equal(spawnSync("git", ["commit", "-m", "seed repository"], {
      cwd: sourceRoot,
      encoding: "utf8"
    }).status, 0);
    assert.equal(spawnSync("git", ["remote", "add", "origin", remoteRoot], {
      cwd: sourceRoot,
      encoding: "utf8"
    }).status, 0);
    assert.equal(spawnSync("git", ["push", "-u", "origin", "main"], {
      cwd: sourceRoot,
      encoding: "utf8"
    }).status, 0);
    assert.equal(spawnSync("git", ["--git-dir", remoteRoot, "symbolic-ref", "HEAD", "refs/heads/main"], {
      encoding: "utf8"
    }).status, 0);

    const result = await executeCli([
      "repo",
      "clone",
      "-R",
      `127.0.0.1:${port}/octo/project`,
      cloneRoot
    ], {
      cwd: cloneParent
    });

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /Cloned octo\/project/i);
    assert.equal(readFileSync(join(cloneRoot, "README.md"), "utf8").replace(/\r\n/g, "\n"), "repo read slice\n");
    assert.equal(result.stderr, "");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve();
      })
    );
    rmSync(remoteRoot, { force: true, recursive: true });
    rmSync(sourceRoot, { force: true, recursive: true });
    rmSync(cloneParent, { force: true, recursive: true });
  }
});

test("repo create creates a private repository for the authenticated user", async () => {
  let sawUserLookup = false;

  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== "token repo-create-token") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "unauthorized" }));
      return;
    }

    if (request.method === "GET" && request.url === "/api/v1/user") {
      sawUserLookup = true;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ login: "octo" }));
      return;
    }

    if (request.method === "POST" && request.url === "/api/v1/user/repos") {
      let requestBody = "";

      for await (const chunk of request) {
        requestBody += chunk;
      }

      assert.deepEqual(JSON.parse(requestBody), {
        name: "project-admin",
        private: true,
        description: "Repository admin slice"
      });

      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({
        name: "project-admin",
        private: true,
        description: "Repository admin slice",
        html_url: `http://127.0.0.1:${getServerPort(server)}/octo/project-admin`,
        owner: {
          login: "octo"
        }
      }));
      return;
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ message: "not found" }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const port = getServerPort(server);

  try {
    const result = await executeCli([
      "repo",
      "create",
      "project-admin",
      "--private",
      "--description",
      "Repository admin slice"
    ], {
      env: {
        GTEA_HOST: `127.0.0.1:${port}`,
        GTEA_TOKEN: "repo-create-token"
      }
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, `http://127.0.0.1:${port}/octo/project-admin\n`);
    assert.equal(result.stderr, "");
    assert.equal(sawUserLookup, true);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve();
      })
    );
  }
});

test("repo create uses the Git Toolchain when --clone is requested", async () => {
  const remoteRoot = mkdtempSync(join(tmpdir(), "gtea-repo-create-remote-"));
  const sourceRoot = mkdtempSync(join(tmpdir(), "gtea-repo-create-source-"));
  const cloneParent = mkdtempSync(join(tmpdir(), "gtea-repo-create-clone-parent-"));

  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== "token repo-create-token") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "unauthorized" }));
      return;
    }

    if (request.method === "GET" && request.url === "/api/v1/user") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ login: "octo" }));
      return;
    }

    if (request.method !== "POST" || request.url !== "/api/v1/user/repos") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "not found" }));
      return;
    }

    response.writeHead(201, { "content-type": "application/json" });
    response.end(JSON.stringify({
      name: "project-clone",
      private: false,
      clone_url: remoteRoot,
      html_url: `http://127.0.0.1:${getServerPort(server)}/octo/project-clone`,
      owner: {
        login: "octo"
      }
    }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    assert.equal(spawnSync("git", ["init", "--bare", remoteRoot], {
      encoding: "utf8"
    }).status, 0);
    assert.equal(spawnSync("git", ["init", "--initial-branch=main"], {
      cwd: sourceRoot,
      encoding: "utf8"
    }).status, 0);
    assert.equal(spawnSync("git", ["config", "user.email", "clone@example.com"], {
      cwd: sourceRoot,
      encoding: "utf8"
    }).status, 0);
    assert.equal(spawnSync("git", ["config", "user.name", "Clone Test"], {
      cwd: sourceRoot,
      encoding: "utf8"
    }).status, 0);

    writeFileSync(join(sourceRoot, "README.md"), "repo create clone slice\n", "utf8");

    assert.equal(spawnSync("git", ["add", "README.md"], {
      cwd: sourceRoot,
      encoding: "utf8"
    }).status, 0);
    assert.equal(spawnSync("git", ["commit", "-m", "seed repository"], {
      cwd: sourceRoot,
      encoding: "utf8"
    }).status, 0);
    assert.equal(spawnSync("git", ["remote", "add", "origin", remoteRoot], {
      cwd: sourceRoot,
      encoding: "utf8"
    }).status, 0);
    assert.equal(spawnSync("git", ["push", "-u", "origin", "main"], {
      cwd: sourceRoot,
      encoding: "utf8"
    }).status, 0);
    assert.equal(spawnSync("git", ["--git-dir", remoteRoot, "symbolic-ref", "HEAD", "refs/heads/main"], {
      encoding: "utf8"
    }).status, 0);

    const port = getServerPort(server);
    const result = await executeCli([
      "repo",
      "create",
      "project-clone",
      "--public",
      "--clone"
    ], {
      cwd: cloneParent,
      env: {
        GTEA_HOST: `127.0.0.1:${port}`,
        GTEA_TOKEN: "repo-create-token"
      }
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, `http://127.0.0.1:${port}/octo/project-clone\n`);
    assert.equal(result.stderr, "");
    assert.equal(
      readFileSync(join(cloneParent, "project-clone", "README.md"), "utf8").replace(/\r\n/g, "\n"),
      "repo create clone slice\n"
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve();
      })
    );
    rmSync(remoteRoot, { force: true, recursive: true });
    rmSync(sourceRoot, { force: true, recursive: true });
    rmSync(cloneParent, { force: true, recursive: true });
  }
});

test("repo create rejects unsupported template-based creation flags explicitly", async () => {
  const result = await executeCli([
    "repo",
    "create",
    "project-admin",
    "--public",
    "--template",
    "starter"
  ]);

  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /repo create flag --template is currently unsupported/i);
});

test("repo rename renames the selected repository", async () => {
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== "token repo-rename-token") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "unauthorized" }));
      return;
    }

    if (request.method !== "PATCH" || request.url !== "/api/v1/repos/octo/project") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "not found" }));
      return;
    }

    let requestBody = "";

    for await (const chunk of request) {
      requestBody += chunk;
    }

    assert.deepEqual(JSON.parse(requestBody), {
      name: "project-renamed"
    });

    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      name: "project-renamed",
      private: false,
      html_url: `http://127.0.0.1:${getServerPort(server)}/octo/project-renamed`,
      owner: {
        login: "octo"
      }
    }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const port = getServerPort(server);

  try {
    const result = await executeCli([
      "repo",
      "rename",
      "-R",
      `127.0.0.1:${port}/octo/project`,
      "project-renamed",
      "--yes"
    ], {
      env: {
        GTEA_HOST: `127.0.0.1:${port}`,
        GTEA_TOKEN: "repo-rename-token"
      }
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, `http://127.0.0.1:${port}/octo/project-renamed\n`);
    assert.equal(result.stderr, "");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve();
      })
    );
  }
});

test("repo fork creates a fork for the authenticated user", async () => {
  let sawUserLookup = false;

  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== "token repo-fork-token") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "unauthorized" }));
      return;
    }

    if (request.method === "GET" && request.url === "/api/v1/user") {
      sawUserLookup = true;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ login: "builder" }));
      return;
    }

    if (request.method !== "POST" || request.url !== "/api/v1/repos/octo/project/forks") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "not found" }));
      return;
    }

    let requestBody = "";

    for await (const chunk of request) {
      requestBody += chunk;
    }

    assert.deepEqual(JSON.parse(requestBody), {
      name: "project-fork"
    });

    response.writeHead(202, { "content-type": "application/json" });
    response.end(JSON.stringify({
      name: "project-fork",
      private: false,
      html_url: `http://127.0.0.1:${getServerPort(server)}/builder/project-fork`,
      owner: {
        login: "builder"
      }
    }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const port = getServerPort(server);

  try {
    const result = await executeCli([
      "repo",
      "fork",
      "octo/project",
      "--fork-name",
      "project-fork"
    ], {
      env: {
        GTEA_HOST: `127.0.0.1:${port}`,
        GTEA_TOKEN: "repo-fork-token"
      }
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, `http://127.0.0.1:${port}/builder/project-fork\n`);
    assert.equal(result.stderr, "");
    assert.equal(sawUserLookup, true);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve();
      })
    );
  }
});

test("release list reads repository releases from the selected Gitea host", async () => {
  let port = 0;

  const server = createServer((request, response) => {
    if (request.url !== "/api/v1/repos/octo/project/releases") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "not found" }));
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify([
        {
          tag_name: "v1.0.0",
          name: "First stable release",
          draft: false,
          prerelease: false,
          html_url: `http://127.0.0.1:${port}/octo/project/releases/tag/v1.0.0`
        },
        {
          tag_name: "v1.1.0-rc1",
          name: "Release candidate",
          draft: true,
          prerelease: true,
          html_url: `http://127.0.0.1:${port}/octo/project/releases/tag/v1.1.0-rc1`
        }
      ])
    );
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = getServerPort(server);

  try {
    const result = await executeCli(["release", "list", "-R", `127.0.0.1:${port}/octo/project`]);

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /v1\.0\.0 \[published\] First stable release/);
    assert.match(result.stdout, /v1\.1\.0-rc1 \[draft, prerelease\] Release candidate/);
    assert.equal(result.stderr, "");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve();
      })
    );
  }
});

test("release view supports manifest-backed json output fields with asset metadata", async () => {
  let port = 0;

  const server = createServer((request, response) => {
    if (request.url !== "/api/v1/repos/octo/project/releases/tags/v1.0.0") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "not found" }));
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        tag_name: "v1.0.0",
        name: "First stable release",
        body: "Release notes",
        draft: false,
        prerelease: false,
        created_at: "2026-05-05T12:00:00Z",
        published_at: "2026-05-06T12:00:00Z",
        target_commitish: "main",
        html_url: `http://127.0.0.1:${port}/octo/project/releases/tag/v1.0.0`,
        assets: [
          {
            name: "gtea-windows.zip",
            size: 1024,
            browser_download_url: `http://127.0.0.1:${port}/downloads/gtea-windows.zip`,
            content_type: "application/zip"
          }
        ]
      })
    );
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = getServerPort(server);

  try {
    const result = await executeCli([
      "release",
      "view",
      "v1.0.0",
      "-R",
      `127.0.0.1:${port}/octo/project`,
      "--json",
      "tagName,name,body,targetCommitish,assets,url"
    ]);

    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(result.stdout), {
      tagName: "v1.0.0",
      name: "First stable release",
      body: "Release notes",
      targetCommitish: "main",
      assets: [
        {
          name: "gtea-windows.zip",
          size: 1024,
          downloadUrl: `http://127.0.0.1:${port}/downloads/gtea-windows.zip`,
          contentType: "application/zip"
        }
      ],
      url: `http://127.0.0.1:${port}/octo/project/releases/tag/v1.0.0`
    });
    assert.equal(result.stderr, "");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve();
      })
    );
  }
});

test("release create posts the selected release metadata to the Gitea host", async () => {
  let port = 0;
  let requestBody = "";

  const server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/api/v1/repos/octo/project/releases") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "not found" }));
      return;
    }

    assert.equal(request.headers.authorization, "token release-create-token");

    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      requestBody += chunk;
    });
    request.on("end", () => {
      response.writeHead(201, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          tag_name: "v1.2.3",
          name: "Version 1.2.3",
          body: "Bug fixes and polish",
          draft: true,
          prerelease: true,
          target_commitish: "release-branch",
          html_url: `http://127.0.0.1:${port}/octo/project/releases/tag/v1.2.3`
        })
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = getServerPort(server);

  try {
    const result = await executeCli([
      "release",
      "create",
      "v1.2.3",
      "-R",
      "octo/project",
      "--title",
      "Version 1.2.3",
      "--notes",
      "Bug fixes and polish",
      "--draft",
      "--prerelease",
      "--target",
      "release-branch"
    ], {
      env: {
        GTEA_HOST: `127.0.0.1:${port}`,
        GTEA_TOKEN: "release-create-token"
      }
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, `http://127.0.0.1:${port}/octo/project/releases/tag/v1.2.3\n`);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(requestBody), {
      tag_name: "v1.2.3",
      name: "Version 1.2.3",
      body: "Bug fixes and polish",
      draft: true,
      prerelease: true,
      target_commitish: "release-branch"
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve();
      })
    );
  }
});

test("release edit patches the selected release metadata on the Gitea host", async () => {
  let port = 0;
  let requestBody = "";

  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/api/v1/repos/octo/project/releases/tags/v1.2.3") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: 42,
          tag_name: "v1.2.3",
          name: "Version 1.2.3",
          body: "Existing notes",
          draft: true,
          prerelease: true,
          target_commitish: "release-branch",
          html_url: `http://127.0.0.1:${port}/octo/project/releases/tag/v1.2.3`
        })
      );
      return;
    }

    if (request.method === "PATCH" && request.url === "/api/v1/repos/octo/project/releases/42") {
      assert.equal(request.headers.authorization, "token release-edit-token");
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        requestBody += chunk;
      });
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            tag_name: "v1.2.3",
            name: "Version 1.2.3 Updated",
            body: "Polished release notes",
            draft: false,
            prerelease: false,
            target_commitish: "main",
            html_url: `http://127.0.0.1:${port}/octo/project/releases/tag/v1.2.3`
          })
        );
      });
      return;
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ message: "not found" }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = getServerPort(server);

  try {
    const result = await executeCli([
      "release",
      "edit",
      "v1.2.3",
      "-R",
      "octo/project",
      "--title",
      "Version 1.2.3 Updated",
      "--notes",
      "Polished release notes",
      "--draft=false",
      "--prerelease=false",
      "--target",
      "main"
    ], {
      env: {
        GTEA_HOST: `127.0.0.1:${port}`,
        GTEA_TOKEN: "release-edit-token"
      }
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, `http://127.0.0.1:${port}/octo/project/releases/tag/v1.2.3\n`);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(requestBody), {
      name: "Version 1.2.3 Updated",
      body: "Polished release notes",
      draft: false,
      prerelease: false,
      target_commitish: "main"
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve();
      })
    );
  }
});

test("release delete removes the selected release quietly", async () => {
  let port = 0;

  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/api/v1/repos/octo/project/releases/tags/v1.2.3") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: 42, tag_name: "v1.2.3" }));
      return;
    }

    if (request.method === "DELETE" && request.url === "/api/v1/repos/octo/project/releases/42") {
      assert.equal(request.headers.authorization, "token release-delete-token");
      response.writeHead(204).end();
      return;
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ message: "not found" }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = getServerPort(server);

  try {
    const result = await executeCli([
      "release",
      "delete",
      "v1.2.3",
      "-R",
      "octo/project",
      "--yes"
    ], {
      env: {
        GTEA_HOST: `127.0.0.1:${port}`,
        GTEA_TOKEN: "release-delete-token"
      }
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve();
      })
    );
  }
});

test("release upload posts a release asset to the selected Gitea host", async () => {
  let port = 0;
  const assetRoot = mkdtempSync(join(tmpdir(), "gtea-release-upload-"));
  const assetPath = join(assetRoot, "gtea-windows.zip");
  const uploadedChunks: Buffer[] = [];

  writeFileSync(assetPath, "zip-data", "utf8");

  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/api/v1/repos/octo/project/releases/tags/v1.2.3") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: 42, tag_name: "v1.2.3" }));
      return;
    }

    if (request.method === "POST" && request.url === "/api/v1/repos/octo/project/releases/42/assets?name=gtea-windows.zip") {
      assert.equal(request.headers.authorization, "token release-upload-token");
      assert.equal(request.headers["content-type"], "application/octet-stream");
      request.on("data", (chunk) => {
        uploadedChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      request.on("end", () => {
        response.writeHead(201, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            name: "gtea-windows.zip",
            size: 8,
            browser_download_url: `http://127.0.0.1:${port}/downloads/gtea-windows.zip`
          })
        );
      });
      return;
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ message: "not found" }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = getServerPort(server);

  try {
    const result = await executeCli([
      "release",
      "upload",
      "v1.2.3",
      "-R",
      "octo/project",
      assetPath
    ], {
      env: {
        GTEA_HOST: `127.0.0.1:${port}`,
        GTEA_TOKEN: "release-upload-token"
      }
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    assert.equal(Buffer.concat(uploadedChunks).toString("utf8"), "zip-data");
  } finally {
    rmSync(assetRoot, { force: true, recursive: true });
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve();
      })
    );
  }
});

test("release download saves matching assets into the requested directory", async () => {
  let port = 0;
  const downloadRoot = mkdtempSync(join(tmpdir(), "gtea-release-download-"));

  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/api/v1/repos/octo/project/releases/tags/v1.2.3") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          tag_name: "v1.2.3",
          assets: [
            {
              name: "gtea-windows.zip",
              size: 8,
              browser_download_url: `http://127.0.0.1:${port}/downloads/gtea-windows.zip`,
              content_type: "application/zip"
            },
            {
              name: "release-notes.txt",
              size: 5,
              browser_download_url: `http://127.0.0.1:${port}/downloads/release-notes.txt`,
              content_type: "text/plain"
            }
          ]
        })
      );
      return;
    }

    if (request.method === "GET" && request.url === "/downloads/gtea-windows.zip") {
      assert.equal(request.headers.authorization, "token release-download-token");
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end("zip-data");
      return;
    }

    if (request.method === "GET" && request.url === "/downloads/release-notes.txt") {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end("pattern should have filtered this asset");
      return;
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ message: "not found" }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = getServerPort(server);

  try {
    const result = await executeCli([
      "release",
      "download",
      "v1.2.3",
      "-R",
      "octo/project",
      "--dir",
      downloadRoot,
      "--pattern",
      "*.zip"
    ], {
      env: {
        GTEA_HOST: `127.0.0.1:${port}`,
        GTEA_TOKEN: "release-download-token"
      }
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    assert.equal(readFileSync(join(downloadRoot, "gtea-windows.zip"), "utf8"), "zip-data");
  } finally {
    rmSync(downloadRoot, { force: true, recursive: true });
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve();
      })
    );
  }
});

test("issue list requires a Repository Context when no repo is provided", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "gtea-issue-context-"));

  try {
    const result = await executeCli(["issue", "list"], { cwd });

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /No Repository Context selected/i);
  } finally {
    rmSync(cwd, { force: true, recursive: true });
  }
});

test("issue help exposes the full manifest-backed issue tree", async () => {
  const result = await executeCli(["issue", "--help"]);

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

test("issue view help classifies --comments as supported", async () => {
  const result = await executeCli(["issue", "view", "--help"]);

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /--comments[\s\S]*supported/i);
});

test("issue edit help classifies supported and unsupported metadata flags", async () => {
  const result = await executeCli(["issue", "edit", "--help"]);

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /--body-file[\s\S]*\[supported\]/i);
  assert.match(result.stdout, /--add-label[\s\S]*\[supported\]/i);
  assert.match(result.stdout, /--remove-label[\s\S]*\[supported\]/i);
  assert.match(result.stdout, /--add-assignee[\s\S]*\[supported\]/i);
  assert.match(result.stdout, /--remove-assignee[\s\S]*\[supported\]/i);
  assert.match(result.stdout, /--milestone[\s\S]*\[supported\]/i);
  assert.match(result.stdout, /--remove-milestone[\s\S]*\[supported\]/i);
  assert.match(result.stdout, /--add-project[\s\S]*\[unsupported\]/i);
  assert.match(result.stdout, /--remove-project[\s\S]*\[unsupported\]/i);
});

test("issue create help classifies supported, emulated, and unsupported flags", async () => {
  const result = await executeCli(["issue", "create", "--help"]);

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /--title, -t[\s\S]*\[supported\]/i);
  assert.match(result.stdout, /--body, -b[\s\S]*\[supported\]/i);
  assert.match(result.stdout, /--body-file, -F[\s\S]*\[supported\]/i);
  assert.match(result.stdout, /--assignee, -a[\s\S]*\[emulated\]/i);
  assert.match(result.stdout, /--label, -l[\s\S]*\[emulated\]/i);
  assert.match(result.stdout, /--milestone, -m[\s\S]*\[emulated\]/i);
  assert.match(result.stdout, /--editor, -e[\s\S]*\[unsupported\]/i);
  assert.match(result.stdout, /--project, -p[\s\S]*\[unsupported\]/i);
  assert.match(result.stdout, /--recover[\s\S]*\[unsupported\]/i);
  assert.match(result.stdout, /--template, -T[\s\S]*\[unsupported\]/i);
  assert.match(result.stdout, /--web, -w[\s\S]*\[unsupported\]/i);
});

test("pr create help classifies supported and unsupported write flags", async () => {
  const result = await executeCli(["pr", "create", "--help"]);

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /--repo, -R[\s\S]*\[supported\]/i);
  assert.match(result.stdout, /--base, -B[\s\S]*\[supported\]/i);
  assert.match(result.stdout, /--body-file, -F[\s\S]*\[supported\]/i);
  assert.match(result.stdout, /--head, -H[\s\S]*\[supported\]/i);
  assert.match(result.stdout, /--draft, -d[\s\S]*\[unsupported\]/i);
  assert.match(result.stdout, /--reviewer, -r[\s\S]*\[unsupported\]/i);
  assert.match(result.stdout, /--web, -w[\s\S]*\[unsupported\]/i);
});

test("pr comment, review, and merge help classify the supported PR write slice", async () => {
  const commentHelp = await executeCli(["pr", "comment", "--help"]);
  const reviewHelp = await executeCli(["pr", "review", "--help"]);
  const mergeHelp = await executeCli(["pr", "merge", "--help"]);

  assert.equal(commentHelp.exitCode, 0);
  assert.match(commentHelp.stdout, /--body, -b[\s\S]*\[supported\]/i);
  assert.match(commentHelp.stdout, /--body-file, -F[\s\S]*\[supported\]/i);
  assert.match(commentHelp.stdout, /--edit-last[\s\S]*\[unsupported\]/i);
  assert.match(commentHelp.stdout, /--web, -w[\s\S]*\[unsupported\]/i);

  assert.equal(reviewHelp.exitCode, 0);
  assert.match(reviewHelp.stdout, /--approve, -a[\s\S]*\[supported\]/i);
  assert.match(reviewHelp.stdout, /--comment, -c[\s\S]*\[supported\]/i);
  assert.match(reviewHelp.stdout, /--request-changes, -r[\s\S]*\[supported\]/i);
  assert.match(reviewHelp.stdout, /--body-file, -F[\s\S]*\[supported\]/i);

  assert.equal(mergeHelp.exitCode, 0);
  assert.match(mergeHelp.stdout, /--admin[\s\S]*\[supported\]/i);
  assert.match(mergeHelp.stdout, /--squash, -s[\s\S]*\[supported\]/i);
  assert.match(mergeHelp.stdout, /--delete-branch, -d[\s\S]*\[supported\]/i);
  assert.match(mergeHelp.stdout, /--auto[\s\S]*\[unsupported\]/i);
  assert.match(mergeHelp.stdout, /--author-email, -A[\s\S]*\[unsupported\]/i);
});

test("issue list help classifies supported and unsupported list flags", async () => {
  const result = await executeCli(["issue", "list", "--help"]);

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /--state, -s[\s\S]*\[supported\]/i);
  assert.match(result.stdout, /--assignee, -a[\s\S]*\[supported\]/i);
  assert.match(result.stdout, /--web, -w[\s\S]*\[unsupported\]/i);
});

test("issue view reads a single issue from the selected Gitea host", async () => {
  const server = createServer((request, response) => {
    if (request.url !== "/api/v1/repos/octo/project/issues/42") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "not found" }));
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        number: 42,
        title: "Ship the issue read slice",
        state: "open"
      })
    );
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const port = getServerPort(server);

  try {
    const result = await executeCli(["issue", "view", "42", "-R", `127.0.0.1:${port}/octo/project`]);

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /Ship the issue read slice/);
    assert.match(result.stdout, /open/i);
    assert.match(result.stdout, new RegExp(`http://127\\.0\\.0\\.1:${port}/octo/project/issues/42`));
    assert.equal(result.stderr, "");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve();
      })
    );
  }
});

test("issue view shows a gh-shaped summary with newest comment preview", async () => {
  let issueRequests = 0;
  let commentRequests = 0;

  const server = createServer((request, response) => {
    if (request.url === "/api/v1/repos/octo/project/issues/42") {
      issueRequests += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          number: 42,
          title: "Ship the richer issue summary",
          state: "open",
          body: "Issue body text for triage.",
          user: {
            login: "issue-author"
          },
          labels: [
            { name: "enhancement" },
            { name: "ready-for-agent" }
          ],
          comments: 3,
          created_at: "2026-05-03T10:00:00Z"
        })
      );
      return;
    }

    if (request.url === "/api/v1/repos/octo/project/issues/42/comments") {
      commentRequests += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify([
          {
            id: 1,
            body: "First comment",
            user: { login: "first-commenter" },
            created_at: "2026-05-03T10:10:00Z"
          },
          {
            id: 2,
            body: "Second comment",
            user: { login: "second-commenter" },
            created_at: "2026-05-03T10:20:00Z"
          },
          {
            id: 3,
            body: "Newest comment body",
            user: { login: "latest-commenter" },
            created_at: "2026-05-03T10:30:00Z"
          }
        ])
      );
      return;
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ message: "not found" }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = getServerPort(server);

  try {
    const result = await executeCli(["issue", "view", "42", "-R", `127.0.0.1:${port}/octo/project`]);

    assert.equal(result.exitCode, 0);
    assert.equal(issueRequests, 1);
    assert.equal(commentRequests, 1);
    assert.match(result.stdout, /Ship the richer issue summary/);
    assert.match(result.stdout, /Issue body text for triage\./);
    assert.match(result.stdout, /issue-author/);
    assert.match(result.stdout, /Labels: enhancement, ready-for-agent/);
    assert.match(result.stdout, /Not showing 2 comments/);
    assert.match(result.stdout, /latest-commenter/);
    assert.match(result.stdout, /Newest comment body/);
    assert.equal(result.stderr, "");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve();
      })
    );
  }
});

test("issue view --comments shows the full issue conversation", async () => {
  let commentRequests = 0;

  const server = createServer((request, response) => {
    if (request.url === "/api/v1/repos/octo/project/issues/42") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          number: 42,
          title: "Ship the richer issue summary",
          state: "open",
          body: "Issue body text for triage.",
          user: {
            login: "issue-author"
          },
          labels: [
            { name: "enhancement" }
          ],
          comments: 2
        })
      );
      return;
    }

    if (request.url === "/api/v1/repos/octo/project/issues/42/comments") {
      commentRequests += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify([
          {
            id: 1,
            body: "First visible comment",
            user: { login: "first-commenter" }
          },
          {
            id: 2,
            body: "Second visible comment",
            user: { login: "second-commenter" }
          }
        ])
      );
      return;
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ message: "not found" }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const port = getServerPort(server);

  try {
    const result = await executeCli([
      "issue",
      "view",
      "42",
      "-R",
      `127.0.0.1:${port}/octo/project`,
      "--comments"
    ]);

    assert.equal(result.exitCode, 0);
    assert.equal(commentRequests, 1);
    assert.match(result.stdout, /First visible comment/);
    assert.match(result.stdout, /Second visible comment/);
    assert.doesNotMatch(result.stdout, /Not showing/);
    assert.equal(result.stderr, "");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve();
      })
    );
  }
});

test("issue view --comments surfaces authentication failures from the discussion read path", async () => {
  const server = createServer((request, response) => {
    if (request.url === "/api/v1/repos/octo/project/issues/42") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          number: 42,
          title: "Ship the richer issue summary",
          state: "open",
          comments: 1
        })
      );
      return;
    }

    if (request.url === "/api/v1/repos/octo/project/issues/42/comments") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "unauthorized" }));
      return;
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ message: "not found" }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const port = getServerPort(server);

  try {
    const result = await executeCli([
      "issue",
      "view",
      "42",
      "-R",
      `127.0.0.1:${port}/octo/project`,
      "--comments"
    ]);

    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Authentication failed while reading issue #42/i);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve();
      })
    );
  }
});

test("pr view reads a single pull request from the selected Gitea host", async () => {
  const server = createServer((request, response) => {
    if (request.url !== "/api/v1/repos/octo/project/pulls/42") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "not found" }));
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        number: 42,
        title: "Ship the pull request read slice",
        state: "open",
        base: {
          ref: "main"
        },
        head: {
          ref: "feature/pr-read"
        }
      })
    );
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const port = getServerPort(server);

  try {
    const result = await executeCli(["pr", "view", "42", "-R", `127.0.0.1:${port}/octo/project`]);

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /Ship the pull request read slice/);
    assert.match(result.stdout, /open/i);
    assert.match(result.stdout, /feature\/pr-read/);
    assert.match(result.stdout, /main/);
    assert.match(result.stdout, new RegExp(`http://127\\.0\\.0\\.1:${port}/octo/project/pulls/42`));
    assert.equal(result.stderr, "");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve();
      })
    );
  }
});

test("issue list reads repository issues from the selected Gitea host", async () => {
  const server = createServer((request, response) => {
    if (request.url !== "/api/v1/repos/octo/project/issues?state=open") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "not found" }));
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify([
        {
          number: 7,
          title: "Validate repository context reuse",
          state: "open"
        },
        {
          number: 12,
          title: "Document the issue read contract",
          state: "open"
        }
      ])
    );
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const port = getServerPort(server);

  try {
    const result = await executeCli(["issue", "list", "-R", `127.0.0.1:${port}/octo/project`]);

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /#7/);
    assert.match(result.stdout, /Validate repository context reuse/);
    assert.match(result.stdout, /#12/);
    assert.match(result.stdout, /open/i);
    assert.equal(result.stderr, "");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve();
      })
    );
  }
});

test("issue list skips unusable entries and tolerates null nested records", async () => {
  const server = createServer((request, response) => {
    if (request.url !== "/api/v1/repos/octo/project/issues?state=open") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "not found" }));
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify([
        null,
        {
          number: 42,
          title: "Ship resilient issue reads",
          state: "open",
          user: null,
          assignee: null,
          assignees: [
            null,
            {
              id: 11,
              login: "hubot",
              full_name: "Hub O. T."
            }
          ],
          labels: [
            null,
            {
              name: "feature"
            }
          ]
        },
        {
          number: 0,
          title: "This entry should be skipped too",
          state: "open"
        },
        {
          number: 1.5,
          title: "This fractional entry should be skipped",
          state: "open"
        },
        {
          title: "This entry should be skipped",
          state: "open"
        }
      ])
    );
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const port = getServerPort(server);

  try {
    const result = await executeCli([
      "issue",
      "list",
      "-R",
      `127.0.0.1:${port}/octo/project`,
      "--json",
      "assignees,author,labels,number,title"
    ]);

    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(result.stdout), [
      {
        assignees: [
          {
            id: 11,
            login: "hubot",
            name: "Hub O. T."
          }
        ],
        author: null,
        labels: [
          {
            id: null,
            name: "feature",
            description: null,
            color: null
          }
        ],
        number: 42,
        title: "Ship resilient issue reads"
      }
    ]);
    assert.equal(result.stderr, "");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve();
      })
    );
  }
});

test("issue list accepts an explicit http host-qualified -R target", async () => {
  const server = createServer((request, response) => {
    if (request.url !== "/api/v1/repos/octo/project/issues?state=open") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "not found" }));
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify([
        {
          number: 7,
          title: "Validate explicit host-qualified repository targets",
          state: "open"
        }
      ])
    );
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const port = getServerPort(server);

  try {
    const result = await executeCli(["issue", "list", "-R", `http://127.0.0.1:${port}/octo/project`]);

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /#7/);
    assert.match(result.stdout, /Validate explicit host-qualified repository targets/);
    assert.equal(result.stderr, "");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve();
      })
    );
  }
});

test("issue list supports state filtering with manifest-backed json output fields", async () => {
  const server = createServer((request, response) => {
    if (request.url === "/api/v1/repos/octo/project/issues/42/comments") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify([
          {
            id: 900,
            body: "Latest discussion",
            created_at: "2026-05-05T07:00:00Z",
            updated_at: "2026-05-05T07:30:00Z",
            html_url: "http://127.0.0.1/issue-comments/900",
            user: {
              id: 13,
              login: "reviewer",
              full_name: "Reviewer One"
            }
          }
        ])
      );
      return;
    }

    if (request.url !== "/api/v1/repos/octo/project/issues?state=all") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "not found" }));
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify([
        {
          id: 4200,
          number: 42,
          title: "Ship the issue list slice",
          state: "closed",
          body: "List issue body",
          created_at: "2026-05-04T12:00:00Z",
          updated_at: "2026-05-05T08:30:00Z",
          closed_at: "2026-05-05T09:00:00Z",
          comments: 2,
          pin_order: 1,
          user: {
            id: 7,
            login: "octocat",
            full_name: "The Octocat"
          },
          assignees: [
            {
              id: 11,
              login: "hubot",
              full_name: "Hub O. T."
            }
          ],
          labels: [
            {
              id: 100,
              name: "feature",
              description: "Feature work",
              color: "00aabb"
            }
          ],
          milestone: {
            id: 9,
            title: "Broad First",
            description: "Ship the next slice",
            state: "open",
            created_at: "2026-05-03T10:00:00Z",
            updated_at: "2026-05-04T10:30:00Z",
            closed_at: null
          }
        }
      ])
    );
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const port = getServerPort(server);
  const issueUrl = `http://127.0.0.1:${port}/octo/project/issues/42`;

  try {
    const result = await executeCli([
      "issue",
      "list",
      "-R",
      `127.0.0.1:${port}/octo/project`,
      "--state",
      "all",
      "--json",
      "assignees,author,body,closed,closedAt,comments,createdAt,id,isPinned,labels,milestone,number,state,title,updatedAt,url"
    ]);

    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(result.stdout), [
      {
        assignees: [
          {
            id: 11,
            login: "hubot",
            name: "Hub O. T."
          }
        ],
        author: {
          id: 7,
          login: "octocat",
          name: "The Octocat"
        },
        body: "List issue body",
        closed: true,
        closedAt: "2026-05-05T09:00:00Z",
        comments: [
          {
            id: 900,
            author: {
              id: 13,
              login: "reviewer",
              name: "Reviewer One"
            },
            body: "Latest discussion",
            createdAt: "2026-05-05T07:00:00Z",
            updatedAt: "2026-05-05T07:30:00Z",
            url: "http://127.0.0.1/issue-comments/900"
          }
        ],
        createdAt: "2026-05-04T12:00:00Z",
        id: 4200,
        isPinned: true,
        labels: [
          {
            id: 100,
            name: "feature",
            description: "Feature work",
            color: "00aabb"
          }
        ],
        milestone: {
          id: 9,
          title: "Broad First",
          description: "Ship the next slice",
          state: "open",
          createdAt: "2026-05-03T10:00:00Z",
          updatedAt: "2026-05-04T10:30:00Z",
          closedAt: null
        },
        number: 42,
        state: "closed",
        title: "Ship the issue list slice",
        updatedAt: "2026-05-05T08:30:00Z",
        url: issueUrl
      }
    ]);
    assert.equal(result.stderr, "");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve();
      })
    );
  }
});

test("issue list renders empty comment arrays for issues without comments in json output", async () => {
  const server = createServer((request, response) => {
    if (request.url !== "/api/v1/repos/octo/project/issues?state=open") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "not found" }));
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify([
        {
          number: 42,
          title: "Ship the issue list slice",
          state: "open",
          comments: 0
        }
      ])
    );
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const port = getServerPort(server);

  try {
    const result = await executeCli([
      "issue",
      "list",
      "-R",
      `127.0.0.1:${port}/octo/project`,
      "--json",
      "comments,number"
    ]);

    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(result.stdout), [
      {
        comments: [],
        number: 42
      }
    ]);
    assert.equal(result.stderr, "");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve();
      })
    );
  }
});

test("issue list reports an empty filtered result using the requested state", async () => {
  const server = createServer((request, response) => {
    if (request.url !== "/api/v1/repos/octo/project/issues?state=closed") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "not found" }));
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify([]));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const port = getServerPort(server);

  try {
    const result = await executeCli([
      "issue",
      "list",
      "-R",
      `127.0.0.1:${port}/octo/project`,
      "--state",
      "closed"
    ]);

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "No closed issues found.\n");
    assert.equal(result.stderr, "");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve();
      })
    );
  }
});

test("issue list translates supported filters into the Gitea repository issue query", async () => {
  const server = createServer((request, response) => {
    if (
      request.url
      !== "/api/v1/repos/octo/project/issues?state=open&labels=bug%2Cdocs&q=error&milestones=1&created_by=monalisa&assigned_by=hubot&mentioned_by=reviewer&limit=25"
    ) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "not found" }));
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify([
        {
          number: 7,
          title: "Filter translation works",
          state: "open",
          labels: [
            {
              id: 100,
              name: "bug",
              description: "Bug work",
              color: "ee0701"
            },
            {
              id: 101,
              name: "docs",
              description: "Documentation work",
              color: "0075ca"
            }
          ]
        }
      ])
    );
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const port = getServerPort(server);

  try {
    const result = await executeCli([
      "issue",
      "list",
      "-R",
      `127.0.0.1:${port}/octo/project`,
      "--author",
      "monalisa",
      "--assignee",
      "hubot",
      "--label",
      "bug",
      "--label",
      "docs",
      "--mention",
      "reviewer",
      "--milestone",
      "1",
      "--search",
      "error",
      "--limit",
      "25",
      "--json",
      "number"
    ]);

    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(result.stdout), [
      {
        number: 7
      }
    ]);
    assert.equal(result.stderr, "");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve();
      })
    );
  }
});

test("issue list enforces requested label filters on returned issues", async () => {
  const server = createServer((request, response) => {
    if (request.url !== "/api/v1/repos/octo/project/issues?state=open&labels=ready-for-agent") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "not found" }));
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify([
        {
          number: 7,
          title: "This issue should be filtered out",
          state: "open",
          labels: [
            {
              id: 10,
              name: "bug",
              description: "Something is broken",
              color: "ee0701"
            }
          ]
        },
        {
          number: 8,
          title: "This issue matches the requested label",
          state: "open",
          labels: [
            {
              id: 11,
              name: "ready-for-agent",
              description: "Queued for automation",
              color: "006b75"
            }
          ]
        }
      ])
    );
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const port = getServerPort(server);

  try {
    const result = await executeCli([
      "issue",
      "list",
      "-R",
      `127.0.0.1:${port}/octo/project`,
      "--label",
      "ready-for-agent",
      "--json",
      "labels,number,title"
    ]);

    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(result.stdout), [
      {
        labels: [
          {
            id: 11,
            name: "ready-for-agent",
            description: "Queued for automation",
            color: "006b75"
          }
        ],
        number: 8,
        title: "This issue matches the requested label"
      }
    ]);
    assert.equal(result.stderr, "");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve();
      })
    );
  }
});

test("issue list reports empty results after client-side label filtering", async () => {
  const server = createServer((request, response) => {
    if (request.url !== "/api/v1/repos/octo/project/issues?state=open&labels=ready-for-agent") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "not found" }));
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify([
        {
          number: 7,
          title: "This issue should be filtered out",
          state: "open",
          labels: [
            {
              id: 10,
              name: "bug",
              description: "Something is broken",
              color: "ee0701"
            }
          ]
        }
      ])
    );
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const port = getServerPort(server);

  try {
    const jsonResult = await executeCli([
      "issue",
      "list",
      "-R",
      `127.0.0.1:${port}/octo/project`,
      "--label",
      "ready-for-agent",
      "--json",
      "number"
    ]);

    assert.equal(jsonResult.exitCode, 0);
    assert.deepEqual(JSON.parse(jsonResult.stdout), []);
    assert.equal(jsonResult.stderr, "");

    const textResult = await executeCli([
      "issue",
      "list",
      "-R",
      `127.0.0.1:${port}/octo/project`,
      "--label",
      "ready-for-agent"
    ]);

    assert.equal(textResult.exitCode, 0);
    assert.equal(textResult.stdout, "No open issues found.\n");
    assert.equal(textResult.stderr, "");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve();
      })
    );
  }
});

test("issue list rejects unsupported web listings explicitly", async () => {
  const result = await executeCli(["issue", "list", "--web"]);

  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    "gtea issue list flag --web is currently unsupported: Browser issue listings with gh-compatible filter propagation are not part of the supported issue list slice.\n"
  );
});

test("pr list reads repository pull requests from the selected Gitea host", async () => {
  const server = createServer((request, response) => {
    if (request.url !== "/api/v1/repos/octo/project/pulls?state=open") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "not found" }));
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify([
        {
          number: 7,
          title: "Add structured PR reads",
          state: "open",
          head: {
            ref: "feature/pr-read"
          },
          base: {
            ref: "main"
          }
        },
        {
          number: 12,
          title: "Document checkout semantics",
          state: "open",
          head: {
            ref: "docs/checkout"
          },
          base: {
            ref: "main"
          }
        }
      ])
    );
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const port = getServerPort(server);

  try {
    const result = await executeCli(["pr", "list", "-R", `127.0.0.1:${port}/octo/project`]);

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /#7/);
    assert.match(result.stdout, /Add structured PR reads/);
    assert.match(result.stdout, /feature\/pr-read -> main/);
    assert.match(result.stdout, /#12/);
    assert.match(result.stdout, /Document checkout semantics/);
    assert.equal(result.stderr, "");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve();
      })
    );
  }
});

test("issue view supports manifest-backed json output fields", async () => {
  const server = createServer((request, response) => {
    if (request.url === "/api/v1/repos/octo/project/issues/42/comments") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify([
          {
            id: 900,
            body: "Latest discussion",
            created_at: "2026-05-05T07:00:00Z",
            updated_at: "2026-05-05T07:30:00Z",
            html_url: "http://127.0.0.1/issue-comments/900",
            user: {
              id: 13,
              login: "reviewer",
              full_name: "Reviewer One"
            }
          }
        ])
      );
      return;
    }

    if (request.url !== "/api/v1/repos/octo/project/issues/42") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "not found" }));
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        id: 4200,
        number: 42,
        title: "Ship the issue read slice",
        state: "open",
        body: "Issue body",
        created_at: "2026-05-04T12:00:00Z",
        updated_at: "2026-05-05T08:30:00Z",
        closed_at: null,
        comments: 1,
        pin_order: 1,
        user: {
          id: 7,
          login: "octocat",
          full_name: "The Octocat"
        },
        assignees: [
          {
            id: 11,
            login: "hubot",
            full_name: "Hub O. T."
          }
        ],
        labels: [
          {
            id: 100,
            name: "feature",
            description: "Feature work",
            color: "00aabb"
          }
        ],
        milestone: {
          id: 9,
          title: "Broad First",
          description: "Ship the next slice",
          state: "open",
          created_at: "2026-05-03T10:00:00Z",
          updated_at: "2026-05-04T10:30:00Z",
          closed_at: null
        }
      })
    );
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const port = getServerPort(server);
  const issueUrl = `http://127.0.0.1:${port}/octo/project/issues/42`;

  try {
    const result = await executeCli([
      "issue",
      "view",
      "42",
      "-R",
      `127.0.0.1:${port}/octo/project`,
      "--json",
      "assignees,author,body,closed,closedAt,comments,createdAt,id,isPinned,labels,milestone,number,state,title,updatedAt,url"
    ]);

    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(result.stdout), {
      assignees: [
        {
          id: 11,
          login: "hubot",
          name: "Hub O. T."
        }
      ],
      author: {
        id: 7,
        login: "octocat",
        name: "The Octocat"
      },
      body: "Issue body",
      closed: false,
      closedAt: null,
      comments: [
        {
          id: 900,
          author: {
            id: 13,
            login: "reviewer",
            name: "Reviewer One"
          },
          body: "Latest discussion",
          createdAt: "2026-05-05T07:00:00Z",
          updatedAt: "2026-05-05T07:30:00Z",
          url: "http://127.0.0.1/issue-comments/900"
        }
      ],
      createdAt: "2026-05-04T12:00:00Z",
      id: 4200,
      isPinned: true,
      labels: [
        {
          id: 100,
          name: "feature",
          description: "Feature work",
          color: "00aabb"
        }
      ],
      milestone: {
        id: 9,
        title: "Broad First",
        description: "Ship the next slice",
        state: "open",
        createdAt: "2026-05-03T10:00:00Z",
        updatedAt: "2026-05-04T10:30:00Z",
        closedAt: null
      },
      number: 42,
      title: "Ship the issue read slice",
      state: "open",
      updatedAt: "2026-05-05T08:30:00Z",
      url: issueUrl
    });
    assert.equal(result.stderr, "");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve();
      })
    );
  }
});

test("issue view maps a lone Gitea assignee into the gh-shaped assignees field", async () => {
  const server = createServer((request, response) => {
    if (request.url !== "/api/v1/repos/octo/project/issues/42") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "not found" }));
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        number: 42,
        title: "Ship the issue read slice",
        state: "open",
        assignee: {
          id: 11,
          login: "hubot",
          full_name: "Hub O. T."
        }
      })
    );
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const port = getServerPort(server);

  try {
    const result = await executeCli([
      "issue",
      "view",
      "42",
      "-R",
      `127.0.0.1:${port}/octo/project`,
      "--json",
      "assignees"
    ]);

    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(result.stdout), {
      assignees: [
        {
          id: 11,
          login: "hubot",
          name: "Hub O. T."
        }
      ]
    });
    assert.equal(result.stderr, "");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve();
      })
    );
  }
});

test("issue view tolerates null nested records and null comment entries", async () => {
  const server = createServer((request, response) => {
    if (request.url === "/api/v1/repos/octo/project/issues/42/comments") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify([
          [],
          null,
          {
            id: 900,
            body: "Latest discussion",
            user: null
          }
        ])
      );
      return;
    }

    if (request.url !== "/api/v1/repos/octo/project/issues/42") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "not found" }));
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        number: 42,
        title: "Ship resilient issue reads",
        state: "open",
        comments: 2,
        user: null,
        assignee: null,
        assignees: [
          null,
          {
            id: 11,
            login: "hubot",
            full_name: "Hub O. T."
          }
        ],
        labels: [
          null,
          {
            name: "feature"
          }
        ]
      })
    );
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const port = getServerPort(server);
  const commentUrl = `http://127.0.0.1:${port}/octo/project/issues/42#issuecomment-900`;

  try {
    const result = await executeCli([
      "issue",
      "view",
      "42",
      "-R",
      `127.0.0.1:${port}/octo/project`,
      "--json",
      "assignees,author,comments,labels,number"
    ]);

    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(result.stdout), {
      assignees: [
        {
          id: 11,
          login: "hubot",
          name: "Hub O. T."
        }
      ],
      author: null,
      comments: [
        {
          id: 900,
          author: null,
          body: "Latest discussion",
          createdAt: null,
          updatedAt: null,
          url: commentUrl
        }
      ],
      labels: [
        {
          id: null,
          name: "feature",
          description: null,
          color: null
        }
      ],
      number: 42
    });
    assert.equal(result.stderr, "");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve();
      })
    );
  }
});

test("issue view rejects a non-object issue payload", async () => {
  const server = createServer((request, response) => {
    if (request.url !== "/api/v1/repos/octo/project/issues/42") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "not found" }));
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify([]));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const port = getServerPort(server);

  try {
    const result = await executeCli([
      "issue",
      "view",
      "42",
      "-R",
      `127.0.0.1:${port}/octo/project`
    ]);

    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "Gitea returned an invalid issue payload while reading issue #42.\n");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve();
      })
    );
  }
});

test("issue view rejects manifest-declared unsupported json output fields", async () => {
  const server = createServer((request, response) => {
    if (request.url !== "/api/v1/repos/octo/project/issues/42") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "not found" }));
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        number: 42,
        title: "Ship the issue read slice",
        state: "open"
      })
    );
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const port = getServerPort(server);

  try {
    const result = await executeCli([
      "issue",
      "view",
      "42",
      "-R",
      `127.0.0.1:${port}/octo/project`,
      "--json",
      "number,projectCards"
    ]);

    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "Unsupported JSON field(s): projectCards\n");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve();
      })
    );
  }
});

test("pr view supports manifest-backed json output fields", async () => {
  const server = createServer((request, response) => {
    if (request.url !== "/api/v1/repos/octo/project/pulls/42") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "not found" }));
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        number: 42,
        title: "Ship the pull request read slice",
        state: "open",
        base: {
          ref: "main"
        },
        head: {
          ref: "feature/pr-read"
        }
      })
    );
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const port = getServerPort(server);

  try {
    const result = await executeCli([
      "pr",
      "view",
      "42",
      "-R",
      `127.0.0.1:${port}/octo/project`,
      "--json",
      "number,title,state,headRefName,baseRefName,url"
    ]);

    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(result.stdout), {
      number: 42,
      title: "Ship the pull request read slice",
      state: "open",
      headRefName: "feature/pr-read",
      baseRefName: "main",
      url: `http://127.0.0.1:${port}/octo/project/pulls/42`
    });
    assert.equal(result.stderr, "");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve();
      })
    );
  }
});

test("issue view supports jq filtering on json output", async () => {
  const server = createServer((request, response) => {
    if (request.url === "/api/v1/repos/octo/project/issues/42/comments") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify([
          {
            id: 900,
            body: "Latest discussion",
            user: {
              login: "reviewer"
            }
          },
          {
            id: 901,
            body: "Follow-up",
            user: {
              login: "maintainer"
            }
          }
        ])
      );
      return;
    }

    if (request.url !== "/api/v1/repos/octo/project/issues/42") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "not found" }));
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        number: 42,
        title: "Ship the issue read slice",
        state: "open",
        comments: 2
      })
    );
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const port = getServerPort(server);

  try {
    const result = await executeCli([
      "issue",
      "view",
      "42",
      "-R",
      `127.0.0.1:${port}/octo/project`,
      "--json",
      "comments",
      "--jq",
      ".comments[].body"
    ]);

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "\"Latest discussion\"\n\"Follow-up\"\n");
    assert.equal(result.stderr, "");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve();
      })
    );
  }
});

test("pr view supports jq filtering on json output", async () => {
  const server = createServer((request, response) => {
    if (request.url !== "/api/v1/repos/octo/project/pulls/42") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "not found" }));
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        number: 42,
        title: "Ship the pull request read slice",
        state: "open",
        base: {
          ref: "main"
        },
        head: {
          ref: "feature/pr-read"
        }
      })
    );
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const port = getServerPort(server);

  try {
    const result = await executeCli([
      "pr",
      "view",
      "42",
      "-R",
      `127.0.0.1:${port}/octo/project`,
      "--json",
      "number,title,state,headRefName,baseRefName,url",
      "--jq",
      ".number"
    ]);

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "42\n");
    assert.equal(result.stderr, "");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve();
      })
    );
  }
});

test("issue view supports template formatting on json output", async () => {
  const server = createServer((request, response) => {
    if (request.url !== "/api/v1/repos/octo/project/issues/42") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "not found" }));
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        number: 42,
        title: "Ship the issue read slice",
        body: "Issue body",
        state: "open",
        user: {
          login: "octocat"
        }
      })
    );
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const port = getServerPort(server);

  try {
    const result = await executeCli([
      "issue",
      "view",
      "42",
      "-R",
      `127.0.0.1:${port}/octo/project`,
      "--json",
      "author,body",
      "--template",
      "{{.author.login}}: {{.body}}"
    ]);

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "octocat: Issue body\n");
    assert.equal(result.stderr, "");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve();
      })
    );
  }
});

test("pr view supports template formatting on json output", async () => {
  const server = createServer((request, response) => {
    if (request.url !== "/api/v1/repos/octo/project/pulls/42") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "not found" }));
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        number: 42,
        title: "Ship the pull request read slice",
        state: "open",
        base: {
          ref: "main"
        },
        head: {
          ref: "feature/pr-read"
        }
      })
    );
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const port = getServerPort(server);

  try {
    const result = await executeCli([
      "pr",
      "view",
      "42",
      "-R",
      `127.0.0.1:${port}/octo/project`,
      "--json",
      "number,title,state,headRefName,baseRefName,url",
      "--template",
      "{{.title}} (#{{.number}})"
    ]);

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "Ship the pull request read slice (#42)\n");
    assert.equal(result.stderr, "");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve();
      })
    );
  }
});

test("issue status reports relevant open issues for the authenticated user", async () => {
  const server = createServer((request, response) => {
    if (request.headers.authorization !== "token status-token") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "unauthorized" }));
      return;
    }

    if (request.url === "/api/v1/user") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ login: "octocat" }));
      return;
    }

    if (request.url === "/api/v1/repos/octo/project/issues?state=open") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify([
          {
            number: 7,
            title: "Validate repository context reuse",
            state: "open",
            assignees: [{ login: "octocat" }],
            user: { login: "teammate" }
          },
          {
            number: 12,
            title: "Document the issue read contract",
            state: "open",
            assignees: [],
            user: { login: "octocat" }
          },
          {
            number: 21,
            title: "Unrelated issue",
            state: "open",
            assignees: [{ login: "someone-else" }],
            user: { login: "someone-else" }
          }
        ])
      );
      return;
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ message: "not found" }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const port = getServerPort(server);

  try {
    const result = await executeCli(["issue", "status", "-R", `127.0.0.1:${port}/octo/project`], {
      env: {
        GTEA_HOST: `127.0.0.1:${port}`,
        GTEA_TOKEN: "status-token"
      }
    });

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /Assigned to you/);
    assert.match(result.stdout, /Validate repository context reuse/);
    assert.match(result.stdout, /Opened by you/);
    assert.match(result.stdout, /Document the issue read contract/);
    assert.doesNotMatch(result.stdout, /Unrelated issue/);
    assert.equal(result.stderr, "");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve();
      })
    );
  }
});

test("pr status reports relevant open pull requests for the authenticated user", async () => {
  const server = createServer((request, response) => {
    if (request.headers.authorization !== "token pr-status-token") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "unauthorized" }));
      return;
    }

    if (request.url === "/api/v1/user") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ login: "octocat" }));
      return;
    }

    if (request.url === "/api/v1/repos/octo/project/pulls?state=open") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify([
          {
            number: 7,
            title: "Review the structured output contract",
            state: "open",
            assignees: [{ login: "octocat" }],
            user: { login: "teammate" },
            head: { ref: "feature/pr-read" },
            base: { ref: "main" }
          },
          {
            number: 12,
            title: "Document checkout behavior",
            state: "open",
            assignees: [],
            user: { login: "octocat" },
            head: { ref: "docs/checkout" },
            base: { ref: "main" }
          },
          {
            number: 21,
            title: "Unrelated pull request",
            state: "open",
            assignees: [{ login: "someone-else" }],
            user: { login: "someone-else" },
            head: { ref: "feature/unrelated" },
            base: { ref: "main" }
          }
        ])
      );
      return;
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ message: "not found" }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const port = getServerPort(server);

  try {
    const result = await executeCli(["pr", "status", "-R", `127.0.0.1:${port}/octo/project`], {
      env: {
        GTEA_HOST: `127.0.0.1:${port}`,
        GTEA_TOKEN: "pr-status-token"
      }
    });

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /Assigned to you/);
    assert.match(result.stdout, /Review the structured output contract/);
    assert.match(result.stdout, /Opened by you/);
    assert.match(result.stdout, /Document checkout behavior/);
    assert.doesNotMatch(result.stdout, /Unrelated pull request/);
    assert.equal(result.stderr, "");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve();
      })
    );
  }
});

test("pr create posts a new pull request to the selected Gitea host", async () => {
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== "token pr-create-token") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "unauthorized" }));
      return;
    }

    if (request.method !== "POST" || request.url !== "/api/v1/repos/octo/project/pulls") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "not found" }));
      return;
    }

    let requestBody = "";

    for await (const chunk of request) {
      requestBody += chunk;
    }

    assert.deepEqual(JSON.parse(requestBody), {
      base: "main",
      head: "feature/pr-write",
      title: "Ship the pull request write slice",
      body: "Implement create first."
    });

    response.writeHead(201, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        number: 18,
        title: "Ship the pull request write slice",
        state: "open",
        base: {
          ref: "main"
        },
        head: {
          ref: "feature/pr-write"
        }
      })
    );
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const port = getServerPort(server);

  try {
    const result = await executeCli([
      "pr",
      "create",
      "-R",
      `127.0.0.1:${port}/octo/project`,
      "--base",
      "main",
      "--head",
      "feature/pr-write",
      "--title",
      "Ship the pull request write slice",
      "--body",
      "Implement create first."
    ], {
      env: {
        GTEA_HOST: `127.0.0.1:${port}`,
        GTEA_TOKEN: "pr-create-token"
      }
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, `http://127.0.0.1:${port}/octo/project/pulls/18\n`);
    assert.equal(result.stderr, "");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve();
      })
    );
  }
});

test("pr comment posts a comment to the selected Gitea host", async () => {
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== "token pr-comment-token") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "unauthorized" }));
      return;
    }

    if (request.method !== "POST" || request.url !== "/api/v1/repos/octo/project/issues/18/comments") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "not found" }));
      return;
    }

    let requestBody = "";

    for await (const chunk of request) {
      requestBody += chunk;
    }

    assert.deepEqual(JSON.parse(requestBody), {
      body: "Looks good from the CLI."
    });

    response.writeHead(201, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: 7, body: "Looks good from the CLI." }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const port = getServerPort(server);

  try {
    const result = await executeCli([
      "pr",
      "comment",
      "18",
      "-R",
      `127.0.0.1:${port}/octo/project`,
      "--body",
      "Looks good from the CLI."
    ], {
      env: {
        GTEA_HOST: `127.0.0.1:${port}`,
        GTEA_TOKEN: "pr-comment-token"
      }
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve();
      })
    );
  }
});

test("pr review submits an approval review to the selected Gitea host", async () => {
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== "token pr-review-token") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "unauthorized" }));
      return;
    }

    if (request.method !== "POST" || request.url !== "/api/v1/repos/octo/project/pulls/18/reviews") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "not found" }));
      return;
    }

    let requestBody = "";

    for await (const chunk of request) {
      requestBody += chunk;
    }

    assert.deepEqual(JSON.parse(requestBody), {
      event: "APPROVED",
      body: "Approved from the CLI."
    });

    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: 4, state: "APPROVED" }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const port = getServerPort(server);

  try {
    const result = await executeCli([
      "pr",
      "review",
      "18",
      "-R",
      `127.0.0.1:${port}/octo/project`,
      "--approve",
      "--body",
      "Approved from the CLI."
    ], {
      env: {
        GTEA_HOST: `127.0.0.1:${port}`,
        GTEA_TOKEN: "pr-review-token"
      }
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve();
      })
    );
  }
});

test("pr merge posts the selected merge method and merge options to the Gitea host", async () => {
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== "token pr-merge-token") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "unauthorized" }));
      return;
    }

    if (request.method !== "POST" || request.url !== "/api/v1/repos/octo/project/pulls/18/merge") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "not found" }));
      return;
    }

    let requestBody = "";

    for await (const chunk of request) {
      requestBody += chunk;
    }

    assert.deepEqual(JSON.parse(requestBody), {
      do: "squash",
      delete_branch_after_merge: true,
      merge_title_field: "Ship the write slice",
      merge_message_field: "Merge it from the CLI."
    });

    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({}));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const port = getServerPort(server);

  try {
    const result = await executeCli([
      "pr",
      "merge",
      "18",
      "-R",
      `127.0.0.1:${port}/octo/project`,
      "--squash",
      "--delete-branch",
      "--subject",
      "Ship the write slice",
      "--body",
      "Merge it from the CLI."
    ], {
      env: {
        GTEA_HOST: `127.0.0.1:${port}`,
        GTEA_TOKEN: "pr-merge-token"
      }
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve();
      })
    );
  }
});

test("pr merge reports merge policy failures from the selected Gitea host", async () => {
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== "token pr-merge-token") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "unauthorized" }));
      return;
    }

    if (request.method !== "POST" || request.url !== "/api/v1/repos/octo/project/pulls/18/merge") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "not found" }));
      return;
    }

    response.writeHead(405, { "content-type": "application/json" });
    response.end(JSON.stringify({ message: "required checks are still pending" }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const port = getServerPort(server);

  try {
    const result = await executeCli([
      "pr",
      "merge",
      "18",
      "-R",
      `127.0.0.1:${port}/octo/project`
    ], {
      env: {
        GTEA_HOST: `127.0.0.1:${port}`,
        GTEA_TOKEN: "pr-merge-token"
      }
    });

    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, "");
    assert.equal(
      result.stderr,
      "Merge blocked for pull request #18 in octo/project: required checks are still pending\n"
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve();
      })
    );
  }
});

test("pr merge rejects unsupported auto-merge semantics explicitly", async () => {
  const result = await executeCli([
    "pr",
    "merge",
    "18",
    "-R",
    "https://example.com/octo/project",
    "--auto"
  ]);

  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    "gtea pr merge flag --auto is currently unsupported: Auto-merge queue semantics are not part of the supported pull request merge slice.\n"
  );
});

test("issue create posts a new issue to the selected Gitea host", async () => {
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== "token create-token") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "unauthorized" }));
      return;
    }

    if (request.method !== "POST" || request.url !== "/api/v1/repos/octo/project/issues") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "not found" }));
      return;
    }

    let requestBody = "";

    for await (const chunk of request) {
      requestBody += chunk;
    }

    assert.deepEqual(JSON.parse(requestBody), {
      title: "Ship the issue maintenance slice",
      body: "Implement create first."
    });

    response.writeHead(201, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        number: 18,
        title: "Ship the issue maintenance slice",
        state: "open"
      })
    );
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const port = getServerPort(server);

  try {
    const result = await executeCli([
      "issue",
      "create",
      "-R",
      `127.0.0.1:${port}/octo/project`,
      "--title",
      "Ship the issue maintenance slice",
      "--body",
      "Implement create first."
    ], {
      env: {
        GTEA_HOST: `127.0.0.1:${port}`,
        GTEA_TOKEN: "create-token"
      }
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, `http://127.0.0.1:${port}/octo/project/issues/18\n`);
    assert.equal(result.stderr, "");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve();
      })
    );
  }
});

test("issue create reads the issue body from --body-file", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "gtea-issue-create-body-file-"));
  const bodyPath = join(tempDir, "issue-body.md");
  writeFileSync(bodyPath, "Create body from file\n");

  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== "token create-token") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "unauthorized" }));
      return;
    }

    if (request.method !== "POST" || request.url !== "/api/v1/repos/octo/project/issues") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "not found" }));
      return;
    }

    let requestBody = "";

    for await (const chunk of request) {
      requestBody += chunk;
    }

    assert.deepEqual(JSON.parse(requestBody), {
      title: "Ship the issue maintenance slice",
      body: "Create body from file\n"
    });

    response.writeHead(201, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        number: 19,
        title: "Ship the issue maintenance slice",
        state: "open"
      })
    );
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const port = getServerPort(server);

  try {
    const result = await executeCli([
      "issue",
      "create",
      "-R",
      `127.0.0.1:${port}/octo/project`,
      "--title",
      "Ship the issue maintenance slice",
      "--body-file",
      bodyPath
    ], {
      env: {
        GTEA_HOST: `127.0.0.1:${port}`,
        GTEA_TOKEN: "create-token"
      }
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, `http://127.0.0.1:${port}/octo/project/issues/19\n`);
    assert.equal(result.stderr, "");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve();
      })
    );
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test("issue create reads body text from stdin when --body-file - is used", async () => {
  let requestPayload: unknown;

  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== "token create-token") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "unauthorized" }));
      return;
    }

    if (request.method !== "POST" || request.url !== "/api/v1/repos/octo/project/issues") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "not found" }));
      return;
    }

    let requestBody = "";

    for await (const chunk of request) {
      requestBody += chunk;
    }

    requestPayload = JSON.parse(requestBody);

    response.writeHead(201, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        number: 19,
        title: "Ship the issue maintenance slice",
        state: "open"
      })
    );
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const port = getServerPort(server);

  try {
    const result = await executeCli([
      "issue",
      "create",
      "-R",
      `127.0.0.1:${port}/octo/project`,
      "--title",
      "Ship the issue maintenance slice",
      "--body-file",
      "-"
    ], {
      env: {
        GTEA_HOST: `127.0.0.1:${port}`,
        GTEA_TOKEN: "create-token"
      },
      stdin: "Body from stdin\nSecond line\n"
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, `http://127.0.0.1:${port}/octo/project/issues/19\n`);
    assert.equal(result.stderr, "");
    assert.deepEqual(requestPayload, {
      title: "Ship the issue maintenance slice",
      body: "Body from stdin\nSecond line\n"
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve();
      })
    );
  }
});

test("issue create applies supported assignee, label, and milestone metadata flags", async () => {
  let sawCreate = false;
  let sawIssueRead = false;
  let sawCurrentUserRead = false;
  let sawLabelsRead = false;
  let sawMilestonesRead = false;
  let sawIssuePatch = false;
  let sawLabelUpdate = false;

  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== "token create-token") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "unauthorized" }));
      return;
    }

    if (request.method === "POST" && request.url === "/api/v1/repos/octo/project/issues") {
      sawCreate = true;

      let requestBody = "";

      for await (const chunk of request) {
        requestBody += chunk;
      }

      assert.deepEqual(JSON.parse(requestBody), {
        title: "Ship the issue create slice",
        body: "Create it with metadata."
      });

      response.writeHead(201, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          number: 21,
          title: "Ship the issue create slice",
          state: "open"
        })
      );
      return;
    }

    if (request.method === "GET" && request.url === "/api/v1/repos/octo/project/issues/21") {
      sawIssueRead = true;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          number: 21,
          title: "Ship the issue create slice",
          state: "open",
          labels: [],
          assignees: [],
          milestone: null
        })
      );
      return;
    }

    if (request.method === "GET" && request.url === "/api/v1/user") {
      sawCurrentUserRead = true;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ login: "hubot" }));
      return;
    }

    if (request.method === "GET" && request.url === "/api/v1/repos/octo/project/labels") {
      sawLabelsRead = true;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify([{ id: 4, name: "triage" }]));
      return;
    }

    if (request.method === "GET" && request.url === "/api/v1/repos/octo/project/milestones?state=all") {
      sawMilestonesRead = true;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify([{ id: 8, title: "Sprint 2" }]));
      return;
    }

    if (request.method === "PATCH" && request.url === "/api/v1/repos/octo/project/issues/21") {
      sawIssuePatch = true;

      let requestBody = "";

      for await (const chunk of request) {
        requestBody += chunk;
      }

      assert.deepEqual(JSON.parse(requestBody), {
        assignees: ["hubot"],
        milestone: 8
      });

      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          number: 21,
          title: "Ship the issue create slice",
          state: "open"
        })
      );
      return;
    }

    if (request.method === "PUT" && request.url === "/api/v1/repos/octo/project/issues/21/labels") {
      sawLabelUpdate = true;

      let requestBody = "";

      for await (const chunk of request) {
        requestBody += chunk;
      }

      assert.deepEqual(JSON.parse(requestBody), {
        labels: [4]
      });

      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify([{ id: 4, name: "triage" }]));
      return;
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ message: "not found" }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const port = getServerPort(server);

  try {
    const result = await executeCli([
      "issue",
      "create",
      "-R",
      `127.0.0.1:${port}/octo/project`,
      "--title",
      "Ship the issue create slice",
      "--body",
      "Create it with metadata.",
      "--assignee",
      "@me",
      "--label",
      "triage",
      "--milestone",
      "Sprint 2"
    ], {
      env: {
        GTEA_HOST: `127.0.0.1:${port}`,
        GTEA_TOKEN: "create-token"
      }
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, `http://127.0.0.1:${port}/octo/project/issues/21\n`);
    assert.equal(result.stderr, "");
    assert.equal(sawCreate, true);
    assert.equal(sawIssueRead, true);
    assert.equal(sawCurrentUserRead, true);
    assert.equal(sawLabelsRead, true);
    assert.equal(sawMilestonesRead, true);
    assert.equal(sawIssuePatch, true);
    assert.equal(sawLabelUpdate, true);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve();
      })
    );
  }
});

test("issue create reports create-scoped lookup failures during metadata planning", async () => {
  let sawCreate = false;
  let sawIssueRead = false;
  let sawLabelUpdate = false;

  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== "token create-token") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "unauthorized" }));
      return;
    }

    if (request.method === "POST" && request.url === "/api/v1/repos/octo/project/issues") {
      sawCreate = true;
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({ number: 22, title: "Create with labels", state: "open" }));
      return;
    }

    if (request.method === "GET" && request.url === "/api/v1/repos/octo/project/issues/22") {
      sawIssueRead = true;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ number: 22, title: "Create with labels", state: "open", labels: [] }));
      return;
    }

    if (request.method === "GET" && request.url === "/api/v1/repos/octo/project/labels") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "unauthorized" }));
      return;
    }

    if (request.method === "PUT" && request.url === "/api/v1/repos/octo/project/issues/22/labels") {
      sawLabelUpdate = true;
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ message: "not found" }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const port = getServerPort(server);

  try {
    const result = await executeCli([
      "issue",
      "create",
      "-R",
      `127.0.0.1:${port}/octo/project`,
      "--title",
      "Create with labels",
      "--label",
      "triage"
    ], {
      env: {
        GTEA_HOST: `127.0.0.1:${port}`,
        GTEA_TOKEN: "create-token"
      }
    });

    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /authentication failed while creating issue #22 on 127\.0\.0\.1:/i);
    assert.doesNotMatch(result.stderr, /editing issue/i);
    assert.equal(sawCreate, true);
    assert.equal(sawIssueRead, true);
    assert.equal(sawLabelUpdate, false);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve();
      })
    );
  }
});

test("issue create reports create-scoped label update failures", async () => {
  let sawCreate = false;
  let sawLabelUpdate = false;

  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== "token create-token") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "unauthorized" }));
      return;
    }

    if (request.method === "POST" && request.url === "/api/v1/repos/octo/project/issues") {
      sawCreate = true;
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({ number: 23, title: "Create with labels", state: "open" }));
      return;
    }

    if (request.method === "GET" && request.url === "/api/v1/repos/octo/project/issues/23") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ number: 23, title: "Create with labels", state: "open", labels: [] }));
      return;
    }

    if (request.method === "GET" && request.url === "/api/v1/repos/octo/project/labels") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify([{ id: 4, name: "triage" }]));
      return;
    }

    if (request.method === "PUT" && request.url === "/api/v1/repos/octo/project/issues/23/labels") {
      sawLabelUpdate = true;
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "unauthorized" }));
      return;
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ message: "not found" }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const port = getServerPort(server);

  try {
    const result = await executeCli([
      "issue",
      "create",
      "-R",
      `127.0.0.1:${port}/octo/project`,
      "--title",
      "Create with labels",
      "--label",
      "triage"
    ], {
      env: {
        GTEA_HOST: `127.0.0.1:${port}`,
        GTEA_TOKEN: "create-token"
      }
    });

    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /authentication failed while creating issue #23 on 127\.0\.0\.1:/i);
    assert.doesNotMatch(result.stderr, /editing issue/i);
    assert.equal(sawCreate, true);
    assert.equal(sawLabelUpdate, true);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve();
      })
    );
  }
});

test("pr diff prints the unified diff for the selected pull request", async () => {
  const server = createServer((request, response) => {
    if (request.url !== "/api/v1/repos/octo/project/pulls/42.diff") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "not found" }));
      return;
    }

    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end(
      [
        "diff --git a/src/pr.ts b/src/pr.ts",
        "index 1111111..2222222 100644",
        "--- a/src/pr.ts",
        "+++ b/src/pr.ts",
        "@@ -1,1 +1,2 @@",
        "+console.log('pr diff')"
      ].join("\n") + "\n"
    );
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const port = getServerPort(server);

  try {
    const result = await executeCli(["pr", "diff", "42", "-R", `127.0.0.1:${port}/octo/project`]);

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /diff --git a\/src\/pr\.ts b\/src\/pr\.ts/);
    assert.match(result.stdout, /\+console\.log\('pr diff'\)/);
    assert.equal(result.stderr, "");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve();
      })
    );
  }
});

test("pr checks fails clearly when no honest semantic match exists", async () => {
  const result = await executeCli(["pr", "checks"]);

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /gtea pr checks is currently unsupported/i);
  assert.match(result.stderr, /no compatible check-run surface/i);
  assert.equal(result.stdout, "");
});

test("issue comment posts a comment to the selected Gitea host", async () => {
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== "token comment-token") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "unauthorized" }));
      return;
    }

    if (request.method !== "POST" || request.url !== "/api/v1/repos/octo/project/issues/18/comments") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "not found" }));
      return;
    }

    let requestBody = "";

    for await (const chunk of request) {
      requestBody += chunk;
    }

    assert.deepEqual(JSON.parse(requestBody), {
      body: "Comment from gtea"
    });

    response.writeHead(201, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: 9 }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const port = getServerPort(server);

  try {
    const result = await executeCli([
      "issue",
      "comment",
      "18",
      "-R",
      `127.0.0.1:${port}/octo/project`,
      "--body",
      "Comment from gtea"
    ], {
      env: {
        GTEA_HOST: `127.0.0.1:${port}`,
        GTEA_TOKEN: "comment-token"
      }
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve();
      })
    );
  }
});

test("issue edit patches the selected issue on the Gitea host", async () => {
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== "token edit-token") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "unauthorized" }));
      return;
    }

    if (request.method !== "PATCH" || request.url !== "/api/v1/repos/octo/project/issues/18") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "not found" }));
      return;
    }

    let requestBody = "";

    for await (const chunk of request) {
      requestBody += chunk;
    }

    assert.deepEqual(JSON.parse(requestBody), {
      title: "Retitle the issue",
      body: "Updated issue body"
    });

    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        number: 18,
        title: "Retitle the issue",
        state: "open"
      })
    );
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const port = getServerPort(server);

  try {
    const result = await executeCli([
      "issue",
      "edit",
      "18",
      "-R",
      `127.0.0.1:${port}/octo/project`,
      "--title",
      "Retitle the issue",
      "--body",
      "Updated issue body"
    ], {
      env: {
        GTEA_HOST: `127.0.0.1:${port}`,
        GTEA_TOKEN: "edit-token"
      }
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve();
      })
    );
  }
});

test("issue edit processes multiple issue numbers sequentially and keeps going after a failure", async () => {
  const seenIssueNumbers: number[] = [];

  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== "token edit-token") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "unauthorized" }));
      return;
    }

    if (
      request.method === "PATCH"
      && (request.url === "/api/v1/repos/octo/project/issues/18" || request.url === "/api/v1/repos/octo/project/issues/19")
    ) {
      const issueNumber = request.url.endsWith("/19") ? 19 : 18;
      seenIssueNumbers.push(issueNumber);

      let requestBody = "";

      for await (const chunk of request) {
        requestBody += chunk;
      }

      assert.deepEqual(JSON.parse(requestBody), {
        title: "Retitle the issue"
      });

      if (issueNumber === 19) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ message: "not found" }));
        return;
      }

      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          number: issueNumber,
          title: "Retitle the issue",
          state: "open"
        })
      );
      return;
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ message: "not found" }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const port = getServerPort(server);

  try {
    const result = await executeCli([
      "issue",
      "edit",
      "18",
      "19",
      "-R",
      `127.0.0.1:${port}/octo/project`,
      "--title",
      "Retitle the issue"
    ], {
      env: {
        GTEA_HOST: `127.0.0.1:${port}`,
        GTEA_TOKEN: "edit-token"
      }
    });

    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /issue #19 was not found in octo\/project/i);
    assert.deepEqual(seenIssueNumbers, [18, 19]);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve();
      })
    );
  }
});

test("issue edit succeeds quietly across multiple issue numbers", async () => {
  const seenIssueNumbers: number[] = [];

  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== "token edit-token") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "unauthorized" }));
      return;
    }

    if (
      request.method === "PATCH"
      && (request.url === "/api/v1/repos/octo/project/issues/18" || request.url === "/api/v1/repos/octo/project/issues/19")
    ) {
      const issueNumber = request.url.endsWith("/19") ? 19 : 18;
      seenIssueNumbers.push(issueNumber);

      let requestBody = "";

      for await (const chunk of request) {
        requestBody += chunk;
      }

      assert.deepEqual(JSON.parse(requestBody), {
        body: "Updated issue body"
      });

      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          number: issueNumber,
          title: `Issue ${issueNumber}`,
          state: "open"
        })
      );
      return;
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ message: "not found" }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const port = getServerPort(server);

  try {
    const result = await executeCli([
      "issue",
      "edit",
      "18",
      "19",
      "-R",
      `127.0.0.1:${port}/octo/project`,
      "--body",
      "Updated issue body"
    ], {
      env: {
        GTEA_HOST: `127.0.0.1:${port}`,
        GTEA_TOKEN: "edit-token"
      }
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    assert.deepEqual(seenIssueNumbers, [18, 19]);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve();
      })
    );
  }
});

test("issue edit reads the updated body from --body-file and stays quiet on success", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "gtea-issue-edit-body-file-"));
  const bodyPath = join(tempDir, "issue-body.md");
  writeFileSync(bodyPath, "Updated issue body from file\n");

  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== "token edit-token") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "unauthorized" }));
      return;
    }

    if (request.method !== "PATCH" || request.url !== "/api/v1/repos/octo/project/issues/18") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "not found" }));
      return;
    }

    let requestBody = "";

    for await (const chunk of request) {
      requestBody += chunk;
    }

    assert.deepEqual(JSON.parse(requestBody), {
      body: "Updated issue body from file\n"
    });

    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        number: 18,
        title: "Retitle the issue",
        state: "open"
      })
    );
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const port = getServerPort(server);

  try {
    const result = await executeCli([
      "issue",
      "edit",
      "18",
      "-R",
      `127.0.0.1:${port}/octo/project`,
      "--body-file",
      bodyPath
    ], {
      env: {
        GTEA_HOST: `127.0.0.1:${port}`,
        GTEA_TOKEN: "edit-token"
      }
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve();
      })
    );
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test("issue edit reads body text from stdin when --body-file - is used", async () => {
  let requestPayload: unknown;

  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== "token edit-token") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "unauthorized" }));
      return;
    }

    if (request.method !== "PATCH" || request.url !== "/api/v1/repos/octo/project/issues/18") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "not found" }));
      return;
    }

    let requestBody = "";

    for await (const chunk of request) {
      requestBody += chunk;
    }

    requestPayload = JSON.parse(requestBody);

    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        number: 18,
        title: "Retitle the issue",
        state: "open"
      })
    );
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const port = getServerPort(server);

  try {
    const result = await executeCli([
      "issue",
      "edit",
      "18",
      "-R",
      `127.0.0.1:${port}/octo/project`,
      "--body-file",
      "-"
    ], {
      env: {
        GTEA_HOST: `127.0.0.1:${port}`,
        GTEA_TOKEN: "edit-token"
      },
      stdin: "Updated issue body from stdin\n"
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    assert.deepEqual(requestPayload, {
      body: "Updated issue body from stdin\n"
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve();
      })
    );
  }
});

test("issue edit applies supported label, assignee, and milestone metadata changes", async () => {
  let sawIssueRead = false;
  let sawCurrentUserRead = false;
  let sawLabelsRead = false;
  let sawMilestonesRead = false;
  let sawIssuePatch = false;
  let sawLabelUpdate = false;

  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== "token edit-token") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "unauthorized" }));
      return;
    }

    if (request.method === "GET" && request.url === "/api/v1/repos/octo/project/issues/18") {
      sawIssueRead = true;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          number: 18,
          title: "Retitle the issue",
          state: "open",
          labels: [
            { id: 1, name: "bug" },
            { id: 2, name: "help wanted" }
          ],
          assignees: [
            { login: "octocat" },
            { login: "someone-else" }
          ],
          milestone: { id: 3, title: "Backlog" }
        })
      );
      return;
    }

    if (request.method === "GET" && request.url === "/api/v1/user") {
      sawCurrentUserRead = true;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ login: "hubot" }));
      return;
    }

    if (request.method === "GET" && request.url === "/api/v1/repos/octo/project/labels") {
      sawLabelsRead = true;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify([
          { id: 1, name: "bug" },
          { id: 2, name: "help wanted" },
          { id: 4, name: "triage" }
        ])
      );
      return;
    }

    if (request.method === "GET" && request.url === "/api/v1/repos/octo/project/milestones?state=all") {
      sawMilestonesRead = true;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify([
          { id: 3, title: "Backlog" },
          { id: 8, title: "Sprint 2" }
        ])
      );
      return;
    }

    if (request.method === "PATCH" && request.url === "/api/v1/repos/octo/project/issues/18") {
      sawIssuePatch = true;

      let requestBody = "";

      for await (const chunk of request) {
        requestBody += chunk;
      }

      assert.deepEqual(JSON.parse(requestBody), {
        assignees: ["octocat", "hubot"],
        milestone: 8
      });

      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          number: 18,
          title: "Retitle the issue",
          state: "open"
        })
      );
      return;
    }

    if (request.method === "PUT" && request.url === "/api/v1/repos/octo/project/issues/18/labels") {
      sawLabelUpdate = true;

      let requestBody = "";

      for await (const chunk of request) {
        requestBody += chunk;
      }

      assert.deepEqual(JSON.parse(requestBody), {
        labels: [1, 4]
      });

      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify([{ id: 1, name: "bug" }, { id: 4, name: "triage" }]));
      return;
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ message: "not found" }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const port = getServerPort(server);

  try {
    const result = await executeCli([
      "issue",
      "edit",
      "18",
      "-R",
      `127.0.0.1:${port}/octo/project`,
      "--add-label",
      "triage",
      "--remove-label",
      "help wanted",
      "--add-assignee",
      "@me",
      "--remove-assignee",
      "someone-else",
      "--milestone",
      "Sprint 2"
    ], {
      env: {
        GTEA_HOST: `127.0.0.1:${port}`,
        GTEA_TOKEN: "edit-token"
      }
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    assert.equal(sawIssueRead, true);
    assert.equal(sawCurrentUserRead, true);
    assert.equal(sawLabelsRead, true);
    assert.equal(sawMilestonesRead, true);
    assert.equal(sawIssuePatch, true);
    assert.equal(sawLabelUpdate, true);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve();
      })
    );
  }
});

test("issue edit removes the milestone when --remove-milestone is used", async () => {
  let sawIssueRead = false;
  let sawIssuePatch = false;

  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== "token edit-token") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "unauthorized" }));
      return;
    }

    if (request.method === "GET" && request.url === "/api/v1/repos/octo/project/issues/18") {
      sawIssueRead = true;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          number: 18,
          title: "Retitle the issue",
          state: "open",
          milestone: { id: 3, title: "Backlog" }
        })
      );
      return;
    }

    if (request.method === "PATCH" && request.url === "/api/v1/repos/octo/project/issues/18") {
      sawIssuePatch = true;

      let requestBody = "";

      for await (const chunk of request) {
        requestBody += chunk;
      }

      assert.deepEqual(JSON.parse(requestBody), {
        milestone: 0
      });

      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          number: 18,
          title: "Retitle the issue",
          state: "open"
        })
      );
      return;
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ message: "not found" }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const port = getServerPort(server);

  try {
    const result = await executeCli([
      "issue",
      "edit",
      "18",
      "-R",
      `127.0.0.1:${port}/octo/project`,
      "--remove-milestone"
    ], {
      env: {
        GTEA_HOST: `127.0.0.1:${port}`,
        GTEA_TOKEN: "edit-token"
      }
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    assert.equal(sawIssueRead, true);
    assert.equal(sawIssuePatch, true);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve();
      })
    );
  }
});

test("issue edit rejects @copilot as an explicit unsupported assignee alias", async () => {
  const result = await executeCli([
    "issue",
    "edit",
    "18",
    "-R",
    "gitea.example.com/octo/project",
    "--add-assignee",
    "@copilot"
  ]);

  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /gtea issue edit flag --add-assignee is currently unsupported/i);
  assert.match(result.stderr, /copilot assignee aliases are not supported on gitea hosts/i);
});

test("issue edit rejects unsupported project edit flags explicitly", async () => {
  const result = await executeCli([
    "issue",
    "edit",
    "18",
    "-R",
    "gitea.example.com/octo/project",
    "--add-project",
    "Roadmap"
  ]);

  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /gtea issue edit flag --add-project is currently unsupported/i);
  assert.match(result.stderr, /project edits are not part of the supported issue maintenance slice/i);
});

test("issue edit reports a validation failure when the milestone title is unknown", async () => {
  let sawIssuePatch = false;

  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== "token edit-token") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "unauthorized" }));
      return;
    }

    if (request.method === "GET" && request.url === "/api/v1/repos/octo/project/issues/18") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          number: 18,
          title: "Retitle the issue",
          state: "open"
        })
      );
      return;
    }

    if (request.method === "GET" && request.url === "/api/v1/repos/octo/project/milestones?state=all") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify([{ id: 3, title: "Backlog" }]));
      return;
    }

    if (request.method === "PATCH" && request.url === "/api/v1/repos/octo/project/issues/18") {
      sawIssuePatch = true;
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ message: "not found" }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const port = getServerPort(server);

  try {
    const result = await executeCli([
      "issue",
      "edit",
      "18",
      "-R",
      `127.0.0.1:${port}/octo/project`,
      "--milestone",
      "Sprint 2"
    ], {
      env: {
        GTEA_HOST: `127.0.0.1:${port}`,
        GTEA_TOKEN: "edit-token"
      }
    });

    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /validation failed while editing issue #18 in octo\/project/i);
    assert.match(result.stderr, /milestone "Sprint 2" was not found/i);
    assert.equal(sawIssuePatch, false);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve();
      })
    );
  }
});

test("issue edit reports not found when the selected issue is missing during metadata planning", async () => {
  let sawIssuePatch = false;

  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== "token edit-token") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "unauthorized" }));
      return;
    }

    if (request.method === "GET" && request.url === "/api/v1/repos/octo/project/issues/18") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "not found" }));
      return;
    }

    if (request.method === "PATCH" && request.url === "/api/v1/repos/octo/project/issues/18") {
      sawIssuePatch = true;
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ message: "not found" }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const port = getServerPort(server);

  try {
    const result = await executeCli([
      "issue",
      "edit",
      "18",
      "-R",
      `127.0.0.1:${port}/octo/project`,
      "--remove-milestone"
    ], {
      env: {
        GTEA_HOST: `127.0.0.1:${port}`,
        GTEA_TOKEN: "edit-token"
      }
    });

    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /issue #18 was not found in octo\/project/i);
    assert.equal(sawIssuePatch, false);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve();
      })
    );
  }
});

test("issue edit aggregates mixed validation, auth, and not-found failures across multiple issue numbers", async () => {
  const seenIssueNumbers: number[] = [];

  const server = createServer(async (request, response) => {
    if (
      request.method === "PATCH"
      && (
        request.url === "/api/v1/repos/octo/project/issues/18"
        || request.url === "/api/v1/repos/octo/project/issues/19"
        || request.url === "/api/v1/repos/octo/project/issues/20"
      )
    ) {
      const issueNumber = Number.parseInt(request.url.split("/").pop() ?? "0", 10);
      seenIssueNumbers.push(issueNumber);

      let requestBody = "";

      for await (const chunk of request) {
        requestBody += chunk;
      }

      assert.deepEqual(JSON.parse(requestBody), {
        title: "Retitle the issue"
      });

      if (issueNumber === 18) {
        response.writeHead(422, { "content-type": "application/json" });
        response.end(JSON.stringify({ message: "title is invalid" }));
        return;
      }

      if (issueNumber === 19) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ message: "unauthorized" }));
        return;
      }

      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "not found" }));
      return;
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ message: "not found" }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const port = getServerPort(server);

  try {
    const result = await executeCli([
      "issue",
      "edit",
      "18",
      "19",
      "20",
      "-R",
      `127.0.0.1:${port}/octo/project`,
      "--title",
      "Retitle the issue"
    ], {
      env: {
        GTEA_HOST: `127.0.0.1:${port}`,
        GTEA_TOKEN: "edit-token"
      }
    });

    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /validation failed while editing issue #18 in octo\/project: title is invalid/i);
    assert.match(result.stderr, /authentication failed while editing issue #19 on 127\.0\.0\.1:/i);
    assert.match(result.stderr, /issue #20 was not found in octo\/project/i);
    assert.deepEqual(seenIssueNumbers, [18, 19, 20]);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve();
      })
    );
  }
});

test("issue close patches the selected issue state to closed quietly", async () => {
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== "token close-token") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "unauthorized" }));
      return;
    }

    if (request.method !== "PATCH" || request.url !== "/api/v1/repos/octo/project/issues/18") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "not found" }));
      return;
    }

    let requestBody = "";

    for await (const chunk of request) {
      requestBody += chunk;
    }

    assert.deepEqual(JSON.parse(requestBody), {
      state: "closed"
    });

    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        number: 18,
        title: "Close the issue",
        state: "closed"
      })
    );
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const port = getServerPort(server);

  try {
    const result = await executeCli([
      "issue",
      "close",
      "18",
      "-R",
      `127.0.0.1:${port}/octo/project`
    ], {
      env: {
        GTEA_HOST: `127.0.0.1:${port}`,
        GTEA_TOKEN: "close-token"
      }
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve();
      })
    );
  }
});

test("issue reopen patches the selected issue state to open quietly", async () => {
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== "token reopen-token") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "unauthorized" }));
      return;
    }

    if (request.method !== "PATCH" || request.url !== "/api/v1/repos/octo/project/issues/18") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "not found" }));
      return;
    }

    let requestBody = "";

    for await (const chunk of request) {
      requestBody += chunk;
    }

    assert.deepEqual(JSON.parse(requestBody), {
      state: "open"
    });

    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        number: 18,
        title: "Reopen the issue",
        state: "open"
      })
    );
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const port = getServerPort(server);

  try {
    const result = await executeCli([
      "issue",
      "reopen",
      "18",
      "-R",
      `127.0.0.1:${port}/octo/project`
    ], {
      env: {
        GTEA_HOST: `127.0.0.1:${port}`,
        GTEA_TOKEN: "reopen-token"
      }
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve();
      })
    );
  }
});

test("issue create reports authentication failures from the selected Gitea host", async () => {
  const server = createServer((request, response) => {
    if (request.method === "POST" && request.url === "/api/v1/repos/octo/project/issues") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "unauthorized" }));
      return;
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ message: "not found" }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const port = getServerPort(server);

  try {
    const result = await executeCli([
      "issue",
      "create",
      "-R",
      `127.0.0.1:${port}/octo/project`,
      "--title",
      "Auth failure"
    ], {
      env: {
        GTEA_HOST: `127.0.0.1:${port}`,
        GTEA_TOKEN: "bad-token"
      }
    });

    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Authentication failed while creating an issue/);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve();
      })
    );
  }
});

test("issue create reports validation failures from the selected Gitea host", async () => {
  const server = createServer((request, response) => {
    if (request.method === "POST" && request.url === "/api/v1/repos/octo/project/issues") {
      response.writeHead(422, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "title is required" }));
      return;
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ message: "not found" }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const port = getServerPort(server);

  try {
    const result = await executeCli([
      "issue",
      "create",
      "-R",
      `127.0.0.1:${port}/octo/project`,
      "--title",
      "Validation failure"
    ], {
      env: {
        GTEA_HOST: `127.0.0.1:${port}`,
        GTEA_TOKEN: "valid-token"
      }
    });

    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Validation failed while creating an issue/);
    assert.match(result.stderr, /title is required/);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve();
      })
    );
  }
});

test("issue create fails clearly for unsupported recover semantics", async () => {
  const result = await executeCli([
    "issue",
    "create",
    "-R",
    "gitea.example.com/octo/project",
    "--recover",
    "draft-1",
    "--title",
    "Unsupported"
  ]);

  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /issue create flag --recover is currently unsupported/i);
});

test("issue create rejects @copilot as an explicit unsupported assignee alias", async () => {
  const result = await executeCli([
    "issue",
    "create",
    "-R",
    "gitea.example.com/octo/project",
    "--title",
    "Unsupported",
    "--assignee",
    "@copilot"
  ]);

  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /gtea issue create flag --assignee is currently unsupported/i);
  assert.match(result.stderr, /copilot assignee aliases are not supported on gitea hosts/i);
});

test("issue create rejects unsupported editor semantics explicitly", async () => {
  const result = await executeCli([
    "issue",
    "create",
    "-R",
    "gitea.example.com/octo/project",
    "--editor"
  ]);

  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /issue create flag --editor is currently unsupported/i);
});

test("browse help shows the supported routing flags", async () => {
  const result = await executeCli(["browse", "--help"]);

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

test("browse --no-browser uses the active host when -R omits it", async () => {
  const configRoot = mkdtempSync(join(tmpdir(), "gtea-browse-"));

  try {
    const env = {
      HOME: configRoot,
      XDG_CONFIG_HOME: configRoot
    };

    assert.equal(
      (await executeCli(["auth", "login", "--hostname", "browse.example.com", "--with-token"], {
        env,
        stdin: "browse-token\n"
      })).exitCode,
      0
    );

    const result = await executeCli(["browse", "--no-browser", "-R", "octo/project"], { env });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "https://browse.example.com/octo/project\n");
    assert.equal(result.stderr, "");
  } finally {
    rmSync(configRoot, { force: true, recursive: true });
  }
});

test("browse preserves an explicit http active host selection", async () => {
  const configRoot = mkdtempSync(join(tmpdir(), "gtea-browse-http-"));

  try {
    const env = {
      HOME: configRoot,
      XDG_CONFIG_HOME: configRoot
    };

    const loginResult = await executeCli(["auth", "login", "--hostname", "http://browse.example.com", "--with-token"], {
      env,
      stdin: "browse-token\n"
    });

    assert.equal(loginResult.exitCode, 0);
    assert.match(loginResult.stdout, /Logged in to http:\/\/browse\.example\.com/i);

    const statusResult = await executeCli(["auth", "status"], { env });

    assert.equal(statusResult.exitCode, 0);
    assert.match(statusResult.stdout, /Active host:\s+http:\/\/browse\.example\.com/i);

    const browseResult = await executeCli(["browse", "--no-browser", "-R", "octo/project"], { env });

    assert.equal(browseResult.exitCode, 0);
    assert.equal(browseResult.stdout, "http://browse.example.com/octo/project\n");
    assert.equal(browseResult.stderr, "");
  } finally {
    rmSync(configRoot, { force: true, recursive: true });
  }
});

test("browse --no-browser infers the repository from the current git remote", async () => {
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

    const result = await executeCli(["browse", "--no-browser"], { cwd: repoRoot });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "https://gitea.example.com/octo/project\n");
    assert.equal(result.stderr, "");
  } finally {
    rmSync(repoRoot, { force: true, recursive: true });
  }
});

test("browse preserves an explicit http git remote when inferring the repository", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "gtea-browse-http-remote-"));

  try {
    const initResult = spawnSync("git", ["init", "--initial-branch=trunk"], {
      cwd: repoRoot,
      encoding: "utf8"
    });

    assert.equal(initResult.status, 0, initResult.stderr);

    const remoteResult = spawnSync("git", ["remote", "add", "origin", "http://gitea.example.com/octo/project.git"], {
      cwd: repoRoot,
      encoding: "utf8"
    });

    assert.equal(remoteResult.status, 0, remoteResult.stderr);

    const result = await executeCli(["browse", "--no-browser"], { cwd: repoRoot });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "http://gitea.example.com/octo/project\n");
    assert.equal(result.stderr, "");
  } finally {
    rmSync(repoRoot, { force: true, recursive: true });
  }
});

test("browse defaults an ssh url git remote to https when inferring the repository", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "gtea-browse-ssh-remote-"));

  try {
    const initResult = spawnSync("git", ["init", "--initial-branch=trunk"], {
      cwd: repoRoot,
      encoding: "utf8"
    });

    assert.equal(initResult.status, 0, initResult.stderr);

    const remoteResult = spawnSync("git", ["remote", "add", "origin", "ssh://git@gitea.example.com/octo/project.git"], {
      cwd: repoRoot,
      encoding: "utf8"
    });

    assert.equal(remoteResult.status, 0, remoteResult.stderr);

    const result = await executeCli(["browse", "--no-browser"], { cwd: repoRoot });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "https://gitea.example.com/octo/project\n");
    assert.equal(result.stderr, "");
  } finally {
    rmSync(repoRoot, { force: true, recursive: true });
  }
});

test("pr checkout uses the Git Toolchain to fetch and switch to the pull request head", async () => {
  const server = createServer((request, response) => {
    if (request.url !== "/api/v1/repos/octo/project/pulls/42") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "not found" }));
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        number: 42,
        title: "Ship the pull request checkout slice",
        state: "open",
        base: {
          ref: "main"
        },
        head: {
          ref: "feature/pr-read"
        }
      })
    );
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const port = getServerPort(server);
  const remoteRoot = mkdtempSync(join(tmpdir(), "gtea-pr-remote-"));
  const sourceRoot = mkdtempSync(join(tmpdir(), "gtea-pr-source-"));
  const checkoutRoot = mkdtempSync(join(tmpdir(), "gtea-pr-checkout-"));

  try {
    assert.equal(spawnSync("git", ["init", "--bare", remoteRoot], {
      encoding: "utf8"
    }).status, 0);
    assert.equal(spawnSync("git", ["init", "--initial-branch=main"], {
      cwd: sourceRoot,
      encoding: "utf8"
    }).status, 0);
    assert.equal(spawnSync("git", ["config", "user.email", "checkout@example.com"], {
      cwd: sourceRoot,
      encoding: "utf8"
    }).status, 0);
    assert.equal(spawnSync("git", ["config", "user.name", "Checkout Test"], {
      cwd: sourceRoot,
      encoding: "utf8"
    }).status, 0);

    writeFileSync(join(sourceRoot, "feature.txt"), "base\n", "utf8");

    assert.equal(spawnSync("git", ["add", "feature.txt"], {
      cwd: sourceRoot,
      encoding: "utf8"
    }).status, 0);
    assert.equal(spawnSync("git", ["commit", "-m", "base commit"], {
      cwd: sourceRoot,
      encoding: "utf8"
    }).status, 0);
    assert.equal(spawnSync("git", ["remote", "add", "origin", remoteRoot], {
      cwd: sourceRoot,
      encoding: "utf8"
    }).status, 0);
    assert.equal(spawnSync("git", ["push", "-u", "origin", "main"], {
      cwd: sourceRoot,
      encoding: "utf8"
    }).status, 0);
    assert.equal(spawnSync("git", ["checkout", "-b", "feature/pr-read"], {
      cwd: sourceRoot,
      encoding: "utf8"
    }).status, 0);

    writeFileSync(join(sourceRoot, "feature.txt"), "base\npr branch\n", "utf8");

    assert.equal(spawnSync("git", ["add", "feature.txt"], {
      cwd: sourceRoot,
      encoding: "utf8"
    }).status, 0);
    assert.equal(spawnSync("git", ["commit", "-m", "pull request head"], {
      cwd: sourceRoot,
      encoding: "utf8"
    }).status, 0);

    const featureCommitResult = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: sourceRoot,
      encoding: "utf8"
    });

    assert.equal(featureCommitResult.status, 0, featureCommitResult.stderr);

    const featureCommit = featureCommitResult.stdout.trim();

    assert.equal(spawnSync("git", ["push", "origin", "feature/pr-read"], {
      cwd: sourceRoot,
      encoding: "utf8"
    }).status, 0);
    assert.equal(spawnSync("git", ["--git-dir", remoteRoot, "update-ref", "refs/pull/42/head", featureCommit], {
      encoding: "utf8"
    }).status, 0);
    assert.equal(spawnSync("git", ["clone", remoteRoot, checkoutRoot], {
      encoding: "utf8"
    }).status, 0);

    const result = await executeCli(["pr", "checkout", "42", "-R", `127.0.0.1:${port}/octo/project`], {
      cwd: checkoutRoot
    });

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /Checked out pull request #42 to feature\/pr-read/i);
    assert.equal(result.stderr, "");

    const currentBranchResult = spawnSync("git", ["branch", "--show-current"], {
      cwd: checkoutRoot,
      encoding: "utf8"
    });

    assert.equal(currentBranchResult.status, 0, currentBranchResult.stderr);
    assert.equal(currentBranchResult.stdout.trim(), "feature/pr-read");
    assert.equal(readFileSync(join(checkoutRoot, "feature.txt"), "utf8").replace(/\r\n/g, "\n"), "base\npr branch\n");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve();
      })
    );

    rmSync(remoteRoot, { force: true, recursive: true });
    rmSync(sourceRoot, { force: true, recursive: true });
    rmSync(checkoutRoot, { force: true, recursive: true });
  }
});

test("browse synthesizes deterministic routes for issues, pull requests, commits, files, and browse sections", async () => {
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
      const result = await executeCli(browseCase.args, { cwd: repoRoot });

      assert.equal(result.exitCode, 0, `expected success for ${browseCase.args.join(" ")}`);
      assert.equal(result.stdout, `${browseCase.expectedUrl}\n`);
      assert.equal(result.stderr, "");
    }
  } finally {
    rmSync(repoRoot, { force: true, recursive: true });
  }
});

test("browse honors a host-qualified -R target over the stored active host", async () => {
  const configRoot = mkdtempSync(join(tmpdir(), "gtea-browse-host-"));

  try {
    const env = {
      HOME: configRoot,
      XDG_CONFIG_HOME: configRoot
    };

    assert.equal(
      (await executeCli(["auth", "login", "--hostname", "stored.example.com", "--with-token"], {
        env,
        stdin: "stored-token\n"
      })).exitCode,
      0
    );

    const result = await executeCli(["browse", "--no-browser", "-R", "alt.example.com/octo/project"], { env });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "https://alt.example.com/octo/project\n");
    assert.equal(result.stderr, "");
  } finally {
    rmSync(configRoot, { force: true, recursive: true });
  }
});

test("browse preserves an explicit http host-qualified -R target", async () => {
  const result = await executeCli(["browse", "--no-browser", "-R", "http://alt.example.com/octo/project"]);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "http://alt.example.com/octo/project\n");
  assert.equal(result.stderr, "");
});

test("browse rejects github.com as a non-eligible host", async () => {
  const result = await executeCli(["browse", "--no-browser", "-R", "github.com/octo/project"]);

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /github\.com is not an Eligible Host/i);
});

test("auth login persists a PAT and status reports the active host", async () => {
  const configRoot = mkdtempSync(join(tmpdir(), "gtea-auth-"));

  try {
    const env = {
      HOME: configRoot,
      XDG_CONFIG_HOME: configRoot
    };

    const loginResult = await executeCli(["auth", "login", "--hostname", "gitea.example.com", "--with-token"], {
      env,
      stdin: "pat-example\n"
    });

    assert.equal(loginResult.exitCode, 0);
    assert.match(loginResult.stdout, /Logged in to gitea\.example\.com/i);

    const statusResult = await executeCli(["auth", "status"], { env });

    assert.equal(statusResult.exitCode, 0);
    assert.match(statusResult.stdout, /Active host:\s+gitea\.example\.com/i);
    assert.match(statusResult.stdout, /Credential source:\s+native config store/i);
  } finally {
    rmSync(configRoot, { force: true, recursive: true });
  }
});

test("auth login reads a PAT from real stdin in the shell entrypoint", async () => {
  const configRoot = mkdtempSync(join(tmpdir(), "gtea-auth-"));

  try {
    const env = {
      HOME: configRoot,
      XDG_CONFIG_HOME: configRoot,
      APPDATA: configRoot
    };

    const result = spawnSync("bun", ["run", "cli", "auth", "login", "--hostname", "stdin.example.com", "--with-token"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      encoding: "utf8",
      env: {
        ...process.env,
        ...env
      },
      input: "stdin-token\n"
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Logged in to stdin\.example\.com/i);

    const statusResult = await executeCli(["auth", "status"], { env });

    assert.equal(statusResult.exitCode, 0);
    assert.match(statusResult.stdout, /Active host:\s+stdin\.example\.com/i);
  } finally {
    rmSync(configRoot, { force: true, recursive: true });
  }
});

test("auth token prefers GTEA compatibility variables over GH and stored config", async () => {
  const configRoot = mkdtempSync(join(tmpdir(), "gtea-auth-"));

  try {
    const persistedEnv = {
      HOME: configRoot,
      XDG_CONFIG_HOME: configRoot
    };

    const loginResult = await executeCli(["auth", "login", "--hostname", "stored.example.com", "--with-token"], {
      env: persistedEnv,
      stdin: "stored-token\n"
    });

    assert.equal(loginResult.exitCode, 0);

    const tokenResult = await executeCli(["auth", "token"], {
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

test("auth status preserves explicit schemes from compatibility variables and prefers GTEA_HOST", async () => {
  const result = await executeCli(["auth", "status", "--show-token"], {
    env: {
      GH_HOST: "https://legacy.example.com",
      GH_TOKEN: "legacy-token",
      GTEA_HOST: "http://native.example.com",
      GTEA_TOKEN: "native-token"
    }
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /Active host:\s+http:\/\/native\.example\.com/i);
  assert.match(result.stdout, /Credential source:\s+GTEA_TOKEN environment variable/i);
  assert.match(result.stdout, /Token:\s+native-token/i);
  assert.equal(result.stderr, "");
});

test("auth switch and logout manage the active host across multiple stored hosts", async () => {
  const configRoot = mkdtempSync(join(tmpdir(), "gtea-auth-"));

  try {
    const env = {
      HOME: configRoot,
      XDG_CONFIG_HOME: configRoot
    };

    assert.equal(
      (await executeCli(["auth", "login", "--hostname", "first.example.com", "--with-token"], {
        env,
        stdin: "first-token\n"
      })).exitCode,
      0
    );

    assert.equal(
      (await executeCli(["auth", "login", "--hostname", "second.example.com", "--with-token"], {
        env,
        stdin: "second-token\n"
      })).exitCode,
      0
    );

    const switchResult = await executeCli(["auth", "switch", "--hostname", "first.example.com"], { env });

    assert.equal(switchResult.exitCode, 0);
    assert.match(switchResult.stdout, /Switched active host to first\.example\.com/i);

    const switchedStatus = await executeCli(["auth", "status"], { env });

    assert.equal(switchedStatus.exitCode, 0);
    assert.match(switchedStatus.stdout, /Active host:\s+first\.example\.com/i);

    const logoutResult = await executeCli(["auth", "logout", "--hostname", "first.example.com"], { env });

    assert.equal(logoutResult.exitCode, 0);
    assert.match(logoutResult.stdout, /Removed the stored credential for first\.example\.com/i);

    const fallbackStatus = await executeCli(["auth", "status"], { env });

    assert.equal(fallbackStatus.exitCode, 0);
    assert.match(fallbackStatus.stdout, /Active host:\s+second\.example\.com/i);
  } finally {
    rmSync(configRoot, { force: true, recursive: true });
  }
});

test("auth stores explicit http and https hosts as distinct credentials", async () => {
  const configRoot = mkdtempSync(join(tmpdir(), "gtea-auth-distinct-"));

  try {
    const env = {
      HOME: configRoot,
      XDG_CONFIG_HOME: configRoot
    };

    assert.equal(
      (await executeCli(["auth", "login", "--hostname", "http://dual.example.com", "--with-token"], {
        env,
        stdin: "http-token\n"
      })).exitCode,
      0
    );

    assert.equal(
      (await executeCli(["auth", "login", "--hostname", "https://dual.example.com", "--with-token"], {
        env,
        stdin: "https-token\n"
      })).exitCode,
      0
    );

    const httpTokenResult = await executeCli(["auth", "token", "--hostname", "http://dual.example.com"], { env });
    const httpsTokenResult = await executeCli(["auth", "token", "--hostname", "https://dual.example.com"], { env });

    assert.equal(httpTokenResult.exitCode, 0);
    assert.equal(httpTokenResult.stdout, "http-token\n");
    assert.equal(httpsTokenResult.exitCode, 0);
    assert.equal(httpsTokenResult.stdout, "https-token\n");

    const switchResult = await executeCli(["auth", "switch", "--hostname", "http://dual.example.com"], { env });

    assert.equal(switchResult.exitCode, 0);

    const statusResult = await executeCli(["auth", "status"], { env });

    assert.equal(statusResult.exitCode, 0);
    assert.match(statusResult.stdout, /Active host:\s+http:\/\/dual\.example\.com/i);
  } finally {
    rmSync(configRoot, { force: true, recursive: true });
  }
});

test("auth refresh replaces the stored PAT for an existing host", async () => {
  const configRoot = mkdtempSync(join(tmpdir(), "gtea-auth-"));

  try {
    const env = {
      HOME: configRoot,
      XDG_CONFIG_HOME: configRoot
    };

    assert.equal(
      (await executeCli(["auth", "login", "--hostname", "refresh.example.com", "--with-token"], {
        env,
        stdin: "old-token\n"
      })).exitCode,
      0
    );

    const refreshResult = await executeCli(["auth", "refresh", "--hostname", "refresh.example.com", "--with-token"], {
      env,
      stdin: "new-token\n"
    });

    assert.equal(refreshResult.exitCode, 0);
    assert.match(refreshResult.stdout, /Refreshed the stored credential for refresh\.example\.com/i);

    const tokenResult = await executeCli(["auth", "token", "--hostname", "refresh.example.com"], { env });

    assert.equal(tokenResult.exitCode, 0);
    assert.equal(tokenResult.stdout, "new-token\n");
  } finally {
    rmSync(configRoot, { force: true, recursive: true });
  }
});

test("auth setup-git configures git to use the gtea credential helper for the selected host", async () => {
  const configRoot = mkdtempSync(join(tmpdir(), "gtea-auth-"));

  try {
    const gitConfigPath = join(configRoot, ".gitconfig");
    const env = {
      HOME: configRoot,
      XDG_CONFIG_HOME: configRoot,
      GIT_CONFIG_GLOBAL: gitConfigPath
    };

    assert.equal(
      (await executeCli(["auth", "login", "--hostname", "git.example.com", "--with-token"], {
        env,
        stdin: "git-token\n"
      })).exitCode,
      0
    );

    const setupResult = await executeCli(["auth", "setup-git", "--hostname", "git.example.com"], { env });

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

test("auth setup-git preserves an explicit http host in git credential helper config", async () => {
  const configRoot = mkdtempSync(join(tmpdir(), "gtea-auth-http-"));

  try {
    const gitConfigPath = join(configRoot, ".gitconfig");
    const env = {
      HOME: configRoot,
      XDG_CONFIG_HOME: configRoot,
      GIT_CONFIG_GLOBAL: gitConfigPath
    };

    assert.equal(
      (await executeCli(["auth", "login", "--hostname", "http://git.example.com", "--with-token"], {
        env,
        stdin: "git-token\n"
      })).exitCode,
      0
    );

    const setupResult = await executeCli(["auth", "setup-git", "--hostname", "http://git.example.com"], { env });

    assert.equal(setupResult.exitCode, 0);
    assert.match(setupResult.stdout, /Configured Git credential helper for http:\/\/git\.example\.com/i);

    const helperConfig = spawnSync(
      "git",
      ["config", "--global", "--get", "credential.http://git.example.com.helper"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          ...env
        }
      }
    );

    assert.equal(helperConfig.status, 0);
    assert.match(helperConfig.stdout, /!gtea auth git-credential --hostname http:\/\/git\.example\.com/);
  } finally {
    rmSync(configRoot, { force: true, recursive: true });
  }
});

test("auth login rejects github.com as a non-eligible host", async () => {
  const configRoot = mkdtempSync(join(tmpdir(), "gtea-auth-"));

  try {
    const env = {
      HOME: configRoot,
      XDG_CONFIG_HOME: configRoot
    };

    const result = await executeCli(["auth", "login", "--hostname", "github.com", "--with-token"], {
      env,
      stdin: "pat-example\n"
    });

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /github\.com is not an Eligible Host/i);
  } finally {
    rmSync(configRoot, { force: true, recursive: true });
  }
});

test("auth status rejects an invalid explicit hostname instead of falling back to the active host", async () => {
  const configRoot = mkdtempSync(join(tmpdir(), "gtea-auth-"));

  try {
    const env = {
      HOME: configRoot,
      XDG_CONFIG_HOME: configRoot
    };

    assert.equal(
      (await executeCli(["auth", "login", "--hostname", "valid.example.com", "--with-token"], {
        env,
        stdin: "valid-token\n"
      })).exitCode,
      0
    );

    const result = await executeCli(["auth", "status", "--hostname", "not/a/host"], { env });

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /Invalid value for --hostname: not\/a\/host/i);
  } finally {
    rmSync(configRoot, { force: true, recursive: true });
  }
});

test("auth status rejects an invalid GTEA_HOST instead of falling back to stored config", async () => {
  const configRoot = mkdtempSync(join(tmpdir(), "gtea-auth-"));

  try {
    const persistedEnv = {
      HOME: configRoot,
      XDG_CONFIG_HOME: configRoot
    };

    assert.equal(
      (await executeCli(["auth", "login", "--hostname", "valid.example.com", "--with-token"], {
        env: persistedEnv,
        stdin: "valid-token\n"
      })).exitCode,
      0
    );

    const result = await executeCli(["auth", "status"], {
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

test("auth git-credential returns oauth2 credentials for the configured host", async () => {
  const configRoot = mkdtempSync(join(tmpdir(), "gtea-auth-"));

  try {
    const env = {
      HOME: configRoot,
      XDG_CONFIG_HOME: configRoot
    };

    assert.equal(
      (await executeCli(["auth", "login", "--hostname", "helper.example.com", "--with-token"], {
        env,
        stdin: "helper-token\n"
      })).exitCode,
      0
    );

    const result = await executeCli(["auth", "git-credential", "--hostname", "helper.example.com", "get"], {
      env,
      stdin: "protocol=https\nhost=helper.example.com\n\n"
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "username=oauth2\npassword=helper-token\n");
  } finally {
    rmSync(configRoot, { force: true, recursive: true });
  }
});

test("support manifest validation and CLI surface stay synchronized", async () => {
  const manifestJson = JSON.parse(
    readFileSync(new URL("../support-manifest.json", import.meta.url), "utf8")
  ) as Parameters<typeof validateSupportManifest>[0];
  const validationErrors = validateSupportManifest(manifestJson);

  assert.deepEqual(validationErrors, []);

  for (const entry of collectManifestPaths()) {
    const helpResult = await executeCli([...entry.path, "--help"]);

    assert.equal(helpResult.exitCode, 0, `help failed for ${entry.path.join(" ")}`);
    assert.match(helpResult.stdout, new RegExp(entry.node.name));

    if (entry.node.kind === "command") {
      const executeResult = await executeCli(entry.path);

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