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
  showComments?: boolean;
}

interface ParsedIssueCreateFlags {
  repository?: string;
  title?: string;
  body?: string;
}

interface ParsedIssueMutationFlags {
  issueNumber?: number;
  repository?: string;
  title?: string;
  body?: string;
}

interface IssueRecord {
  number: number;
  title: string;
  state: string;
  url: string;
  body?: string;
  authorLogin?: string;
  labelNames?: string[];
  commentCount?: number;
  comments?: IssueCommentRecord[];
}

interface IssueCommentRecord {
  body: string;
  authorLogin?: string;
}

interface GiteaIssuePayload {
  number?: number;
  title?: string;
  state?: string;
  body?: string;
  comments?: number;
  assignee?: { login?: string };
  assignees?: Array<{ login?: string }>;
  user?: { login?: string };
  labels?: Array<{ name?: string }>;
}

interface GiteaIssueCommentPayload {
  id?: number;
  body?: string;
  user?: { login?: string };
}

const issueGroup = supportManifest.children.find(
  (node): node is ManifestGroup => node.kind === "group" && node.name === "issue"
);
const issueViewCommand = issueGroup?.children.find(
  (node): node is ManifestCommand => node.kind === "command" && node.name === "view"
);
const issueOutputFields = new Set((issueViewCommand?.outputFields ?? []).map((field) => field.name));

function renderUnsupportedIssueFlag(subcommand: string, flag: string, reason: string): CliResult {
  return {
    exitCode: 1,
    stdout: "",
    stderr: `${supportManifest.cliName} issue ${subcommand} flag ${flag} is currently unsupported: ${reason}\n`
  };
}

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

function parseIssueFlags(args: string[]): { flags: ParsedIssueFlags; error?: CliResult } {
  const flags: ParsedIssueFlags = {};

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

    if (token === "--comments") {
      flags.showComments = true;
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

function parseIssueCreateFlags(args: string[]): { flags: ParsedIssueCreateFlags; error?: CliResult } {
  const flags: ParsedIssueCreateFlags = {};

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

    if (token === "--recover" || token.startsWith("--recover=")) {
      return {
        flags,
        error: renderUnsupportedIssueFlag(
          "create",
          "--recover",
          "Draft recovery is not part of the supported issue maintenance slice."
        )
      };
    }

    const titleFlag = parseStringFlagValue(args, index, { long: "--title" });

    if (titleFlag.error !== undefined) {
      return {
        flags,
        error: titleFlag.error
      };
    }

    if (titleFlag.handled && titleFlag.value !== undefined) {
      flags.title = titleFlag.value;
      index = titleFlag.nextIndex;
      continue;
    }

    const bodyFlag = parseStringFlagValue(args, index, { long: "--body" });

    if (bodyFlag.error !== undefined) {
      return {
        flags,
        error: bodyFlag.error
      };
    }

    if (bodyFlag.handled && bodyFlag.value !== undefined) {
      flags.body = bodyFlag.value;
      index = bodyFlag.nextIndex;
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

    return {
      flags,
      error: {
        exitCode: 1,
        stdout: "",
        stderr: `Unexpected argument: ${token}\n`
      }
    };
  }

  return { flags };
}

function parseIssueMutationFlags(
  args: string[],
  options: { allowTitle: boolean; allowBody: boolean }
): { flags: ParsedIssueMutationFlags; error?: CliResult } {
  const flags: ParsedIssueMutationFlags = {};

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

    const titleFlag = options.allowTitle
      ? parseStringFlagValue(args, index, { long: "--title" })
      : { handled: false, nextIndex: index };

    if (titleFlag.error !== undefined) {
      return {
        flags,
        error: titleFlag.error
      };
    }

    if (titleFlag.handled && titleFlag.value !== undefined) {
      flags.title = titleFlag.value;
      index = titleFlag.nextIndex;
      continue;
    }

    const bodyFlag = options.allowBody
      ? parseStringFlagValue(args, index, { long: "--body" })
      : { handled: false, nextIndex: index };

    if (bodyFlag.error !== undefined) {
      return {
        flags,
        error: bodyFlag.error
      };
    }

    if (bodyFlag.handled && bodyFlag.value !== undefined) {
      flags.body = bodyFlag.value;
      index = bodyFlag.nextIndex;
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
  const body = typeof payload.body === "string" ? payload.body : undefined;
  const authorLogin = typeof payload.user?.login === "string" ? payload.user.login : undefined;
  const labelNames = Array.isArray(payload.labels)
    ? payload.labels
      .map((label) => (typeof label.name === "string" ? label.name : undefined))
      .filter((label): label is string => label !== undefined && label.length > 0)
    : [];
  const commentCount = typeof payload.comments === "number" ? payload.comments : undefined;

  return {
    number,
    title: typeof payload.title === "string" ? payload.title : `Issue #${number}`,
    state: typeof payload.state === "string" ? payload.state : "unknown",
    url: buildIssueUrl(repository, number),
    ...(body === undefined ? {} : { body }),
    ...(authorLogin === undefined ? {} : { authorLogin }),
    ...(labelNames.length === 0 ? {} : { labelNames }),
    ...(commentCount === undefined ? {} : { commentCount })
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

    if (response.status === 401 || response.status === 403) {
      return {
        error: {
          exitCode: 1,
          stdout: "",
          stderr: `Authentication failed while reading issue #${issueNumber} on ${repository.hostname}.\n`
        }
      };
    }

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

async function readIssueComments(
  repository: RepositoryContext,
  issueNumber: number,
  context: ResolvedCliExecutionContext
): Promise<{ comments?: IssueCommentRecord[]; error?: CliResult }> {
  const requestUrl = `${buildHostBaseUrl(repository.hostname)}/api/v1/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repository)}/issues/${issueNumber}/comments`;
  const token = resolveOptionalToken(repository.hostname, context);

  try {
    const response = await fetch(
      requestUrl,
      token === undefined ? undefined : { headers: { Authorization: `token ${token}` } }
    );

    if (response.status === 401 || response.status === 403) {
      return {
        error: {
          exitCode: 1,
          stdout: "",
          stderr: `Authentication failed while reading issue #${issueNumber} on ${repository.hostname}.\n`
        }
      };
    }

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

    const payload = await response.json() as GiteaIssueCommentPayload[];
    const comments = payload.map((comment) => {
      const body = typeof comment.body === "string" ? comment.body : "";
      const authorLogin = typeof comment.user?.login === "string" ? comment.user.login : undefined;

      return {
        body,
        ...(authorLogin === undefined ? {} : { authorLogin })
      };
    });

    return { comments };
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

async function readGiteaErrorMessage(response: Response): Promise<string | undefined> {
  try {
    const payload = await response.json() as { message?: string };

    return typeof payload.message === "string" && payload.message.length > 0 ? payload.message : undefined;
  } catch {
    return undefined;
  }
}

async function createIssue(
  repository: RepositoryContext,
  title: string,
  body: string | undefined,
  context: ResolvedCliExecutionContext
): Promise<{ issue?: IssueRecord; error?: CliResult }> {
  const token = resolveOptionalToken(repository.hostname, context);

  if (token === undefined) {
    return {
      error: {
        exitCode: 1,
        stdout: "",
        stderr: "gtea issue create requires an authenticated host credential. Run gtea auth login or set GTEA_TOKEN/GH_TOKEN.\n"
      }
    };
  }

  const requestUrl = `${buildHostBaseUrl(repository.hostname)}/api/v1/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repository)}/issues`;

  try {
    const response = await fetch(requestUrl, {
      method: "POST",
      headers: {
        Authorization: `token ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(body === undefined ? { title } : { title, body })
    });

    if (response.status === 401 || response.status === 403) {
      return {
        error: {
          exitCode: 1,
          stdout: "",
          stderr: `Authentication failed while creating an issue on ${repository.hostname}.\n`
        }
      };
    }

    if (response.status === 400 || response.status === 422) {
      const validationMessage = await readGiteaErrorMessage(response);

      return {
        error: {
          exitCode: 1,
          stdout: "",
          stderr: validationMessage === undefined
            ? `Validation failed while creating an issue in ${repository.owner}/${repository.repository}.\n`
            : `Validation failed while creating an issue in ${repository.owner}/${repository.repository}: ${validationMessage}\n`
        }
      };
    }

    if (!response.ok) {
      return {
        error: {
          exitCode: 1,
          stdout: "",
          stderr: `Gitea returned ${response.status} while creating an issue in ${repository.owner}/${repository.repository}.\n`
        }
      };
    }

    return {
      issue: mapIssueRecord(repository, await response.json() as GiteaIssuePayload, 0)
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return {
      error: {
        exitCode: 1,
        stdout: "",
        stderr: `Failed to create an issue on ${repository.hostname}: ${message}\n`
      }
    };
  }
}

async function commentOnIssue(
  repository: RepositoryContext,
  issueNumber: number,
  body: string,
  context: ResolvedCliExecutionContext
): Promise<{ error?: CliResult }> {
  const token = resolveOptionalToken(repository.hostname, context);

  if (token === undefined) {
    return {
      error: {
        exitCode: 1,
        stdout: "",
        stderr: "gtea issue comment requires an authenticated host credential. Run gtea auth login or set GTEA_TOKEN/GH_TOKEN.\n"
      }
    };
  }

  const requestUrl = `${buildHostBaseUrl(repository.hostname)}/api/v1/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repository)}/issues/${issueNumber}/comments`;

  try {
    const response = await fetch(requestUrl, {
      method: "POST",
      headers: {
        Authorization: `token ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ body })
    });

    if (response.status === 401 || response.status === 403) {
      return {
        error: {
          exitCode: 1,
          stdout: "",
          stderr: `Authentication failed while commenting on issue #${issueNumber} on ${repository.hostname}.\n`
        }
      };
    }

    if (response.status === 404) {
      return {
        error: {
          exitCode: 1,
          stdout: "",
          stderr: `Issue #${issueNumber} was not found in ${repository.owner}/${repository.repository}.\n`
        }
      };
    }

    if (response.status === 400 || response.status === 422) {
      const validationMessage = await readGiteaErrorMessage(response);

      return {
        error: {
          exitCode: 1,
          stdout: "",
          stderr: validationMessage === undefined
            ? `Validation failed while commenting on issue #${issueNumber} in ${repository.owner}/${repository.repository}.\n`
            : `Validation failed while commenting on issue #${issueNumber} in ${repository.owner}/${repository.repository}: ${validationMessage}\n`
        }
      };
    }

    if (!response.ok) {
      return {
        error: {
          exitCode: 1,
          stdout: "",
          stderr: `Gitea returned ${response.status} while commenting on issue #${issueNumber} in ${repository.owner}/${repository.repository}.\n`
        }
      };
    }

    return {};
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return {
      error: {
        exitCode: 1,
        stdout: "",
        stderr: `Failed to comment on issue #${issueNumber} on ${repository.hostname}: ${message}\n`
      }
    };
  }
}

async function updateIssue(
  repository: RepositoryContext,
  issueNumber: number,
  payload: { title?: string; body?: string; state?: "open" | "closed" },
  context: ResolvedCliExecutionContext,
  commandName: "edit" | "close" | "reopen",
  actionLabel: string
): Promise<{ issue?: IssueRecord; error?: CliResult }> {
  const token = resolveOptionalToken(repository.hostname, context);

  if (token === undefined) {
    return {
      error: {
        exitCode: 1,
        stdout: "",
        stderr: `gtea issue ${commandName} requires an authenticated host credential. Run gtea auth login or set GTEA_TOKEN/GH_TOKEN.\n`
      }
    };
  }

  const requestUrl = `${buildHostBaseUrl(repository.hostname)}/api/v1/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repository)}/issues/${issueNumber}`;

  try {
    const response = await fetch(requestUrl, {
      method: "PATCH",
      headers: {
        Authorization: `token ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    if (response.status === 401 || response.status === 403) {
      return {
        error: {
          exitCode: 1,
          stdout: "",
          stderr: `Authentication failed while ${actionLabel} issue #${issueNumber} on ${repository.hostname}.\n`
        }
      };
    }

    if (response.status === 404) {
      return {
        error: {
          exitCode: 1,
          stdout: "",
          stderr: `Issue #${issueNumber} was not found in ${repository.owner}/${repository.repository}.\n`
        }
      };
    }

    if (response.status === 400 || response.status === 422) {
      const validationMessage = await readGiteaErrorMessage(response);

      return {
        error: {
          exitCode: 1,
          stdout: "",
          stderr: validationMessage === undefined
            ? `Validation failed while ${actionLabel} issue #${issueNumber} in ${repository.owner}/${repository.repository}.\n`
            : `Validation failed while ${actionLabel} issue #${issueNumber} in ${repository.owner}/${repository.repository}: ${validationMessage}\n`
        }
      };
    }

    if (!response.ok) {
      return {
        error: {
          exitCode: 1,
          stdout: "",
          stderr: `Gitea returned ${response.status} while ${actionLabel} issue #${issueNumber} in ${repository.owner}/${repository.repository}.\n`
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
        stderr: `Failed to ${commandName} issue #${issueNumber} on ${repository.hostname}: ${message}\n`
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

function renderIssue(issue: IssueRecord, options?: { showAllComments?: boolean }): string {
  const lines = [
    `${issue.title} (#${issue.number})`,
    `State: ${issue.state}`,
    ...(issue.authorLogin === undefined ? [] : [`Author: ${issue.authorLogin}`]),
    ...(issue.labelNames === undefined || issue.labelNames.length === 0 ? [] : [`Labels: ${issue.labelNames.join(", ")}`]),
    `URL: ${issue.url}`
  ];

  if (issue.body !== undefined && issue.body.length > 0) {
    lines.push("", issue.body);
  }

  if (issue.comments !== undefined && issue.comments.length > 0) {
    if (options?.showAllComments === true) {
      for (const comment of issue.comments) {
        lines.push(
          "",
          comment.authorLogin === undefined ? "Comment" : `${comment.authorLogin} • Comment`,
          "",
          comment.body
        );
      }
    } else {
      const newestComment = issue.comments[issue.comments.length - 1]!;

      const hiddenCommentCount = Math.max((issue.commentCount ?? issue.comments.length) - 1, 0);

      if (hiddenCommentCount > 0) {
        lines.push("", `-------- Not showing ${hiddenCommentCount} comment${hiddenCommentCount === 1 ? "" : "s"} --------`);
      }

      lines.push(
        "",
        newestComment.authorLogin === undefined ? "Newest comment" : `${newestComment.authorLogin} • Newest comment`,
        "",
        newestComment.body
      );
    }
  }

  return `${lines.join("\n")}\n`;
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

  if (
    args[1] !== "view"
    && args[1] !== "list"
    && args[1] !== "status"
    && args[1] !== "create"
    && args[1] !== "comment"
    && args[1] !== "edit"
    && args[1] !== "close"
    && args[1] !== "reopen"
  ) {
    return undefined;
  }

  const subcommand = args[1];

  if (subcommand === "create") {
    const parsedCreateFlags = parseIssueCreateFlags(args.slice(2));

    if (parsedCreateFlags.error !== undefined) {
      return parsedCreateFlags.error;
    }

    if (parsedCreateFlags.flags.title === undefined) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: "--title is required.\n"
      };
    }

    const repositoryResult = resolveRepositoryContext(parsedCreateFlags.flags.repository, context);

    if (repositoryResult.error !== undefined || repositoryResult.repository === undefined) {
      return repositoryResult.error ?? {
        exitCode: 1,
        stdout: "",
        stderr: "No Repository Context selected.\n"
      };
    }

    const createResult = await createIssue(
      repositoryResult.repository,
      parsedCreateFlags.flags.title,
      parsedCreateFlags.flags.body,
      context
    );

    if (createResult.error !== undefined || createResult.issue === undefined) {
      return createResult.error ?? {
        exitCode: 1,
        stdout: "",
        stderr: "Failed to create issue.\n"
      };
    }

    return {
      exitCode: 0,
      stdout: `${createResult.issue.url}\n`,
      stderr: ""
    };
  }

  if (subcommand === "comment") {
    const parsedMutationFlags = parseIssueMutationFlags(args.slice(2), {
      allowTitle: false,
      allowBody: true
    });

    if (parsedMutationFlags.error !== undefined) {
      return parsedMutationFlags.error;
    }

    if (parsedMutationFlags.flags.issueNumber === undefined) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: "Issue number is required.\n"
      };
    }

    if (parsedMutationFlags.flags.body === undefined) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: "--body is required.\n"
      };
    }

    const repositoryResult = resolveRepositoryContext(parsedMutationFlags.flags.repository, context);

    if (repositoryResult.error !== undefined || repositoryResult.repository === undefined) {
      return repositoryResult.error ?? {
        exitCode: 1,
        stdout: "",
        stderr: "No Repository Context selected.\n"
      };
    }

    const commentResult = await commentOnIssue(
      repositoryResult.repository,
      parsedMutationFlags.flags.issueNumber,
      parsedMutationFlags.flags.body,
      context
    );

    if (commentResult.error !== undefined) {
      return commentResult.error;
    }

    return {
      exitCode: 0,
      stdout: "",
      stderr: ""
    };
  }

  if (subcommand === "edit") {
    const parsedMutationFlags = parseIssueMutationFlags(args.slice(2), {
      allowTitle: true,
      allowBody: true
    });

    if (parsedMutationFlags.error !== undefined) {
      return parsedMutationFlags.error;
    }

    if (parsedMutationFlags.flags.issueNumber === undefined) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: "Issue number is required.\n"
      };
    }

    if (parsedMutationFlags.flags.title === undefined && parsedMutationFlags.flags.body === undefined) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: "At least one of --title or --body is required.\n"
      };
    }

    const repositoryResult = resolveRepositoryContext(parsedMutationFlags.flags.repository, context);

    if (repositoryResult.error !== undefined || repositoryResult.repository === undefined) {
      return repositoryResult.error ?? {
        exitCode: 1,
        stdout: "",
        stderr: "No Repository Context selected.\n"
      };
    }

    const editResult = await updateIssue(
      repositoryResult.repository,
      parsedMutationFlags.flags.issueNumber,
      {
        ...(parsedMutationFlags.flags.title === undefined ? {} : { title: parsedMutationFlags.flags.title }),
        ...(parsedMutationFlags.flags.body === undefined ? {} : { body: parsedMutationFlags.flags.body })
      },
      context,
      "edit",
      "editing"
    );

    if (editResult.error !== undefined || editResult.issue === undefined) {
      return editResult.error ?? {
        exitCode: 1,
        stdout: "",
        stderr: "Failed to edit issue.\n"
      };
    }

    return {
      exitCode: 0,
      stdout: `${editResult.issue.url}\n`,
      stderr: ""
    };
  }

  if (subcommand === "close") {
    const parsedMutationFlags = parseIssueMutationFlags(args.slice(2), {
      allowTitle: false,
      allowBody: false
    });

    if (parsedMutationFlags.error !== undefined) {
      return parsedMutationFlags.error;
    }

    if (parsedMutationFlags.flags.issueNumber === undefined) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: "Issue number is required.\n"
      };
    }

    const repositoryResult = resolveRepositoryContext(parsedMutationFlags.flags.repository, context);

    if (repositoryResult.error !== undefined || repositoryResult.repository === undefined) {
      return repositoryResult.error ?? {
        exitCode: 1,
        stdout: "",
        stderr: "No Repository Context selected.\n"
      };
    }

    const closeResult = await updateIssue(
      repositoryResult.repository,
      parsedMutationFlags.flags.issueNumber,
      { state: "closed" },
      context,
      "close",
      "closing"
    );

    if (closeResult.error !== undefined || closeResult.issue === undefined) {
      return closeResult.error ?? {
        exitCode: 1,
        stdout: "",
        stderr: "Failed to close issue.\n"
      };
    }

    return {
      exitCode: 0,
      stdout: `${closeResult.issue.url}\n`,
      stderr: ""
    };
  }

  if (subcommand === "reopen") {
    const parsedMutationFlags = parseIssueMutationFlags(args.slice(2), {
      allowTitle: false,
      allowBody: false
    });

    if (parsedMutationFlags.error !== undefined) {
      return parsedMutationFlags.error;
    }

    if (parsedMutationFlags.flags.issueNumber === undefined) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: "Issue number is required.\n"
      };
    }

    const repositoryResult = resolveRepositoryContext(parsedMutationFlags.flags.repository, context);

    if (repositoryResult.error !== undefined || repositoryResult.repository === undefined) {
      return repositoryResult.error ?? {
        exitCode: 1,
        stdout: "",
        stderr: "No Repository Context selected.\n"
      };
    }

    const reopenResult = await updateIssue(
      repositoryResult.repository,
      parsedMutationFlags.flags.issueNumber,
      { state: "open" },
      context,
      "reopen",
      "reopening"
    );

    if (reopenResult.error !== undefined || reopenResult.issue === undefined) {
      return reopenResult.error ?? {
        exitCode: 1,
        stdout: "",
        stderr: "Failed to reopen issue.\n"
      };
    }

    return {
      exitCode: 0,
      stdout: `${reopenResult.issue.url}\n`,
      stderr: ""
    };
  }

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

  if (parsedFlags.flags.showComments === true && subcommand !== "view") {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "--comments is only supported with issue view.\n"
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

  if (parsedFlags.flags.showComments === true || (issueResult.issue.commentCount ?? 0) > 0) {
    const commentResult = await readIssueComments(repositoryResult.repository, issueNumber, context);

    if (commentResult.error !== undefined || commentResult.comments === undefined) {
      return commentResult.error ?? {
        exitCode: 1,
        stdout: "",
        stderr: "Failed to read issue comments.\n"
      };
    }

    issueResult.issue = {
      ...issueResult.issue,
      comments: commentResult.comments
    };
  }

  return {
    exitCode: 0,
    stdout: renderIssue(issueResult.issue, { showAllComments: parsedFlags.flags.showComments === true }),
    stderr: ""
  };
}