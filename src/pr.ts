import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

import { CliResult, ResolvedCliExecutionContext } from "./cli-runtime.js";
import { buildHostBaseUrl, buildProcessEnv } from "./host-config.js";
import {
  buildAuthorizationHeaders,
  preferOptionalTokenError,
  type RepositoryContext,
  resolveOptionalTokenResult,
  resolveRepositoryCommandTarget,
  resolveRequiredTokenResult
} from "./repository-context.js";
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
  showComments?: boolean;
}

interface ParsedPullRequestCreateFlags {
  repository?: string;
  title?: string;
  body?: string;
  bodyFile?: string;
  base?: string;
  head?: string;
}

interface ParsedPullRequestCommentFlags {
  pullRequestNumber?: number;
  repository?: string;
  body?: string;
  bodyFile?: string;
}

type PullRequestReviewEvent = "APPROVED" | "COMMENT" | "REQUEST_CHANGES";

interface ParsedPullRequestReviewFlags {
  pullRequestNumber?: number;
  repository?: string;
  body?: string;
  bodyFile?: string;
  inlineCommentsFile?: string;
  event?: PullRequestReviewEvent;
}

interface InlineReviewCommentInput {
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  body: string;
}

type GiteaInlineReviewComment = {
  path: string;
  body: string;
} & ({ old_position: number } | { new_position: number });

type PullRequestMergeMethod = "merge" | "rebase" | "squash";

interface ParsedPullRequestMergeFlags {
  pullRequestNumber?: number;
  repository?: string;
  body?: string;
  bodyFile?: string;
  subject?: string;
  method?: PullRequestMergeMethod;
  deleteBranch?: boolean;
  admin?: boolean;
  matchHeadCommit?: string;
}

interface PullRequestRecord {
  number: number;
  title: string;
  state: string;
  headRefName: string;
  baseRefName: string;
  url: string;
  body?: string;
  commentCount?: number;
  comments?: PullRequestCommentRecord[];
}

interface PullRequestUserRecord extends StructuredObject {
  id: number | null;
  login: string | null;
  name: string | null;
}

interface PullRequestCommentRecord extends StructuredObject {
  id: number | null;
  author: PullRequestUserRecord | null;
  body: string;
  createdAt: string | null;
  updatedAt: string | null;
  url: string | null;
}

interface GiteaPullRequestPayload {
  number?: number;
  title?: string;
  state?: string;
  body?: string;
  comments?: number;
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

interface GiteaPullRequestUserPayload {
  id?: number;
  login?: string;
  full_name?: string;
}

interface GiteaPullRequestCommentPayload {
  id?: number;
  body?: string;
  created_at?: string;
  updated_at?: string;
  html_url?: string;
  user?: GiteaPullRequestUserPayload | null;
}

interface GiteaPullRequestReviewPayload {
  id?: number;
  body?: string;
  submitted_at?: string;
  user?: GiteaPullRequestUserPayload | null;
}

const prGroup = supportManifest.children.find(
  (node): node is ManifestGroup => node.kind === "group" && node.name === "pr"
);
const prViewCommand = prGroup?.children.find(
  (node): node is ManifestCommand => node.kind === "command" && node.name === "view"
);
const prOutputFields = new Set((prViewCommand?.outputFields ?? []).map((field) => field.name));

function renderUnsupportedPullRequestFlag(subcommand: string, flag: string, reason: string): CliResult {
  return {
    exitCode: 1,
    stdout: "",
    stderr: `${supportManifest.cliName} pr ${subcommand} flag ${flag} is currently unsupported: ${reason}\n`
  };
}

function parseStringFlagValue(
  args: string[],
  index: number,
  options: { long: string; short?: string; allowDashValue?: boolean }
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

  if (
    rawValue === undefined
    || (rawValue.startsWith("-") && !(options.allowDashValue === true && rawValue === "-"))
  ) {
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

function parsePullRequestCreateFlags(args: string[]): { flags: ParsedPullRequestCreateFlags; error?: CliResult } {
  const flags: ParsedPullRequestCreateFlags = {};

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

    const createUnsupportedValueFlags = [
      {
        long: "--assignee",
        short: "-a",
        reason: "Pull request assignee planning is not part of the supported pull request create slice."
      },
      {
        long: "--label",
        short: "-l",
        reason: "Pull request label planning is not part of the supported pull request create slice."
      },
      {
        long: "--milestone",
        short: "-m",
        reason: "Pull request milestone planning is not part of the supported pull request create slice."
      },
      {
        long: "--project",
        short: "-p",
        reason: "Project assignment is not part of the supported pull request create slice."
      },
      {
        long: "--recover",
        reason: "Draft recovery is not part of the supported pull request create slice."
      },
      {
        long: "--reviewer",
        short: "-r",
        reason: "Reviewer assignment is not part of the supported pull request create slice."
      },
      {
        long: "--template",
        short: "-T",
        reason: "Template expansion is not part of the supported pull request create slice."
      }
    ] as const;

    for (const unsupportedFlag of createUnsupportedValueFlags) {
      const unsupportedValueFlag = parseStringFlagValue(args, index, unsupportedFlag);

      if (unsupportedValueFlag.error !== undefined) {
        return {
          flags,
          error: unsupportedValueFlag.error
        };
      }

      if (unsupportedValueFlag.handled) {
        return {
          flags,
          error: renderUnsupportedPullRequestFlag("create", unsupportedFlag.long, unsupportedFlag.reason)
        };
      }
    }

    const createUnsupportedBooleanFlags: Array<{ long: string; short?: string; reason: string }> = [
      {
        long: "--draft",
        short: "-d",
        reason: "Draft pull request creation is not part of the supported pull request write slice."
      },
      {
        long: "--dry-run",
        reason: "Previewing or pushing PR branches without creating the pull request is not part of the supported pull request create slice."
      },
      {
        long: "--editor",
        short: "-e",
        reason: "Interactive editor-driven pull request drafting is not part of the supported pull request create slice."
      },
      {
        long: "--fill",
        short: "-f",
        reason: "Commit-based autofill is not part of the supported pull request create slice."
      },
      {
        long: "--fill-first",
        reason: "Commit-based autofill is not part of the supported pull request create slice."
      },
      {
        long: "--fill-verbose",
        reason: "Commit-based autofill is not part of the supported pull request create slice."
      },
      {
        long: "--no-maintainer-edit",
        reason: "Maintainer edit policy changes are not part of the supported pull request create slice."
      },
      {
        long: "--web",
        short: "-w",
        reason: "Browser-driven pull request creation is not part of the supported pull request create slice."
      }
    ] as const;

    for (const unsupportedFlag of createUnsupportedBooleanFlags) {
      if (token === unsupportedFlag.long || (unsupportedFlag.short !== undefined && token === unsupportedFlag.short)) {
        return {
          flags,
          error: renderUnsupportedPullRequestFlag("create", unsupportedFlag.long, unsupportedFlag.reason)
        };
      }
    }

    const titleFlag = parseStringFlagValue(args, index, { long: "--title", short: "-t" });

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

    const bodyFlag = parseStringFlagValue(args, index, { long: "--body", short: "-b" });

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

    const bodyFileFlag = parseStringFlagValue(args, index, { long: "--body-file", short: "-F", allowDashValue: true });

    if (bodyFileFlag.error !== undefined) {
      return {
        flags,
        error: bodyFileFlag.error
      };
    }

    if (bodyFileFlag.handled && bodyFileFlag.value !== undefined) {
      flags.bodyFile = bodyFileFlag.value;
      index = bodyFileFlag.nextIndex;
      continue;
    }

    const baseFlag = parseStringFlagValue(args, index, { long: "--base", short: "-B" });

    if (baseFlag.error !== undefined) {
      return {
        flags,
        error: baseFlag.error
      };
    }

    if (baseFlag.handled && baseFlag.value !== undefined) {
      flags.base = baseFlag.value;
      index = baseFlag.nextIndex;
      continue;
    }

    const headFlag = parseStringFlagValue(args, index, { long: "--head", short: "-H" });

    if (headFlag.error !== undefined) {
      return {
        flags,
        error: headFlag.error
      };
    }

    if (headFlag.handled && headFlag.value !== undefined) {
      flags.head = headFlag.value;
      index = headFlag.nextIndex;
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

function resolvePullRequestBodyInput(
  flags: { body?: string; bodyFile?: string },
  context: ResolvedCliExecutionContext
): { body?: string; error?: CliResult } {
  if (flags.body !== undefined && flags.bodyFile !== undefined) {
    return {
      error: {
        exitCode: 1,
        stdout: "",
        stderr: "Specify only one of --body or --body-file.\n"
      }
    };
  }

  if (flags.bodyFile === undefined) {
    return {
      ...(flags.body === undefined ? {} : { body: flags.body })
    };
  }

  if (flags.bodyFile === "-") {
    return {
      body: context.stdin
    };
  }

  try {
    return {
      body: readFileSync(resolvePath(context.cwd, flags.bodyFile), "utf8")
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return {
      error: {
        exitCode: 1,
        stdout: "",
        stderr: `Failed to read pull request body from ${flags.bodyFile}: ${message}\n`
      }
    };
  }
}

function parsePullRequestCommentFlags(args: string[]): { flags: ParsedPullRequestCommentFlags; error?: CliResult } {
  const flags: ParsedPullRequestCommentFlags = {};

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

    const commentUnsupportedBooleanFlags: Array<{ long: string; short?: string; reason: string }> = [
      {
        long: "--create-if-none",
        reason: "Editing or synthesizing prior pull request comments is not part of the supported pull request comment slice."
      },
      {
        long: "--delete-last",
        reason: "Deleting prior pull request comments is not part of the supported pull request comment slice."
      },
      {
        long: "--edit-last",
        reason: "Editing prior pull request comments is not part of the supported pull request comment slice."
      },
      {
        long: "--editor",
        short: "-e",
        reason: "Interactive editor-driven pull request comments are not part of the supported pull request comment slice."
      },
      {
        long: "--web",
        short: "-w",
        reason: "Browser-driven pull request comments are not part of the supported pull request comment slice."
      },
      {
        long: "--yes",
        reason: "Delete confirmation control is not part of the supported pull request comment slice."
      }
    ] as const;

    for (const unsupportedFlag of commentUnsupportedBooleanFlags) {
      if (token === unsupportedFlag.long || (unsupportedFlag.short !== undefined && token === unsupportedFlag.short)) {
        return {
          flags,
          error: renderUnsupportedPullRequestFlag("comment", unsupportedFlag.long, unsupportedFlag.reason)
        };
      }
    }

    const bodyFlag = parseStringFlagValue(args, index, { long: "--body", short: "-b" });

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

    const bodyFileFlag = parseStringFlagValue(args, index, { long: "--body-file", short: "-F", allowDashValue: true });

    if (bodyFileFlag.error !== undefined) {
      return {
        flags,
        error: bodyFileFlag.error
      };
    }

    if (bodyFileFlag.handled && bodyFileFlag.value !== undefined) {
      flags.bodyFile = bodyFileFlag.value;
      index = bodyFileFlag.nextIndex;
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

/** @author S.Wienand */
function parsePullRequestReviewFlags(args: string[]): { flags: ParsedPullRequestReviewFlags; error?: CliResult } {
  const flags: ParsedPullRequestReviewFlags = {};

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

    const bodyFlag = parseStringFlagValue(args, index, { long: "--body", short: "-b" });

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

    const bodyFileFlag = parseStringFlagValue(args, index, { long: "--body-file", short: "-F", allowDashValue: true });

    if (bodyFileFlag.error !== undefined) {
      return {
        flags,
        error: bodyFileFlag.error
      };
    }

    if (bodyFileFlag.handled && bodyFileFlag.value !== undefined) {
      flags.bodyFile = bodyFileFlag.value;
      index = bodyFileFlag.nextIndex;
      continue;
    }

    const inlineCommentsFileFlag = parseStringFlagValue(args, index, {
      long: "--inline-comments-file",
      allowDashValue: true
    });

    if (inlineCommentsFileFlag.error !== undefined) {
      return {
        flags,
        error: inlineCommentsFileFlag.error
      };
    }

    if (inlineCommentsFileFlag.handled && inlineCommentsFileFlag.value !== undefined) {
      flags.inlineCommentsFile = inlineCommentsFileFlag.value;
      index = inlineCommentsFileFlag.nextIndex;
      continue;
    }

    if (token === "--approve" || token === "-a") {
      if (flags.event !== undefined) {
        return {
          flags,
          error: {
            exitCode: 1,
            stdout: "",
            stderr: "Specify at most one of --approve, --comment, and --request-changes.\n"
          }
        };
      }

      flags.event = "APPROVED";
      continue;
    }

    if (token === "--comment" || token === "-c") {
      if (flags.event !== undefined) {
        return {
          flags,
          error: {
            exitCode: 1,
            stdout: "",
            stderr: "Specify at most one of --approve, --comment, and --request-changes.\n"
          }
        };
      }

      flags.event = "COMMENT";
      continue;
    }

    if (token === "--request-changes" || token === "-r") {
      if (flags.event !== undefined) {
        return {
          flags,
          error: {
            exitCode: 1,
            stdout: "",
            stderr: "Specify at most one of --approve, --comment, and --request-changes.\n"
          }
        };
      }

      flags.event = "REQUEST_CHANGES";
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

/** @author S.Wienand */
function renderInlineReviewCommentInputError(message: string): { error: CliResult } {
  return {
    error: {
      exitCode: 1,
      stdout: "",
      stderr: `${message}\n`
    }
  };
}

/** @author S.Wienand */
function resolveInlineReviewCommentInput(
  inlineCommentsFile: string | undefined,
  context: ResolvedCliExecutionContext
): { comments?: InlineReviewCommentInput[]; error?: CliResult } {
  if (inlineCommentsFile === undefined) {
    return {};
  }

  let document: string;

  if (inlineCommentsFile === "-") {
    document = context.stdin;
  } else {
    try {
      document = readFileSync(resolvePath(context.cwd, inlineCommentsFile), "utf8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      return renderInlineReviewCommentInputError(
        `Failed to read inline review comments from ${inlineCommentsFile}: ${message}`
      );
    }
  }

  let payload: unknown;

  try {
    payload = JSON.parse(document);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return renderInlineReviewCommentInputError(`Invalid inline review comments JSON: ${message}`);
  }

  if (!Array.isArray(payload) || payload.length === 0) {
    return renderInlineReviewCommentInputError("Inline review comments must be a non-empty JSON array.");
  }

  const comments: InlineReviewCommentInput[] = [];

  for (const [index, entry] of payload.entries()) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return renderInlineReviewCommentInputError(`Inline review comment ${index + 1} must be an object.`);
    }

    const candidate = entry as Record<string, unknown>;

    if (typeof candidate.path !== "string") {
      return renderInlineReviewCommentInputError(`Inline review comment ${index + 1} path must be a string.`);
    }

    if (typeof candidate.body !== "string" || candidate.body.trim().length === 0) {
      return renderInlineReviewCommentInputError(
        `Inline review comment ${index + 1} body must be a non-empty string.`
      );
    }

    if (typeof candidate.line !== "number" || !Number.isInteger(candidate.line) || candidate.line <= 0) {
      return renderInlineReviewCommentInputError(
        `Inline review comment ${index + 1} line must be a positive integer.`
      );
    }

    if (candidate.side !== "LEFT" && candidate.side !== "RIGHT") {
      return renderInlineReviewCommentInputError(`Inline review comment ${index + 1} side must be LEFT or RIGHT.`);
    }

    comments.push({
      path: candidate.path,
      body: candidate.body,
      line: candidate.line,
      side: candidate.side
    });
  }

  return { comments };
}

function parsePullRequestMergeFlags(args: string[]): { flags: ParsedPullRequestMergeFlags; error?: CliResult } {
  const flags: ParsedPullRequestMergeFlags = {};

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

    const authorEmailFlag = parseStringFlagValue(args, index, { long: "--author-email", short: "-A" });

    if (authorEmailFlag.error !== undefined) {
      return {
        flags,
        error: authorEmailFlag.error
      };
    }

    if (authorEmailFlag.handled) {
      return {
        flags,
        error: renderUnsupportedPullRequestFlag(
          "merge",
          "--author-email",
          "Setting a custom merge author email is not part of the supported pull request merge slice."
        )
      };
    }

    if (token === "--auto") {
      return {
        flags,
        error: renderUnsupportedPullRequestFlag(
          "merge",
          "--auto",
          "Auto-merge queue semantics are not part of the supported pull request merge slice."
        )
      };
    }

    if (token === "--disable-auto") {
      return {
        flags,
        error: renderUnsupportedPullRequestFlag(
          "merge",
          "--disable-auto",
          "Disabling scheduled auto-merge is not part of the supported pull request merge slice."
        )
      };
    }

    const bodyFlag = parseStringFlagValue(args, index, { long: "--body", short: "-b" });

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

    const bodyFileFlag = parseStringFlagValue(args, index, { long: "--body-file", short: "-F", allowDashValue: true });

    if (bodyFileFlag.error !== undefined) {
      return {
        flags,
        error: bodyFileFlag.error
      };
    }

    if (bodyFileFlag.handled && bodyFileFlag.value !== undefined) {
      flags.bodyFile = bodyFileFlag.value;
      index = bodyFileFlag.nextIndex;
      continue;
    }

    const subjectFlag = parseStringFlagValue(args, index, { long: "--subject", short: "-t" });

    if (subjectFlag.error !== undefined) {
      return {
        flags,
        error: subjectFlag.error
      };
    }

    if (subjectFlag.handled && subjectFlag.value !== undefined) {
      flags.subject = subjectFlag.value;
      index = subjectFlag.nextIndex;
      continue;
    }

    const matchHeadCommitFlag = parseStringFlagValue(args, index, { long: "--match-head-commit" });

    if (matchHeadCommitFlag.error !== undefined) {
      return {
        flags,
        error: matchHeadCommitFlag.error
      };
    }

    if (matchHeadCommitFlag.handled && matchHeadCommitFlag.value !== undefined) {
      flags.matchHeadCommit = matchHeadCommitFlag.value;
      index = matchHeadCommitFlag.nextIndex;
      continue;
    }

    if (token === "--delete-branch" || token === "-d") {
      flags.deleteBranch = true;
      continue;
    }

    if (token === "--admin") {
      flags.admin = true;
      continue;
    }

    const mergeMethod = token === "--merge" || token === "-m"
      ? "merge"
      : token === "--rebase" || token === "-r"
        ? "rebase"
        : token === "--squash" || token === "-s"
          ? "squash"
          : undefined;

    if (mergeMethod !== undefined) {
      if (flags.method !== undefined) {
        return {
          flags,
          error: {
            exitCode: 1,
            stdout: "",
            stderr: "Specify at most one of --merge, --rebase, and --squash.\n"
          }
        };
      }

      flags.method = mergeMethod;
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
  const body = typeof payload.body === "string" ? payload.body : undefined;
  const commentCount = typeof payload.comments === "number" ? payload.comments : undefined;

  return {
    number,
    title: typeof payload.title === "string" ? payload.title : `Pull request #${number}`,
    state: typeof payload.state === "string" ? payload.state : "unknown",
    headRefName: typeof payload.head?.ref === "string" ? payload.head.ref : "unknown",
    baseRefName: typeof payload.base?.ref === "string" ? payload.base.ref : "unknown",
    url: buildPullRequestUrl(repository, number),
    ...(body === undefined ? {} : { body }),
    ...(commentCount === undefined ? {} : { commentCount })
  };
}

function mapPullRequestUserRecord(payload?: GiteaPullRequestUserPayload | null): PullRequestUserRecord | null {
  if (payload === undefined || payload === null) {
    return null;
  }

  const id = typeof payload.id === "number" ? payload.id : null;
  const login = typeof payload.login === "string" ? payload.login : null;
  const name = typeof payload.full_name === "string" ? payload.full_name : null;

  return id === null && login === null && name === null ? null : { id, login, name };
}

function mapPullRequestCommentRecord(
  payload: GiteaPullRequestCommentPayload,
  fallbackCreatedAt?: string
): PullRequestCommentRecord {
  return {
    id: typeof payload.id === "number" ? payload.id : null,
    author: mapPullRequestUserRecord(payload.user),
    body: typeof payload.body === "string" ? payload.body : "",
    createdAt: typeof payload.created_at === "string" ? payload.created_at : fallbackCreatedAt ?? null,
    updatedAt: typeof payload.updated_at === "string" ? payload.updated_at : null,
    url: typeof payload.html_url === "string" ? payload.html_url : null
  };
}

async function readGiteaErrorMessage(response: Response): Promise<string | undefined> {
  try {
    const payload = await response.json() as { message?: string };

    return typeof payload.message === "string" && payload.message.length > 0 ? payload.message : undefined;
  } catch {
    return undefined;
  }
}

function resolveRequiredPullRequestToken(
  hostname: string,
  context: ResolvedCliExecutionContext,
  commandName: string
): { token: string } | { error: CliResult } {
  return resolveRequiredTokenResult(hostname, context, {
    exitCode: 1,
    stdout: "",
    stderr: `gtea pr ${commandName} requires an authenticated host credential. Run gtea auth login or set GTEA_TOKEN/GH_TOKEN.\n`
  });
}

async function createPullRequest(
  repository: RepositoryContext,
  flags: { title: string; base: string; head: string; body?: string },
  context: ResolvedCliExecutionContext
): Promise<{ pullRequest?: PullRequestRecord; error?: CliResult }> {
  const tokenResult = resolveRequiredPullRequestToken(repository.hostname, context, "create");

  if ("error" in tokenResult) {
    return { error: tokenResult.error };
  }

  const requestUrl = `${buildHostBaseUrl(repository.hostname)}/api/v1/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repository)}/pulls`;
  const requestBody = flags.body === undefined
    ? { title: flags.title, base: flags.base, head: flags.head }
    : { title: flags.title, body: flags.body, base: flags.base, head: flags.head };

  try {
    const response = await fetch(requestUrl, {
      method: "POST",
      headers: {
        Authorization: `token ${tokenResult.token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(requestBody)
    });

    if (response.status === 401 || response.status === 403) {
      return {
        error: {
          exitCode: 1,
          stdout: "",
          stderr: `Authentication failed while creating a pull request on ${repository.hostname}.\n`
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
            ? `Validation failed while creating a pull request in ${repository.owner}/${repository.repository}.\n`
            : `Validation failed while creating a pull request in ${repository.owner}/${repository.repository}: ${validationMessage}\n`
        }
      };
    }

    if (!response.ok) {
      return {
        error: {
          exitCode: 1,
          stdout: "",
          stderr: `Gitea returned ${response.status} while creating a pull request in ${repository.owner}/${repository.repository}.\n`
        }
      };
    }

    return {
      pullRequest: mapPullRequestRecord(repository, await response.json() as GiteaPullRequestPayload, 0)
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return {
      error: {
        exitCode: 1,
        stdout: "",
        stderr: `Failed to create a pull request on ${repository.hostname}: ${message}\n`
      }
    };
  }
}

async function commentOnPullRequest(
  repository: RepositoryContext,
  pullRequestNumber: number,
  body: string,
  context: ResolvedCliExecutionContext
): Promise<{ error?: CliResult }> {
  const tokenResult = resolveRequiredPullRequestToken(repository.hostname, context, "comment");

  if ("error" in tokenResult) {
    return { error: tokenResult.error };
  }

  const requestUrl = `${buildHostBaseUrl(repository.hostname)}/api/v1/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repository)}/issues/${pullRequestNumber}/comments`;

  try {
    const response = await fetch(requestUrl, {
      method: "POST",
      headers: {
        Authorization: `token ${tokenResult.token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ body })
    });

    if (response.status === 401 || response.status === 403) {
      return {
        error: {
          exitCode: 1,
          stdout: "",
          stderr: `Authentication failed while commenting on pull request #${pullRequestNumber} on ${repository.hostname}.\n`
        }
      };
    }

    if (response.status === 404) {
      return {
        error: {
          exitCode: 1,
          stdout: "",
          stderr: `Pull request #${pullRequestNumber} was not found in ${repository.owner}/${repository.repository}.\n`
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
            ? `Validation failed while commenting on pull request #${pullRequestNumber} in ${repository.owner}/${repository.repository}.\n`
            : `Validation failed while commenting on pull request #${pullRequestNumber} in ${repository.owner}/${repository.repository}: ${validationMessage}\n`
        }
      };
    }

    if (!response.ok) {
      return {
        error: {
          exitCode: 1,
          stdout: "",
          stderr: `Gitea returned ${response.status} while commenting on pull request #${pullRequestNumber} in ${repository.owner}/${repository.repository}.\n`
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
        stderr: `Failed to comment on pull request #${pullRequestNumber} on ${repository.hostname}: ${message}\n`
      }
    };
  }
}

/** @author S.Wienand */
async function reviewPullRequest(
  repository: RepositoryContext,
  pullRequestNumber: number,
  review: { event: PullRequestReviewEvent; body?: string; comments?: InlineReviewCommentInput[] },
  context: ResolvedCliExecutionContext
): Promise<{ error?: CliResult }> {
  const tokenResult = resolveRequiredPullRequestToken(repository.hostname, context, "review");

  if ("error" in tokenResult) {
    return { error: tokenResult.error };
  }

  const requestUrl = `${buildHostBaseUrl(repository.hostname)}/api/v1/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repository)}/pulls/${pullRequestNumber}/reviews`;
  const requestBody: {
    event: PullRequestReviewEvent;
    body?: string;
    comments?: GiteaInlineReviewComment[];
  } = {
    event: review.event,
    ...(review.body === undefined ? {} : { body: review.body }),
    ...(review.comments === undefined
      ? {}
      : {
          comments: review.comments.map((comment) => comment.side === "RIGHT"
            ? { path: comment.path, body: comment.body, new_position: comment.line }
            : { path: comment.path, body: comment.body, old_position: comment.line })
        })
  };

  try {
    const response = await fetch(requestUrl, {
      method: "POST",
      headers: {
        Authorization: `token ${tokenResult.token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(requestBody)
    });

    if (response.status === 401 || response.status === 403) {
      return {
        error: {
          exitCode: 1,
          stdout: "",
          stderr: `Authentication failed while reviewing pull request #${pullRequestNumber} on ${repository.hostname}.\n`
        }
      };
    }

    if (response.status === 404) {
      return {
        error: {
          exitCode: 1,
          stdout: "",
          stderr: `Pull request #${pullRequestNumber} was not found in ${repository.owner}/${repository.repository}.\n`
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
            ? `Validation failed while reviewing pull request #${pullRequestNumber} in ${repository.owner}/${repository.repository}.\n`
            : `Validation failed while reviewing pull request #${pullRequestNumber} in ${repository.owner}/${repository.repository}: ${validationMessage}\n`
        }
      };
    }

    if (!response.ok) {
      return {
        error: {
          exitCode: 1,
          stdout: "",
          stderr: `Gitea returned ${response.status} while reviewing pull request #${pullRequestNumber} in ${repository.owner}/${repository.repository}.\n`
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
        stderr: `Failed to review pull request #${pullRequestNumber} on ${repository.hostname}: ${message}\n`
      }
    };
  }
}

async function mergePullRequest(
  repository: RepositoryContext,
  pullRequestNumber: number,
  mergeOptions: {
    method: PullRequestMergeMethod;
    body?: string;
    subject?: string;
    deleteBranch?: boolean;
    admin?: boolean;
    matchHeadCommit?: string;
  },
  context: ResolvedCliExecutionContext
): Promise<{ error?: CliResult }> {
  const tokenResult = resolveRequiredPullRequestToken(repository.hostname, context, "merge");

  if ("error" in tokenResult) {
    return { error: tokenResult.error };
  }

  const requestUrl = `${buildHostBaseUrl(repository.hostname)}/api/v1/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repository)}/pulls/${pullRequestNumber}/merge`;
  const requestBody: Record<string, boolean | string> = {
    do: mergeOptions.method
  };

  if (mergeOptions.deleteBranch === true) {
    requestBody.delete_branch_after_merge = true;
  }

  if (mergeOptions.admin === true) {
    requestBody.force_merge = true;
  }

  if (mergeOptions.matchHeadCommit !== undefined) {
    requestBody.head_commit_id = mergeOptions.matchHeadCommit;
  }

  if (mergeOptions.subject !== undefined) {
    requestBody.merge_title_field = mergeOptions.subject;
  }

  if (mergeOptions.body !== undefined) {
    requestBody.merge_message_field = mergeOptions.body;
  }

  try {
    const response = await fetch(requestUrl, {
      method: "POST",
      headers: {
        Authorization: `token ${tokenResult.token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(requestBody)
    });

    if (response.status === 401 || response.status === 403) {
      return {
        error: {
          exitCode: 1,
          stdout: "",
          stderr: `Authentication failed while merging pull request #${pullRequestNumber} on ${repository.hostname}.\n`
        }
      };
    }

    if (response.status === 404) {
      return {
        error: {
          exitCode: 1,
          stdout: "",
          stderr: `Pull request #${pullRequestNumber} was not found in ${repository.owner}/${repository.repository}.\n`
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
            ? `Validation failed while merging pull request #${pullRequestNumber} in ${repository.owner}/${repository.repository}.\n`
            : `Validation failed while merging pull request #${pullRequestNumber} in ${repository.owner}/${repository.repository}: ${validationMessage}\n`
        }
      };
    }

    if (response.status === 405 || response.status === 409) {
      const mergeBlockMessage = await readGiteaErrorMessage(response);

      return {
        error: {
          exitCode: 1,
          stdout: "",
          stderr: mergeBlockMessage === undefined
            ? `Merge blocked for pull request #${pullRequestNumber} in ${repository.owner}/${repository.repository}.\n`
            : `Merge blocked for pull request #${pullRequestNumber} in ${repository.owner}/${repository.repository}: ${mergeBlockMessage}\n`
        }
      };
    }

    if (!response.ok) {
      return {
        error: {
          exitCode: 1,
          stdout: "",
          stderr: `Gitea returned ${response.status} while merging pull request #${pullRequestNumber} in ${repository.owner}/${repository.repository}.\n`
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
        stderr: `Failed to merge pull request #${pullRequestNumber} on ${repository.hostname}: ${message}\n`
      }
    };
  }
}

async function readPullRequest(
  repository: RepositoryContext,
  pullRequestNumber: number,
  context: ResolvedCliExecutionContext
): Promise<{ pullRequest?: PullRequestRecord; error?: CliResult }> {
  const requestUrl = `${buildHostBaseUrl(repository.hostname)}/api/v1/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repository)}/pulls/${pullRequestNumber}`;
  const tokenResult = resolveOptionalTokenResult(repository.hostname, context);
  const headers = buildAuthorizationHeaders(tokenResult.token);

  try {
    const response = await fetch(requestUrl, headers === undefined ? undefined : { headers });

    if (response.status === 404) {
      return {
        error: preferOptionalTokenError(tokenResult, {
          exitCode: 1,
          stdout: "",
          stderr: `Pull request #${pullRequestNumber} was not found in ${repository.owner}/${repository.repository}.\n`
        })
      };
    }

    if (!response.ok) {
      return {
        error: preferOptionalTokenError(tokenResult, {
          exitCode: 1,
          stdout: "",
          stderr: `Gitea returned ${response.status} while reading pull request #${pullRequestNumber}.\n`
        })
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

async function readAllPullRequestCommentPayloads<T>(
  requestUrl: string,
  tokenResult: ReturnType<typeof resolveOptionalTokenResult>,
  requestOptions: RequestInit | undefined,
  pullRequestNumber: number,
  kind: string
): Promise<{ payload?: T[]; error?: CliResult }> {
  const payload: T[] = [];
  let page = 1;
  let totalCount: number | undefined;

  while (totalCount === undefined || payload.length < totalCount) {
    const pageUrl = page === 1 ? requestUrl : `${requestUrl}${requestUrl.includes("?") ? "&" : "?"}page=${page}`;
    const response = await fetch(pageUrl, requestOptions);

    if (!response.ok) {
      return {
        error: preferOptionalTokenError(tokenResult, {
          exitCode: 1,
          stdout: "",
          stderr: `Gitea returned ${response.status} while reading ${kind} for pull request #${pullRequestNumber}.\n`
        })
      };
    }

    const pagePayload = await response.json() as T[];

    if (!Array.isArray(pagePayload)) {
      return {
        error: {
          exitCode: 1,
          stdout: "",
          stderr: `Gitea returned an invalid ${kind} payload while reading pull request #${pullRequestNumber}.\n`
        }
      };
    }

    payload.push(...pagePayload);

    if (page === 1) {
      const rawTotalCount = response.headers.get("x-total-count");

      if (rawTotalCount !== null && /^\d+$/.test(rawTotalCount)) {
        totalCount = Number.parseInt(rawTotalCount, 10);
      }
    }

    if (totalCount === undefined || pagePayload.length === 0) {
      break;
    }

    page += 1;
  }

  return { payload };
}

async function readPullRequestComments(
  repository: RepositoryContext,
  pullRequestNumber: number,
  context: ResolvedCliExecutionContext
): Promise<{ comments?: PullRequestCommentRecord[]; error?: CliResult }> {
  const apiUrl = `${buildHostBaseUrl(repository.hostname)}/api/v1/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repository)}`;
  const pullRequestUrl = `${apiUrl}/pulls/${pullRequestNumber}`;
  const tokenResult = resolveOptionalTokenResult(repository.hostname, context);
  const headers = buildAuthorizationHeaders(tokenResult.token);
  const requestOptions = headers === undefined ? undefined : { headers };

  try {
    const standardCommentResult = await readAllPullRequestCommentPayloads<GiteaPullRequestCommentPayload>(
      `${apiUrl}/issues/${pullRequestNumber}/comments`,
      tokenResult,
      requestOptions,
      pullRequestNumber,
      "comments"
    );

    if (standardCommentResult.error !== undefined || standardCommentResult.payload === undefined) {
      return {
        error: standardCommentResult.error ?? {
          exitCode: 1,
          stdout: "",
          stderr: `Failed to read comments for pull request #${pullRequestNumber}.\n`
        }
      };
    }

    const reviewResult = await readAllPullRequestCommentPayloads<GiteaPullRequestReviewPayload>(
      `${pullRequestUrl}/reviews`,
      tokenResult,
      requestOptions,
      pullRequestNumber,
      "reviews"
    );

    if (reviewResult.error !== undefined || reviewResult.payload === undefined) {
      return {
        error: reviewResult.error ?? {
          exitCode: 1,
          stdout: "",
          stderr: `Failed to read reviews for pull request #${pullRequestNumber}.\n`
        }
      };
    }

    const comments = standardCommentResult.payload.map((comment) => mapPullRequestCommentRecord(comment));

    for (const review of reviewResult.payload) {
      if (typeof review.body === "string" && review.body.length > 0) {
        comments.push(
          mapPullRequestCommentRecord(
            {
              ...(review.id === undefined ? {} : { id: review.id }),
              body: review.body,
              ...(review.user === undefined ? {} : { user: review.user })
            },
            review.submitted_at
          )
        );
      }

      if (typeof review.id !== "number") {
        continue;
      }

      const reviewCommentResult = await readAllPullRequestCommentPayloads<GiteaPullRequestCommentPayload>(
        `${pullRequestUrl}/reviews/${review.id}/comments`,
        tokenResult,
        requestOptions,
        pullRequestNumber,
        "review comments"
      );

      if (reviewCommentResult.error !== undefined || reviewCommentResult.payload === undefined) {
        return {
          error: reviewCommentResult.error ?? {
            exitCode: 1,
            stdout: "",
            stderr: `Failed to read review comments for pull request #${pullRequestNumber}.\n`
          }
        };
      }

      comments.push(...reviewCommentResult.payload.map((comment) => mapPullRequestCommentRecord(comment)));
    }

    comments.sort((left, right) => {
      const leftTime = left.createdAt === null ? 0 : Date.parse(left.createdAt);
      const rightTime = right.createdAt === null ? 0 : Date.parse(right.createdAt);

      return (Number.isNaN(leftTime) ? 0 : leftTime) - (Number.isNaN(rightTime) ? 0 : rightTime);
    });

    return { comments };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return {
      error: {
        exitCode: 1,
        stdout: "",
        stderr: `Failed to read comments for pull request #${pullRequestNumber} from ${repository.hostname}: ${message}\n`
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
  const tokenResult = resolveOptionalTokenResult(repository.hostname, context);
  const headers = buildAuthorizationHeaders(tokenResult.token);

  try {
    const response = await fetch(requestUrl, headers === undefined ? undefined : { headers });

    if (response.status === 404) {
      return {
        error: preferOptionalTokenError(tokenResult, {
          exitCode: 1,
          stdout: "",
          stderr: `Pull request #${pullRequestNumber} was not found in ${repository.owner}/${repository.repository}.\n`
        })
      };
    }

    if (!response.ok) {
      return {
        error: preferOptionalTokenError(tokenResult, {
          exitCode: 1,
          stdout: "",
          stderr: `Gitea returned ${response.status} while reading pull request diff #${pullRequestNumber}.\n`
        })
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
  const tokenResult = resolveOptionalTokenResult(repository.hostname, context);
  const headers = buildAuthorizationHeaders(tokenResult.token);

  try {
    const response = await fetch(requestUrl, headers === undefined ? undefined : { headers });

    if (!response.ok) {
      return {
        error: preferOptionalTokenError(tokenResult, {
          exitCode: 1,
          stdout: "",
          stderr: `Gitea returned ${response.status} while reading pull requests for ${repository.owner}/${repository.repository}.\n`
        })
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
  const tokenResult = resolveRequiredPullRequestToken(hostname, context, "status");

  if ("error" in tokenResult) {
    return { error: tokenResult.error };
  }

  try {
    const response = await fetch(`${buildHostBaseUrl(hostname)}/api/v1/user`, {
      headers: {
        Authorization: `token ${tokenResult.token}`
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

function renderPullRequest(pullRequest: PullRequestRecord, options?: { showAllComments?: boolean }): string {
  const lines = [
    `${pullRequest.title} (#${pullRequest.number})`,
    `State: ${pullRequest.state}`,
    `Head: ${pullRequest.headRefName}`,
    `Base: ${pullRequest.baseRefName}`,
    `URL: ${pullRequest.url}`
  ];

  if (pullRequest.body !== undefined && pullRequest.body.length > 0) {
    lines.push("", pullRequest.body);
  }

  if (pullRequest.comments !== undefined && pullRequest.comments.length === 0) {
    lines.push("", "No comments.");
  }

  if (pullRequest.comments !== undefined && pullRequest.comments.length > 0) {
    if (options?.showAllComments === true) {
      for (const comment of pullRequest.comments) {
        lines.push(
          "",
          comment.author?.login === null || comment.author?.login === undefined
            ? "Comment"
            : `${comment.author.login} • Comment`,
          "",
          comment.body
        );
      }
    } else {
      const newestComment = pullRequest.comments[pullRequest.comments.length - 1]!;
      const hiddenCommentCount = Math.max((pullRequest.commentCount ?? pullRequest.comments.length) - 1, 0);

      if (hiddenCommentCount > 0) {
        lines.push("", `-------- Not showing ${hiddenCommentCount} comment${hiddenCommentCount === 1 ? "" : "s"} --------`);
      }

      lines.push(
        "",
        newestComment.author?.login === null || newestComment.author?.login === undefined
          ? "Newest comment"
          : `${newestComment.author.login} • Newest comment`,
        "",
        newestComment.body
      );
    }
  }

  return `${lines.join("\n")}\n`;
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

/** @author S.Wienand */
export async function executePrCommand(args: string[], context: ResolvedCliExecutionContext): Promise<CliResult | undefined> {
  if (
    args[0] !== "pr"
    || (args[1] !== "view" && args[1] !== "list" && args[1] !== "status" && args[1] !== "diff" && args[1] !== "checkout" && args[1] !== "create" && args[1] !== "comment" && args[1] !== "review" && args[1] !== "merge")
  ) {
    return undefined;
  }

  const subcommand = args[1];

  if (subcommand === "create") {
    const parsedCreateFlags = parsePullRequestCreateFlags(args.slice(2));

    if (parsedCreateFlags.error !== undefined) {
      return parsedCreateFlags.error;
    }

    const bodyInputResult = resolvePullRequestBodyInput(parsedCreateFlags.flags, context);

    if (bodyInputResult.error !== undefined) {
      return bodyInputResult.error;
    }

    if (parsedCreateFlags.flags.title === undefined) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: "--title is required.\n"
      };
    }

    if (parsedCreateFlags.flags.base === undefined) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: "--base is required.\n"
      };
    }

    if (parsedCreateFlags.flags.head === undefined) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: "--head is required.\n"
      };
    }

    const repositoryResult = resolveRepositoryCommandTarget(parsedCreateFlags.flags.repository, { mode: "none" }, context);

    if (repositoryResult.error !== undefined || repositoryResult.target === undefined) {
      return repositoryResult.error ?? {
        exitCode: 1,
        stdout: "",
        stderr: "No Repository Context selected.\n"
      };
    }

    const createResult = await createPullRequest(
      repositoryResult.target.repository,
      {
        title: parsedCreateFlags.flags.title,
        base: parsedCreateFlags.flags.base,
        head: parsedCreateFlags.flags.head,
        ...(bodyInputResult.body === undefined ? {} : { body: bodyInputResult.body })
      },
      context
    );

    if (createResult.error !== undefined || createResult.pullRequest === undefined) {
      return createResult.error ?? {
        exitCode: 1,
        stdout: "",
        stderr: "Failed to create pull request.\n"
      };
    }

    return {
      exitCode: 0,
      stdout: `${createResult.pullRequest.url}\n`,
      stderr: ""
    };
  }

  if (subcommand === "comment") {
    const parsedCommentFlags = parsePullRequestCommentFlags(args.slice(2));

    if (parsedCommentFlags.error !== undefined) {
      return parsedCommentFlags.error;
    }

    const bodyInputResult = resolvePullRequestBodyInput(parsedCommentFlags.flags, context);

    if (bodyInputResult.error !== undefined) {
      return bodyInputResult.error;
    }

    if (parsedCommentFlags.flags.pullRequestNumber === undefined) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: "Pull request number is required.\n"
      };
    }

    if (bodyInputResult.body === undefined) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: "--body is required.\n"
      };
    }

    const repositoryResult = resolveRepositoryCommandTarget(parsedCommentFlags.flags.repository, { mode: "none" }, context);

    if (repositoryResult.error !== undefined || repositoryResult.target === undefined) {
      return repositoryResult.error ?? {
        exitCode: 1,
        stdout: "",
        stderr: "No Repository Context selected.\n"
      };
    }

    const commentResult = await commentOnPullRequest(
      repositoryResult.target.repository,
      parsedCommentFlags.flags.pullRequestNumber,
      bodyInputResult.body,
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

  if (subcommand === "review") {
    const parsedReviewFlags = parsePullRequestReviewFlags(args.slice(2));

    if (parsedReviewFlags.error !== undefined) {
      return parsedReviewFlags.error;
    }

    if (parsedReviewFlags.flags.bodyFile === "-" && parsedReviewFlags.flags.inlineCommentsFile === "-") {
      return {
        exitCode: 1,
        stdout: "",
        stderr: "Specify standard input for only one of --body-file or --inline-comments-file.\n"
      };
    }

    const bodyInputResult = resolvePullRequestBodyInput(parsedReviewFlags.flags, context);

    if (bodyInputResult.error !== undefined) {
      return bodyInputResult.error;
    }

    const inlineCommentsResult = resolveInlineReviewCommentInput(
      parsedReviewFlags.flags.inlineCommentsFile,
      context
    );

    if (inlineCommentsResult.error !== undefined) {
      return inlineCommentsResult.error;
    }

    if (parsedReviewFlags.flags.pullRequestNumber === undefined) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: "Pull request number is required.\n"
      };
    }

    if (parsedReviewFlags.flags.event === undefined && inlineCommentsResult.comments === undefined) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: "Specify one of --approve, --comment, or --request-changes.\n"
      };
    }

    const repositoryResult = resolveRepositoryCommandTarget(parsedReviewFlags.flags.repository, { mode: "none" }, context);

    if (repositoryResult.error !== undefined || repositoryResult.target === undefined) {
      return repositoryResult.error ?? {
        exitCode: 1,
        stdout: "",
        stderr: "No Repository Context selected.\n"
      };
    }

    const reviewResult = await reviewPullRequest(
      repositoryResult.target.repository,
      parsedReviewFlags.flags.pullRequestNumber,
      {
        event: parsedReviewFlags.flags.event ?? "COMMENT",
        ...(bodyInputResult.body === undefined ? {} : { body: bodyInputResult.body }),
        ...(inlineCommentsResult.comments === undefined ? {} : { comments: inlineCommentsResult.comments })
      },
      context
    );

    if (reviewResult.error !== undefined) {
      return reviewResult.error;
    }

    return {
      exitCode: 0,
      stdout: "",
      stderr: ""
    };
  }

  if (subcommand === "merge") {
    const parsedMergeFlags = parsePullRequestMergeFlags(args.slice(2));

    if (parsedMergeFlags.error !== undefined) {
      return parsedMergeFlags.error;
    }

    const bodyInputResult = resolvePullRequestBodyInput(parsedMergeFlags.flags, context);

    if (bodyInputResult.error !== undefined) {
      return bodyInputResult.error;
    }

    if (parsedMergeFlags.flags.pullRequestNumber === undefined) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: "Pull request number is required.\n"
      };
    }

    const repositoryResult = resolveRepositoryCommandTarget(parsedMergeFlags.flags.repository, { mode: "none" }, context);

    if (repositoryResult.error !== undefined || repositoryResult.target === undefined) {
      return repositoryResult.error ?? {
        exitCode: 1,
        stdout: "",
        stderr: "No Repository Context selected.\n"
      };
    }

    const mergeResult = await mergePullRequest(
      repositoryResult.target.repository,
      parsedMergeFlags.flags.pullRequestNumber,
      {
        method: parsedMergeFlags.flags.method ?? "merge",
        ...(bodyInputResult.body === undefined ? {} : { body: bodyInputResult.body }),
        ...(parsedMergeFlags.flags.subject === undefined ? {} : { subject: parsedMergeFlags.flags.subject }),
        ...(parsedMergeFlags.flags.deleteBranch === undefined ? {} : { deleteBranch: parsedMergeFlags.flags.deleteBranch }),
        ...(parsedMergeFlags.flags.admin === undefined ? {} : { admin: parsedMergeFlags.flags.admin }),
        ...(parsedMergeFlags.flags.matchHeadCommit === undefined
          ? {}
          : { matchHeadCommit: parsedMergeFlags.flags.matchHeadCommit })
      },
      context
    );

    if (mergeResult.error !== undefined) {
      return mergeResult.error;
    }

    return {
      exitCode: 0,
      stdout: "",
      stderr: ""
    };
  }

  const parsedFlags = parsePullRequestFlags(args.slice(2));

  if (parsedFlags.error !== undefined) {
    return parsedFlags.error;
  }

  if (parsedFlags.flags.showComments === true && subcommand !== "view") {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "--comments is only supported with pr view.\n"
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

  const repositoryResult = resolveRepositoryCommandTarget(parsedFlags.flags.repository, { mode: "none" }, context);

  if (repositoryResult.error !== undefined || repositoryResult.target === undefined) {
    return repositoryResult.error ?? {
      exitCode: 1,
      stdout: "",
      stderr: "No Repository Context selected.\n"
    };
  }

  if (subcommand === "list") {
    const pullRequestListResult = await readPullRequestList(repositoryResult.target.repository, context);

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
    const currentUserResult = await readCurrentUser(repositoryResult.target.repository.hostname, context);

    if (currentUserResult.error !== undefined || currentUserResult.login === undefined) {
      return currentUserResult.error ?? {
        exitCode: 1,
        stdout: "",
        stderr: "Failed to resolve the current user.\n"
      };
    }

    const pullRequestListResult = await readPullRequestList(repositoryResult.target.repository, context);

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
        repositoryResult.target.repository,
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
      repositoryResult.target.repository,
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
    repositoryResult.target.repository,
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

  if (
    subcommand === "view"
    && (parsedFlags.flags.jsonFields === undefined
      || parsedFlags.flags.jsonFields.includes("comments")
      || parsedFlags.flags.jsonFields.includes("commentCount"))
  ) {
    const commentResult = await readPullRequestComments(
      repositoryResult.target.repository,
      pullRequestNumber,
      context
    );

    if (commentResult.error !== undefined || commentResult.comments === undefined) {
      return commentResult.error ?? {
        exitCode: 1,
        stdout: "",
        stderr: "Failed to read pull request comments.\n"
      };
    }

    pullRequestResult.pullRequest = {
      ...pullRequestResult.pullRequest,
      comments: commentResult.comments,
      commentCount: commentResult.comments.length
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
    stdout: renderPullRequest(pullRequestResult.pullRequest, { showAllComments: parsedFlags.flags.showComments === true }),
    stderr: ""
  };
}
