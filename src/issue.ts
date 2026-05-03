import { spawnSync } from "node:child_process";

import { CliResult, ResolvedCliExecutionContext } from "./cli-runtime.js";
import { buildHostBaseUrl } from "./host-config.js";
import { type RepositoryContext, resolveOptionalToken, resolveRepositoryContext } from "./repository-context.js";
import { renderStructuredJq, renderStructuredJson, renderStructuredTemplate, type StructuredObject } from "./structured-output.js";
import { ManifestCommand, ManifestGroup, supportManifest } from "./support-manifest.js";

interface ParsedIssueFlags {
  issueNumber?: number;
  jsonFields?: string[];
  repository?: string;
  jqExpression?: string;
  template?: string;
}

interface IssueRecord {
  number: number;
  title: string;
  state: string;
  url: string;
}

interface GiteaIssuePayload {
  number?: number;
  title?: string;
  state?: string;
  assignee?: { login?: string };
  assignees?: Array<{ login?: string }>;
  user?: { login?: string };
}

const issueGroup = supportManifest.children.find(
  (node): node is ManifestGroup => node.kind === "group" && node.name === "issue"
);
const issueViewCommand = issueGroup?.children.find(
  (node): node is ManifestCommand => node.kind === "command" && node.name === "view"
);
const issueOutputFields = new Set((issueViewCommand?.outputFields ?? []).map((field) => field.name));

function parseIssueFlags(args: string[]): { flags: ParsedIssueFlags; error?: CliResult } {
  const flags: ParsedIssueFlags = {};

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];

    if (token === undefined) {
      break;
    }

    if (token === "--repo" || token === "-R") {
      const rawRepository = args[index + 1];

      if (rawRepository === undefined || rawRepository.startsWith("-")) {
        return {
          flags,
          error: {
            exitCode: 1,
            stdout: "",
            stderr: "Missing value for --repo.\n"
          }
        };
      }

      flags.repository = rawRepository;
      index += 1;
      continue;
    }

    if (token.startsWith("--repo=")) {
      flags.repository = token.slice("--repo=".length);
      continue;
    }

    if (token === "--json") {
      const rawFields = args[index + 1];

      if (rawFields === undefined || rawFields.startsWith("-")) {
        return {
          flags,
          error: {
            exitCode: 1,
            stdout: "",
            stderr: "Missing value for --json.\n"
          }
        };
      }

      flags.jsonFields = rawFields
        .split(",")
        .map((field) => field.trim())
        .filter((field) => field.length > 0);
      index += 1;
      continue;
    }

    if (token === "--jq") {
      const rawExpression = args[index + 1];

      if (rawExpression === undefined || rawExpression.startsWith("-")) {
        return {
          flags,
          error: {
            exitCode: 1,
            stdout: "",
            stderr: "Missing value for --jq.\n"
          }
        };
      }

      flags.jqExpression = rawExpression;
      index += 1;
      continue;
    }

    if (token === "--template") {
      const rawTemplate = args[index + 1];

      if (rawTemplate === undefined || rawTemplate.startsWith("-")) {
        return {
          flags,
          error: {
            exitCode: 1,
            stdout: "",
            stderr: "Missing value for --template.\n"
          }
        };
      }

      flags.template = rawTemplate;
      index += 1;
      continue;
    }

    if (token.startsWith("--jq=")) {
      flags.jqExpression = token.slice("--jq=".length);
      continue;
    }

    if (token.startsWith("--template=")) {
      flags.template = token.slice("--template=".length);
      continue;
    }

    if (token.startsWith("--json=")) {
      flags.jsonFields = token
        .slice("--json=".length)
        .split(",")
        .map((field) => field.trim())
        .filter((field) => field.length > 0);
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

    if (flags.issueNumber !== undefined) {
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
          stderr: `Invalid issue number: ${token}\n`
        }
      };
    }

    flags.issueNumber = Number.parseInt(token, 10);
  }

  return { flags };
}

function buildIssueUrl(repository: RepositoryContext, issueNumber: number): string {
  return `${buildHostBaseUrl(repository.hostname)}/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repository)}/issues/${issueNumber}`;
}

function mapIssueRecord(repository: RepositoryContext, payload: GiteaIssuePayload, fallbackNumber: number): IssueRecord {
  const number = typeof payload.number === "number" ? payload.number : fallbackNumber;

  return {
    number,
    title: typeof payload.title === "string" ? payload.title : `Issue #${number}`,
    state: typeof payload.state === "string" ? payload.state : "unknown",
    url: buildIssueUrl(repository, number)
  };
}

async function readIssue(
  repository: RepositoryContext,
  issueNumber: number,
  context: ResolvedCliExecutionContext
): Promise<{ issue?: IssueRecord; error?: CliResult }> {
  const requestUrl = `${buildHostBaseUrl(repository.hostname)}/api/v1/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repository)}/issues/${issueNumber}`;
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
          stderr: `Issue #${issueNumber} was not found in ${repository.owner}/${repository.repository}.\n`
        }
      };
    }

    if (!response.ok) {
      return {
        error: {
          exitCode: 1,
          stdout: "",
          stderr: `Gitea returned ${response.status} while reading issue #${issueNumber}.\n`
        }
      };
    }

    return {
      issue: mapIssueRecord(repository, await response.json() as GiteaIssuePayload, issueNumber)
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return {
      error: {
        exitCode: 1,
        stdout: "",
        stderr: `Failed to read issue #${issueNumber} from ${repository.hostname}: ${message}\n`
      }
    };
  }
}

async function readIssueList(
  repository: RepositoryContext,
  context: ResolvedCliExecutionContext
): Promise<{ issues?: IssueRecord[]; payload?: GiteaIssuePayload[]; error?: CliResult }> {
  const requestUrl = `${buildHostBaseUrl(repository.hostname)}/api/v1/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repository)}/issues?state=open`;
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
          stderr: `Gitea returned ${response.status} while reading issues for ${repository.owner}/${repository.repository}.\n`
        }
      };
    }

    const payload = await response.json() as GiteaIssuePayload[];

    return {
      issues: payload.map((entry, index) => mapIssueRecord(repository, entry, index + 1)),
      payload
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return {
      error: {
        exitCode: 1,
        stdout: "",
        stderr: `Failed to read issues from ${repository.hostname}: ${message}\n`
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
        stderr: "gtea issue status requires an authenticated host credential. Run gtea auth login or set GTEA_TOKEN/GH_TOKEN.\n"
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

function renderIssue(issue: IssueRecord): string {
  return `${issue.title} (#${issue.number})\nState: ${issue.state}\nURL: ${issue.url}\n`;
}

function renderIssueList(issues: IssueRecord[]): string {
  if (issues.length === 0) {
    return "No open issues found.\n";
  }

  return `${issues.map((issue) => `#${issue.number}  [${issue.state}] ${issue.title}`).join("\n")}\n`;
}

function isIssueAssignedToUser(issue: GiteaIssuePayload, login: string): boolean {
  if (issue.assignee?.login === login) {
    return true;
  }

  return issue.assignees?.some((assignee) => assignee.login === login) ?? false;
}

function isIssueOpenedByUser(issue: GiteaIssuePayload, login: string): boolean {
  return issue.user?.login === login;
}

function renderIssueStatus(
  repository: RepositoryContext,
  login: string,
  assignedIssues: IssueRecord[],
  openedIssues: IssueRecord[]
): string {
  const lines = [`Relevant open issues for ${login} in ${repository.owner}/${repository.repository}`];

  lines.push("", "Assigned to you");
  lines.push(...(assignedIssues.length === 0 ? ["  None"] : assignedIssues.map((issue) => `  #${issue.number}  [${issue.state}] ${issue.title}`)));

  lines.push("", "Opened by you");
  lines.push(...(openedIssues.length === 0 ? ["  None"] : openedIssues.map((issue) => `  #${issue.number}  [${issue.state}] ${issue.title}`)));

  return `${lines.join("\n")}\n`;
}

function renderStructuredIssueOutput(
  value: IssueRecord | IssueRecord[],
  jsonFields: string[],
  jqExpression?: string,
  template?: string
): { stdout?: string; error?: CliResult } {
  const renderedOutput = renderStructuredJson(value, jsonFields, issueOutputFields);

  if (renderedOutput.error !== undefined || renderedOutput.output === undefined) {
    return {
      error: {
        exitCode: 1,
        stdout: "",
        stderr: `${renderedOutput.error ?? "Failed to render structured issue output."}\n`
      }
    };
  }

  if (jqExpression !== undefined) {
    const filteredOutput = renderStructuredJq(JSON.parse(renderedOutput.output) as StructuredObject | StructuredObject[], jqExpression);

    if (filteredOutput.error !== undefined || filteredOutput.output === undefined) {
      return {
        error: {
          exitCode: 1,
          stdout: "",
          stderr: `${filteredOutput.error ?? "Failed to filter structured issue output."}\n`
        }
      };
    }

    return {
      stdout: filteredOutput.output
    };
  }

  if (template !== undefined) {
    const templatedOutput = renderStructuredTemplate(JSON.parse(renderedOutput.output) as StructuredObject | StructuredObject[], template);

    if (templatedOutput.error !== undefined || templatedOutput.output === undefined) {
      return {
        error: {
          exitCode: 1,
          stdout: "",
          stderr: `${templatedOutput.error ?? "Failed to render structured issue template."}\n`
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

export async function executeIssueCommand(args: string[], context: ResolvedCliExecutionContext): Promise<CliResult | undefined> {
  if (args[0] !== "issue") {
    return undefined;
  }

  if (args[1] !== "view" && args[1] !== "list" && args[1] !== "status") {
    return undefined;
  }

  const subcommand = args[1];

  const parsedFlags = parseIssueFlags(args.slice(2));

  if (parsedFlags.error !== undefined) {
    return parsedFlags.error;
  }

  if (subcommand === "view" && parsedFlags.flags.issueNumber === undefined) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "Issue number is required.\n"
    };
  }

  if ((subcommand === "list" || subcommand === "status") && parsedFlags.flags.issueNumber !== undefined) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `issue ${subcommand} does not accept an issue number.\n`
    };
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

  const repositoryResult = resolveRepositoryContext(parsedFlags.flags.repository, context);

  if (repositoryResult.error !== undefined || repositoryResult.repository === undefined) {
    return repositoryResult.error ?? {
      exitCode: 1,
      stdout: "",
      stderr: "No Repository Context selected.\n"
    };
  }

  if (subcommand === "list") {
    const issueListResult = await readIssueList(repositoryResult.repository, context);

    if (issueListResult.error !== undefined || issueListResult.issues === undefined) {
      return issueListResult.error ?? {
        exitCode: 1,
        stdout: "",
        stderr: "Failed to read issues.\n"
      };
    }

    if (parsedFlags.flags.jsonFields !== undefined) {
      const renderedOutput = renderStructuredIssueOutput(
        issueListResult.issues,
        parsedFlags.flags.jsonFields,
        parsedFlags.flags.jqExpression,
        parsedFlags.flags.template
      );

      if (renderedOutput.error !== undefined || renderedOutput.stdout === undefined) {
        return renderedOutput.error ?? {
          exitCode: 1,
          stdout: "",
          stderr: "Failed to render structured issue output.\n"
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
      stdout: renderIssueList(issueListResult.issues),
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

    const issueListResult = await readIssueList(repositoryResult.repository, context);

    if (
      issueListResult.error !== undefined
      || issueListResult.issues === undefined
      || issueListResult.payload === undefined
    ) {
      return issueListResult.error ?? {
        exitCode: 1,
        stdout: "",
        stderr: "Failed to read issues.\n"
      };
    }

    const assignedIssues = issueListResult.payload
      .map((issue, index) => ({ issue, record: issueListResult.issues?.[index] }))
      .filter((entry): entry is { issue: GiteaIssuePayload; record: IssueRecord } => entry.record !== undefined)
      .filter((entry) => isIssueAssignedToUser(entry.issue, currentUserResult.login ?? ""))
      .map((entry) => entry.record);
    const openedIssues = issueListResult.payload
      .map((issue, index) => ({ issue, record: issueListResult.issues?.[index] }))
      .filter((entry): entry is { issue: GiteaIssuePayload; record: IssueRecord } => entry.record !== undefined)
      .filter((entry) => isIssueOpenedByUser(entry.issue, currentUserResult.login ?? ""))
      .map((entry) => entry.record);
    const relevantIssueMap = new Map<number, IssueRecord>();

    for (const issue of [...assignedIssues, ...openedIssues]) {
      relevantIssueMap.set(issue.number, issue);
    }

    const relevantIssues = [...relevantIssueMap.values()];

    if (parsedFlags.flags.jsonFields !== undefined) {
      const renderedOutput = renderStructuredIssueOutput(
        relevantIssues,
        parsedFlags.flags.jsonFields,
        parsedFlags.flags.jqExpression,
        parsedFlags.flags.template
      );

      if (renderedOutput.error !== undefined || renderedOutput.stdout === undefined) {
        return renderedOutput.error ?? {
          exitCode: 1,
          stdout: "",
          stderr: "Failed to render structured issue output.\n"
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
      stdout: renderIssueStatus(repositoryResult.repository, currentUserResult.login, assignedIssues, openedIssues),
      stderr: ""
    };
  }

  const issueNumber = parsedFlags.flags.issueNumber;

  if (issueNumber === undefined) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "Issue number is required.\n"
    };
  }

  const issueResult = await readIssue(repositoryResult.repository, issueNumber, context);

  if (issueResult.error !== undefined || issueResult.issue === undefined) {
    return issueResult.error ?? {
      exitCode: 1,
      stdout: "",
      stderr: "Failed to read issue.\n"
    };
  }

  if (parsedFlags.flags.jsonFields !== undefined) {
    const renderedOutput = renderStructuredIssueOutput(
      issueResult.issue,
      parsedFlags.flags.jsonFields,
      parsedFlags.flags.jqExpression,
      parsedFlags.flags.template
    );

    if (renderedOutput.error !== undefined || renderedOutput.stdout === undefined) {
      return renderedOutput.error ?? {
        exitCode: 1,
        stdout: "",
        stderr: "Failed to render structured issue output.\n"
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
    stdout: renderIssue(issueResult.issue),
    stderr: ""
  };
}