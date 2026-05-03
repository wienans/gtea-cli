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
      "number,title,state,url"
    ]);

    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(result.stdout), {
      number: 42,
      title: "Ship the issue read slice",
      state: "open",
      url: `http://127.0.0.1:${port}/octo/project/issues/42`
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
      "number,title,state,url",
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
      "number,title,state,url",
      "--template",
      "{{.title}} (#{{.number}})"
    ]);

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "Ship the issue read slice (#42)\n");
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

test("issue close patches the selected issue state to closed", async () => {
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

test("issue reopen patches the selected issue state to open", async () => {
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
    assert.equal(readFileSync(join(checkoutRoot, "feature.txt"), "utf8"), "base\npr branch\n");
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

    const statusResult = await executeCli(["auth", "status"], {
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