import { spawnSync } from "node:child_process";

import { CliResult, ResolvedCliExecutionContext } from "./cli-runtime.js";
import { buildHostBaseUrl, buildProcessEnv } from "./host-config.js";
import { type RepositoryContext, resolveOptionalToken, resolveRepositoryContext } from "./repository-context.js";
import {
  renderStructuredJq,
  renderStructuredJson,
  renderStructuredTemplate,
  type StructuredObject
} from "./structured-output.js";
import { ManifestCommand, ManifestGroup, supportManifest } from "./support-manifest.js";

interface ParsedPullRequestFlags {
  pullRequestNumber?: number;
  repository?: string;
  jsonFields?: string[];
  jqExpression?: string;
  template?: string;
}

interface PullRequestRecord {
  number: number;
  title: string;
  state: string;
  headRefName: string;
  baseRefName: string;
  url: string;
}

interface GiteaPullRequestPayload {
  number?: number;
  title?: string;
  state?: string;
  assignee?: { login?: string };
  assignees?: Array<{ login?: string }>;
  user?: { login?: string };
  head?: {
    ref?: string;
  };
  base?: {
    ref?: string;
  };
}

const prGroup = supportManifest.children.find(
  (node): node is ManifestGroup => node.kind === "group" && node.name === "pr"
);
const prViewCommand = prGroup?.children.find(
  (node): node is ManifestCommand => node.kind === "command" && node.name === "view"
);
const prOutputFields = new Set((prViewCommand?.outputFields ?? []).map((field) => field.name));

function parseStringFlagValue(
  args: string[],
  index: number,
  options: { long: string; short?: string }
): { handled: boolean; nextIndex: number; value?: string; error?: CliResult } {
  const token = args[index];
  const longPrefix = `${options.long}=`;
  const matchesNamedFlag = token === options.long || (options.short !== undefined && token === options.short);

  if (!matchesNamedFlag && (token === undefined || !token.startsWith(longPrefix))) {
    return {
      handled: false,
      nextIndex: index
    };
  }

  if (token !== undefined && token.startsWith(longPrefix)) {
    return {
      handled: true,
      nextIndex: index,
      value: token.slice(longPrefix.length)
    };
  }

  const rawValue = args[index + 1];

  if (rawValue === undefined || rawValue.startsWith("-")) {
    return {
      handled: true,
      nextIndex: index,
      error: {
        exitCode: 1,
        stdout: "",
        stderr: `Missing value for ${options.long}.\n`
      }
    };
  }

  return {
    handled: true,
    nextIndex: index + 1,
    value: rawValue
  };
}

function parsePullRequestFlags(args: string[]): { flags: ParsedPullRequestFlags; error?: CliResult } {
  const flags: ParsedPullRequestFlags = {};

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];

    if (token === undefined) {
      break;
    }

    const repositoryFlag = parseStringFlagValue(args, index, { long: "--repo", short: "-R" });

    if (repositoryFlag.error !== undefined) {
      return {
        flags,
        error: repositoryFlag.error
      };
    }

    if (repositoryFlag.handled && repositoryFlag.value !== undefined) {
      flags.repository = repositoryFlag.value;
      index = repositoryFlag.nextIndex;
      continue;
    }

    const jsonFlag = parseStringFlagValue(args, index, { long: "--json" });

    if (jsonFlag.error !== undefined) {
      return {
        flags,
        error: jsonFlag.error
      };
    }

    if (jsonFlag.handled) {
      flags.jsonFields = (jsonFlag.value ?? "")
        .split(",")
        .map((field) => field.trim())
        .filter((field) => field.length > 0);
      index = jsonFlag.nextIndex;
      continue;
    }

    const jqFlag = parseStringFlagValue(args, index, { long: "--jq" });

    if (jqFlag.error !== undefined) {
      return {
        flags,
        error: jqFlag.error
      };
    }

    if (jqFlag.handled && jqFlag.value !== undefined) {
      flags.jqExpression = jqFlag.value;
      index = jqFlag.nextIndex;
      continue;
    }

    const templateFlag = parseStringFlagValue(args, index, { long: "--template" });

    if (templateFlag.error !== undefined) {
      return {
        flags,
        error: templateFlag.error
      };
    }

    if (templateFlag.handled && templateFlag.value !== undefined) {
      flags.template = templateFlag.value;
      index = templateFlag.nextIndex;
      continue;
    }

    if (token.startsWith("-")) {
      return {
        flags,
        error: {
          exitCode: 1,
          stdout: "",
          stderr: `Unknown flag or argument: ${token}\n`
        }
      };
    }

    if (flags.pullRequestNumber !== undefined) {
      return {
        flags,
        error: {
          exitCode: 1,
          stdout: "",
          stderr: `Unexpected argument: ${token}\n`
        }
      };
    }

    if (!/^\d+$/.test(token)) {
      return {
        flags,
        error: {
          exitCode: 1,
          stdout: "",
          stderr: `Invalid pull request number: ${token}\n`
        }
      };
    }

    flags.pullRequestNumber = Number.parseInt(token, 10);
  }

  return { flags };
}

function buildPullRequestUrl(repository: RepositoryContext, pullRequestNumber: number): string {
  return `${buildHostBaseUrl(repository.hostname)}/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repository)}/pulls/${pullRequestNumber}`;
}

function mapPullRequestRecord(
  repository: RepositoryContext,
  payload: GiteaPullRequestPayload,
  fallbackNumber: number
): PullRequestRecord {
  const number = typeof payload.number === "number" ? payload.number : fallbackNumber;

  return {
    number,
    title: typeof payload.title === "string" ? payload.title : `Pull request #${number}`,
    state: typeof payload.state === "string" ? payload.state : "unknown",
    headRefName: typeof payload.head?.ref === "string" ? payload.head.ref : "unknown",
    baseRefName: typeof payload.base?.ref === "string" ? payload.base.ref : "unknown",
    url: buildPullRequestUrl(repository, number)
  };
}

async function readPullRequest(
  repository: RepositoryContext,
  pullRequestNumber: number,
  context: ResolvedCliExecutionContext
): Promise<{ pullRequest?: PullRequestRecord; error?: CliResult }> {
  const requestUrl = `${buildHostBaseUrl(repository.hostname)}/api/v1/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repository)}/pulls/${pullRequestNumber}`;
  const token = resolveOptionalToken(repository.hostname, context);

  try {
    const response = await fetch(
      requestUrl,
      token === undefined ? undefined : { headers: { Authorization: `token ${token}` } }
    );

    if (response.status === 404) {
      return {
        error: {
          exitCode: 1,
          stdout: "",
          stderr: `Pull request #${pullRequestNumber} was not found in ${repository.owner}/${repository.repository}.\n`
        }
      };
    }

    if (!response.ok) {
      return {
        error: {
          exitCode: 1,
          stdout: "",
          stderr: `Gitea returned ${response.status} while reading pull request #${pullRequestNumber}.\n`
        }
      };
    }

    return {
      pullRequest: mapPullRequestRecord(repository, await response.json() as GiteaPullRequestPayload, pullRequestNumber)
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return {
      error: {
        exitCode: 1,
        stdout: "",
        stderr: `Failed to read pull request #${pullRequestNumber} from ${repository.hostname}: ${message}\n`
      }
    };
  }
}

async function readPullRequestDiff(
  repository: RepositoryContext,
  pullRequestNumber: number,
  context: ResolvedCliExecutionContext
): Promise<{ diff?: string; error?: CliResult }> {
  const requestUrl = `${buildHostBaseUrl(repository.hostname)}/api/v1/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repository)}/pulls/${pullRequestNumber}.diff`;
  const token = resolveOptionalToken(repository.hostname, context);

  try {
    const response = await fetch(
      requestUrl,
      token === undefined ? undefined : { headers: { Authorization: `token ${token}` } }
    );

    if (response.status === 404) {
      return {
        error: {
          exitCode: 1,
          stdout: "",
          stderr: `Pull request #${pullRequestNumber} was not found in ${repository.owner}/${repository.repository}.\n`
        }
      };
    }

    if (!response.ok) {
      return {
        error: {
          exitCode: 1,
          stdout: "",
          stderr: `Gitea returned ${response.status} while reading pull request diff #${pullRequestNumber}.\n`
        }
      };
    }

    return {
      diff: await response.text()
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return {
      error: {
        exitCode: 1,
        stdout: "",
        stderr: `Failed to read pull request diff #${pullRequestNumber} from ${repository.hostname}: ${message}\n`
      }
    };
  }
}

function checkoutPullRequest(
  pullRequest: PullRequestRecord,
  context: ResolvedCliExecutionContext
): { stdout?: string; error?: CliResult } {
  if (pullRequest.headRefName.length === 0 || pullRequest.headRefName === "unknown") {
    return {
      error: {
        exitCode: 1,
        stdout: "",
        stderr: `Pull request #${pullRequest.number} did not include a usable head branch.\n`
      }
    };
  }

  const gitRepoResult = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: context.cwd,
    encoding: "utf8",
    env: buildProcessEnv(context)
  });

  if (gitRepoResult.status !== 0 || gitRepoResult.stdout.trim() !== "true") {
    return {
      error: {
        exitCode: 1,
        stdout: "",
        stderr: "gtea pr checkout requires a local Git repository. Run it from a clone of the target repository.\n"
      }
    };
  }

  const fetchResult = spawnSync(
    "git",
    ["fetch", "--force", "origin", `refs/pull/${pullRequest.number}/head:refs/heads/${pullRequest.headRefName}`],
    {
      cwd: context.cwd,
      encoding: "utf8",
      env: buildProcessEnv(context)
    }
  );

  if (fetchResult.status !== 0) {
    const message = fetchResult.stderr.trim().length > 0 ? fetchResult.stderr.trim() : fetchResult.stdout.trim();

    return {
      error: {
        exitCode: 1,
        stdout: "",
        stderr: `Git failed to fetch pull request #${pullRequest.number}: ${message}\n`
      }
    };
  }

  const checkoutResult = spawnSync("git", ["checkout", "--quiet", pullRequest.headRefName], {
    cwd: context.cwd,
    encoding: "utf8",
    env: buildProcessEnv(context)
  });

  if (checkoutResult.status !== 0) {
    const message = checkoutResult.stderr.trim().length > 0 ? checkoutResult.stderr.trim() : checkoutResult.stdout.trim();

    return {
      error: {
        exitCode: 1,
        stdout: "",
        stderr: `Git failed to check out pull request #${pullRequest.number}: ${message}\n`
      }
    };
  }

  return {
    stdout: `Checked out pull request #${pullRequest.number} to ${pullRequest.headRefName}.\n`
  };
}

async function readPullRequestList(
  repository: RepositoryContext,
  context: ResolvedCliExecutionContext
): Promise<{ pullRequests?: PullRequestRecord[]; payload?: GiteaPullRequestPayload[]; error?: CliResult }> {
  const requestUrl = `${buildHostBaseUrl(repository.hostname)}/api/v1/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repository)}/pulls?state=open`;
  const token = resolveOptionalToken(repository.hostname, context);

  try {
    const response = await fetch(
      requestUrl,
      token === undefined ? undefined : { headers: { Authorization: `token ${token}` } }
    );

    if (!response.ok) {
      return {
        error: {
          exitCode: 1,
          stdout: "",
          stderr: `Gitea returned ${response.status} while reading pull requests for ${repository.owner}/${repository.repository}.\n`
        }
      };
    }

    const payload = await response.json() as GiteaPullRequestPayload[];

    return {
      pullRequests: payload.map((entry, index) => mapPullRequestRecord(repository, entry, index + 1)),
      payload
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return {
      error: {
        exitCode: 1,
        stdout: "",
        stderr: `Failed to read pull requests from ${repository.hostname}: ${message}\n`
      }
    };
  }
}

async function readCurrentUser(hostname: string, context: ResolvedCliExecutionContext): Promise<{ login?: string; error?: CliResult }> {
  const token = resolveOptionalToken(hostname, context);

  if (token === undefined) {
    return {
      error: {
        exitCode: 1,
        stdout: "",
        stderr: "gtea pr status requires an authenticated host credential. Run gtea auth login or set GTEA_TOKEN/GH_TOKEN.\n"
      }
    };
  }

  try {
    const response = await fetch(`${buildHostBaseUrl(hostname)}/api/v1/user`, {
      headers: {
        Authorization: `token ${token}`
      }
    });

    if (response.status === 401 || response.status === 403) {
      return {
        error: {
          exitCode: 1,
          stdout: "",
          stderr: `Authentication failed while reading the current user for ${hostname}.\n`
        }
      };
    }

    if (!response.ok) {
      return {
        error: {
          exitCode: 1,
          stdout: "",
          stderr: `Gitea returned ${response.status} while reading the current user for ${hostname}.\n`
        }
      };
    }

    const payload = await response.json() as { login?: string };

    if (typeof payload.login !== "string" || payload.login.length === 0) {
      return {
        error: {
          exitCode: 1,
          stdout: "",
          stderr: `Gitea did not return a usable login for ${hostname}.\n`
        }
      };
    }

    return { login: payload.login };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return {
      error: {
        exitCode: 1,
        stdout: "",
        stderr: `Failed to read the current user from ${hostname}: ${message}\n`
      }
    };
  }
}

function renderPullRequest(pullRequest: PullRequestRecord): string {
  return [
    `${pullRequest.title} (#${pullRequest.number})`,
    `State: ${pullRequest.state}`,
    `Head: ${pullRequest.headRefName}`,
    `Base: ${pullRequest.baseRefName}`,
    `URL: ${pullRequest.url}`
  ].join("\n") + "\n";
}

function renderPullRequestList(pullRequests: PullRequestRecord[]): string {
  if (pullRequests.length === 0) {
    return "No open pull requests found.\n";
  }

  return `${pullRequests.map((pullRequest) =>
    `#${pullRequest.number}  [${pullRequest.state}] ${pullRequest.title} (${pullRequest.headRefName} -> ${pullRequest.baseRefName})`
  ).join("\n")}\n`;
}

function isPullRequestAssignedToUser(pullRequest: GiteaPullRequestPayload, login: string): boolean {
  if (pullRequest.assignee?.login === login) {
    return true;
  }

  return pullRequest.assignees?.some((assignee) => assignee.login === login) ?? false;
}

function isPullRequestOpenedByUser(pullRequest: GiteaPullRequestPayload, login: string): boolean {
  return pullRequest.user?.login === login;
}

function collectMatchingPullRequests(
  payload: GiteaPullRequestPayload[],
  pullRequests: PullRequestRecord[],
  predicate: (pullRequest: GiteaPullRequestPayload) => boolean
): PullRequestRecord[] {
  return payload.reduce<PullRequestRecord[]>((matchingPullRequests, pullRequest, index) => {
    const record = pullRequests[index];

    if (record !== undefined && predicate(pullRequest)) {
      matchingPullRequests.push(record);
    }

    return matchingPullRequests;
  }, []);
}

function renderPullRequestStatus(
  repository: RepositoryContext,
  login: string,
  assignedPullRequests: PullRequestRecord[],
  openedPullRequests: PullRequestRecord[]
): string {
  const lines = [`Relevant open pull requests for ${login} in ${repository.owner}/${repository.repository}`];

  lines.push("", "Assigned to you");
  lines.push(
    ...(assignedPullRequests.length === 0
      ? ["  None"]
      : assignedPullRequests.map(
          (pullRequest) => `  #${pullRequest.number}  [${pullRequest.state}] ${pullRequest.title}`
        ))
  );

  lines.push("", "Opened by you");
  lines.push(
    ...(openedPullRequests.length === 0
      ? ["  None"]
      : openedPullRequests.map(
          (pullRequest) => `  #${pullRequest.number}  [${pullRequest.state}] ${pullRequest.title}`
        ))
  );

  return `${lines.join("\n")}\n`;
}

function renderStructuredPullRequestOutput(
  value: PullRequestRecord | PullRequestRecord[],
  jsonFields: string[],
  jqExpression?: string,
  template?: string
): { stdout?: string; error?: CliResult } {
  const renderedOutput = renderStructuredJson(value, jsonFields, prOutputFields);

  if (renderedOutput.error !== undefined || renderedOutput.output === undefined) {
    return {
      error: {
        exitCode: 1,
        stdout: "",
        stderr: `${renderedOutput.error ?? "Failed to render structured pull request output."}\n`
      }
    };
  }

  if (jqExpression !== undefined) {
    const filteredOutput = renderStructuredJq(
      JSON.parse(renderedOutput.output) as StructuredObject | StructuredObject[],
      jqExpression
    );

    if (filteredOutput.error !== undefined || filteredOutput.output === undefined) {
      return {
        error: {
          exitCode: 1,
          stdout: "",
          stderr: `${filteredOutput.error ?? "Failed to filter structured pull request output."}\n`
        }
      };
    }

    return {
      stdout: filteredOutput.output
    };
  }

  if (template !== undefined) {
    const templatedOutput = renderStructuredTemplate(
      JSON.parse(renderedOutput.output) as StructuredObject | StructuredObject[],
      template
    );

    if (templatedOutput.error !== undefined || templatedOutput.output === undefined) {
      return {
        error: {
          exitCode: 1,
          stdout: "",
          stderr: `${templatedOutput.error ?? "Failed to render structured pull request template."}\n`
        }
      };
    }

    return {
      stdout: templatedOutput.output
    };
  }

  return {
    stdout: renderedOutput.output
  };
}

export async function executePrCommand(args: string[], context: ResolvedCliExecutionContext): Promise<CliResult | undefined> {
  if (
    args[0] !== "pr"
    || (args[1] !== "view" && args[1] !== "list" && args[1] !== "status" && args[1] !== "diff" && args[1] !== "checkout")
  ) {
    return undefined;
  }

  const subcommand = args[1];

  const parsedFlags = parsePullRequestFlags(args.slice(2));

  if (parsedFlags.error !== undefined) {
    return parsedFlags.error;
  }

  if (parsedFlags.flags.jqExpression !== undefined && parsedFlags.flags.jsonFields === undefined) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "--jq requires --json.\n"
    };
  }

  if (parsedFlags.flags.template !== undefined && parsedFlags.flags.jsonFields === undefined) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "--template requires --json.\n"
    };
  }

  if (parsedFlags.flags.template !== undefined && parsedFlags.flags.jqExpression !== undefined) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "Choose at most one of --jq and --template.\n"
    };
  }

  if ((subcommand === "list" || subcommand === "status") && parsedFlags.flags.pullRequestNumber !== undefined) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `pr ${subcommand} does not accept a pull request number.\n`
    };
  }

  if ((subcommand === "view" || subcommand === "diff" || subcommand === "checkout") && parsedFlags.flags.pullRequestNumber === undefined) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "Pull request number is required.\n"
    };
  }

  const pullRequestNumber = parsedFlags.flags.pullRequestNumber;

  const repositoryResult = resolveRepositoryContext(parsedFlags.flags.repository, context);

  if (repositoryResult.error !== undefined || repositoryResult.repository === undefined) {
    return repositoryResult.error ?? {
      exitCode: 1,
      stdout: "",
      stderr: "No Repository Context selected.\n"
    };
  }

  if (subcommand === "list") {
    const pullRequestListResult = await readPullRequestList(repositoryResult.repository, context);

    if (pullRequestListResult.error !== undefined || pullRequestListResult.pullRequests === undefined) {
      return pullRequestListResult.error ?? {
        exitCode: 1,
        stdout: "",
        stderr: "Failed to read pull requests.\n"
      };
    }

    if (parsedFlags.flags.jsonFields !== undefined) {
      const renderedOutput = renderStructuredPullRequestOutput(
        pullRequestListResult.pullRequests,
        parsedFlags.flags.jsonFields,
        parsedFlags.flags.jqExpression,
        parsedFlags.flags.template
      );

      if (renderedOutput.error !== undefined || renderedOutput.stdout === undefined) {
        return renderedOutput.error ?? {
          exitCode: 1,
          stdout: "",
          stderr: "Failed to render structured pull request output.\n"
        };
      }

      return {
        exitCode: 0,
        stdout: renderedOutput.stdout,
        stderr: ""
      };
    }

    return {
      exitCode: 0,
      stdout: renderPullRequestList(pullRequestListResult.pullRequests),
      stderr: ""
    };
  }

  if (subcommand === "status") {
    const currentUserResult = await readCurrentUser(repositoryResult.repository.hostname, context);

    if (currentUserResult.error !== undefined || currentUserResult.login === undefined) {
      return currentUserResult.error ?? {
        exitCode: 1,
        stdout: "",
        stderr: "Failed to resolve the current user.\n"
      };
    }

    const pullRequestListResult = await readPullRequestList(repositoryResult.repository, context);

    if (
      pullRequestListResult.error !== undefined
      || pullRequestListResult.pullRequests === undefined
      || pullRequestListResult.payload === undefined
    ) {
      return pullRequestListResult.error ?? {
        exitCode: 1,
        stdout: "",
        stderr: "Failed to read pull requests.\n"
      };
    }

    const assignedPullRequests = collectMatchingPullRequests(
      pullRequestListResult.payload,
      pullRequestListResult.pullRequests,
      (pullRequest) => isPullRequestAssignedToUser(pullRequest, currentUserResult.login ?? "")
    );
    const openedPullRequests = collectMatchingPullRequests(
      pullRequestListResult.payload,
      pullRequestListResult.pullRequests,
      (pullRequest) => isPullRequestOpenedByUser(pullRequest, currentUserResult.login ?? "")
    );
    const relevantPullRequestMap = new Map<number, PullRequestRecord>();

    for (const pullRequest of [...assignedPullRequests, ...openedPullRequests]) {
      relevantPullRequestMap.set(pullRequest.number, pullRequest);
    }

    const relevantPullRequests = [...relevantPullRequestMap.values()];

    if (parsedFlags.flags.jsonFields !== undefined) {
      const renderedOutput = renderStructuredPullRequestOutput(
        relevantPullRequests,
        parsedFlags.flags.jsonFields,
        parsedFlags.flags.jqExpression,
        parsedFlags.flags.template
      );

      if (renderedOutput.error !== undefined || renderedOutput.stdout === undefined) {
        return renderedOutput.error ?? {
          exitCode: 1,
          stdout: "",
          stderr: "Failed to render structured pull request output.\n"
        };
      }

      return {
        exitCode: 0,
        stdout: renderedOutput.stdout,
        stderr: ""
      };
    }

    return {
      exitCode: 0,
      stdout: renderPullRequestStatus(
        repositoryResult.repository,
        currentUserResult.login,
        assignedPullRequests,
        openedPullRequests
      ),
      stderr: ""
    };
  }

  if (pullRequestNumber === undefined) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "Pull request number is required.\n"
    };
  }

  if (subcommand === "diff") {
    const diffResult = await readPullRequestDiff(
      repositoryResult.repository,
      pullRequestNumber,
      context
    );

    if (diffResult.error !== undefined || diffResult.diff === undefined) {
      return diffResult.error ?? {
        exitCode: 1,
        stdout: "",
        stderr: "Failed to read pull request diff.\n"
      };
    }

    return {
      exitCode: 0,
      stdout: diffResult.diff,
      stderr: ""
    };
  }

  const pullRequestResult = await readPullRequest(
    repositoryResult.repository,
    pullRequestNumber,
    context
  );

  if (pullRequestResult.error !== undefined || pullRequestResult.pullRequest === undefined) {
    return pullRequestResult.error ?? {
      exitCode: 1,
      stdout: "",
      stderr: "Failed to read pull request.\n"
    };
  }

  if (subcommand === "checkout") {
    const checkoutResult = checkoutPullRequest(pullRequestResult.pullRequest, context);

    if (checkoutResult.error !== undefined || checkoutResult.stdout === undefined) {
      return checkoutResult.error ?? {
        exitCode: 1,
        stdout: "",
        stderr: "Failed to check out pull request.\n"
      };
    }

    return {
      exitCode: 0,
      stdout: checkoutResult.stdout,
      stderr: ""
    };
  }

  if (parsedFlags.flags.jsonFields !== undefined) {
    const renderedOutput = renderStructuredPullRequestOutput(
      pullRequestResult.pullRequest,
      parsedFlags.flags.jsonFields,
      parsedFlags.flags.jqExpression,
      parsedFlags.flags.template
    );

    if (renderedOutput.error !== undefined || renderedOutput.stdout === undefined) {
      return renderedOutput.error ?? {
        exitCode: 1,
        stdout: "",
        stderr: "Failed to render structured pull request output.\n"
      };
    }

    return {
      exitCode: 0,
      stdout: renderedOutput.stdout,
      stderr: ""
    };
  }

  return {
    exitCode: 0,
    stdout: renderPullRequest(pullRequestResult.pullRequest),
    stderr: ""
  };
}