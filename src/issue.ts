import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

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
  assignee?: string;
  author?: string;
  labels?: string[];
  limit?: number;
  mention?: string;
  milestone?: string;
  search?: string;
  state?: IssueListState;
}

type IssueListState = "open" | "closed" | "all";

interface IssueListQueryOptions {
  assignee?: string;
  author?: string;
  labels: string[];
  limit?: number;
  mention?: string;
  milestone?: string;
  search?: string;
  state: IssueListState;
}

interface ParsedIssueCreateFlags {
  repository?: string;
  title?: string;
  body?: string;
  bodyFile?: string;
  addLabels: string[];
  removeLabels: string[];
  addAssignees: string[];
  removeAssignees: string[];
  milestone?: string;
  removeMilestone?: boolean;
}

interface ParsedIssueMutationFlags {
  issueNumber?: number;
  issueNumbers: number[];
  repository?: string;
  title?: string;
  body?: string;
  bodyFile?: string;
  addLabels: string[];
  removeLabels: string[];
  addAssignees: string[];
  removeAssignees: string[];
  milestone?: string;
  removeMilestone?: boolean;
}

type IssueMutationCommandName = "create" | "edit";

function issueMutationActionLabel(commandName: IssueMutationCommandName): "creating" | "editing" {
  return commandName === "create" ? "creating" : "editing";
}

interface IssueRecord {
  number: number;
  title: string;
  state: string;
  url: string;
  assignees: IssueUserRecord[];
  labels: IssueLabelRecord[];
  closed: boolean;
  isPinned: boolean;
  body?: string;
  id?: number;
  author?: IssueUserRecord | null;
  authorLogin?: string;
  labelNames?: string[];
  commentCount?: number;
  comments?: number | IssueCommentRecord[];
  milestone?: IssueMilestoneRecord | null;
  createdAt?: string;
  updatedAt?: string;
  closedAt?: string;
}

interface IssueUserRecord extends StructuredObject {
  id: number | null;
  login: string | null;
  name: string | null;
}

interface IssueLabelRecord extends StructuredObject {
  id: number | null;
  name: string | null;
  description: string | null;
  color: string | null;
}

interface IssueMilestoneRecord extends StructuredObject {
  id: number | null;
  title: string | null;
  description: string | null;
  state: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  closedAt: string | null;
}

interface IssueCommentRecord extends StructuredObject {
  id: number | null;
  author: IssueUserRecord | null;
  body: string;
  createdAt: string | null;
  updatedAt: string | null;
  url: string | null;
  authorLogin?: string;
}

interface GiteaUserPayload {
  id?: number;
  login?: string;
  full_name?: string;
}

interface GiteaLabelPayload {
  id?: number;
  name?: string;
  description?: string;
  color?: string;
}

interface GiteaMilestonePayload {
  id?: number;
  title?: string;
  description?: string;
  state?: string;
  created_at?: string;
  updated_at?: string;
  closed_at?: string | null;
}

interface GiteaIssuePayload {
  id?: number;
  number?: number;
  title?: string;
  state?: string;
  body?: string;
  comments?: number;
  created_at?: string;
  updated_at?: string;
  closed_at?: string | null;
  pin_order?: number;
  assignee?: GiteaUserPayload | null;
  assignees?: Array<GiteaUserPayload | null> | null;
  user?: GiteaUserPayload | null;
  labels?: Array<GiteaLabelPayload | null> | null;
  milestone?: GiteaMilestonePayload | null;
}

interface GiteaIssueCommentPayload {
  id?: number;
  body?: string;
  created_at?: string;
  updated_at?: string;
  html_url?: string;
  user?: GiteaUserPayload | null;
}

interface IssueUpdatePayload {
  title?: string;
  body?: string;
  state?: "open" | "closed";
  assignees?: string[];
  milestone?: number;
}

const issueGroup = supportManifest.children.find(
  (node): node is ManifestGroup => node.kind === "group" && node.name === "issue"
);
const issueCommands = new Map(
  (issueGroup?.children ?? [])
    .filter((node): node is ManifestCommand => node.kind === "command")
    .map((node) => [node.name, node] as const)
);

function collectSupportedIssueOutputFields(commandName: string): Set<string> {
  return new Set(
    (issueCommands.get(commandName)?.outputFields ?? [])
      .filter((field) => field.status !== "unsupported")
      .map((field) => field.name)
  );
}

const issueListOutputFields = collectSupportedIssueOutputFields("list");
const issueStatusOutputFields = collectSupportedIssueOutputFields("status");
const issueViewOutputFields = collectSupportedIssueOutputFields("view");

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

function parseCsvValues(rawValue: string): string[] {
  return rawValue
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function parsePositiveIntegerFlagValue(flag: string, rawValue: string): { value?: number; error?: CliResult } {
  if (!/^\d+$/.test(rawValue)) {
    return {
      error: {
        exitCode: 1,
        stdout: "",
        stderr: `Invalid value for ${flag}: ${rawValue}. Expected a positive integer.\n`
      }
    };
  }

  const value = Number.parseInt(rawValue, 10);

  if (!Number.isSafeInteger(value) || value <= 0) {
    return {
      error: {
        exitCode: 1,
        stdout: "",
        stderr: `Invalid value for ${flag}: ${rawValue}. Expected a positive integer.\n`
      }
    };
  }

  return { value };
}

function parseIssueState(rawValue: string): { state?: IssueListState; error?: CliResult } {
  if (rawValue === "open" || rawValue === "closed" || rawValue === "all") {
    return { state: rawValue };
  }

  return {
    error: {
      exitCode: 1,
      stdout: "",
      stderr: `Invalid value for --state: ${rawValue}. Expected one of: open, closed, all.\n`
    }
  };
}

function parseIssueFlags(
  args: string[],
  subcommand: "view" | "list" | "status"
): { flags: ParsedIssueFlags; error?: CliResult } {
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

    if (subcommand === "list") {
      if (token === "--app" || token.startsWith("--app=")) {
        return {
          flags,
          error: renderUnsupportedIssueFlag(
            "list",
            "--app",
            "Gitea repository issue lists do not expose a GitHub App author filter."
          )
        };
      }

      if (token === "--web" || token === "-w") {
        return {
          flags,
          error: renderUnsupportedIssueFlag(
            "list",
            "--web",
            "Browser issue listings with gh-compatible filter propagation are not part of the supported issue list slice."
          )
        };
      }

      const assigneeFlag = parseStringFlagValue(args, index, { long: "--assignee", short: "-a" });

      if (assigneeFlag.error !== undefined) {
        return {
          flags,
          error: assigneeFlag.error
        };
      }

      if (assigneeFlag.handled && assigneeFlag.value !== undefined) {
        flags.assignee = assigneeFlag.value;
        index = assigneeFlag.nextIndex;
        continue;
      }

      const authorFlag = parseStringFlagValue(args, index, { long: "--author", short: "-A" });

      if (authorFlag.error !== undefined) {
        return {
          flags,
          error: authorFlag.error
        };
      }

      if (authorFlag.handled && authorFlag.value !== undefined) {
        flags.author = authorFlag.value;
        index = authorFlag.nextIndex;
        continue;
      }

      const labelFlag = parseStringFlagValue(args, index, { long: "--label", short: "-l" });

      if (labelFlag.error !== undefined) {
        return {
          flags,
          error: labelFlag.error
        };
      }

      if (labelFlag.handled && labelFlag.value !== undefined) {
        flags.labels = [...(flags.labels ?? []), ...parseCsvValues(labelFlag.value)];
        index = labelFlag.nextIndex;
        continue;
      }

      const limitFlag = parseStringFlagValue(args, index, { long: "--limit", short: "-L" });

      if (limitFlag.error !== undefined) {
        return {
          flags,
          error: limitFlag.error
        };
      }

      if (limitFlag.handled && limitFlag.value !== undefined) {
        const parsedLimit = parsePositiveIntegerFlagValue("--limit", limitFlag.value);

        if (parsedLimit.error !== undefined) {
          return {
            flags,
            error: parsedLimit.error
          };
        }

        if (parsedLimit.value !== undefined) {
          flags.limit = parsedLimit.value;
        }

        index = limitFlag.nextIndex;
        continue;
      }

      const mentionFlag = parseStringFlagValue(args, index, { long: "--mention" });

      if (mentionFlag.error !== undefined) {
        return {
          flags,
          error: mentionFlag.error
        };
      }

      if (mentionFlag.handled && mentionFlag.value !== undefined) {
        flags.mention = mentionFlag.value;
        index = mentionFlag.nextIndex;
        continue;
      }

      const milestoneFlag = parseStringFlagValue(args, index, { long: "--milestone", short: "-m" });

      if (milestoneFlag.error !== undefined) {
        return {
          flags,
          error: milestoneFlag.error
        };
      }

      if (milestoneFlag.handled && milestoneFlag.value !== undefined) {
        flags.milestone = milestoneFlag.value;
        index = milestoneFlag.nextIndex;
        continue;
      }

      const searchFlag = parseStringFlagValue(args, index, { long: "--search", short: "-S" });

      if (searchFlag.error !== undefined) {
        return {
          flags,
          error: searchFlag.error
        };
      }

      if (searchFlag.handled && searchFlag.value !== undefined) {
        flags.search = searchFlag.value;
        index = searchFlag.nextIndex;
        continue;
      }

      const stateFlag = parseStringFlagValue(args, index, { long: "--state", short: "-s" });

      if (stateFlag.error !== undefined) {
        return {
          flags,
          error: stateFlag.error
        };
      }

      if (stateFlag.handled && stateFlag.value !== undefined) {
        const parsedState = parseIssueState(stateFlag.value);

        if (parsedState.error !== undefined) {
          return {
            flags,
            error: parsedState.error
          };
        }

        if (parsedState.state !== undefined) {
          flags.state = parsedState.state;
        }

        index = stateFlag.nextIndex;
        continue;
      }
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
  const flags: ParsedIssueCreateFlags = {
    addLabels: [],
    removeLabels: [],
    addAssignees: [],
    removeAssignees: []
  };

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

    if (token === "--editor" || token === "-e") {
      return {
        flags,
        error: renderUnsupportedIssueFlag(
          "create",
          "--editor",
          "Interactive editor-driven issue drafting is not part of the supported issue create slice."
        )
      };
    }

    if (token === "--web" || token === "-w") {
      return {
        flags,
        error: renderUnsupportedIssueFlag(
          "create",
          "--web",
          "Browser-driven issue creation is not part of the supported issue create slice."
        )
      };
    }

    const projectFlag = parseStringFlagValue(args, index, { long: "--project", short: "-p" });

    if (projectFlag.error !== undefined) {
      return {
        flags,
        error: projectFlag.error
      };
    }

    if (projectFlag.handled) {
      return {
        flags,
        error: renderUnsupportedIssueFlag(
          "create",
          "--project",
          "Project assignment during issue creation is not part of the supported issue create slice."
        )
      };
    }

    const templateFlag = parseStringFlagValue(args, index, { long: "--template", short: "-T" });

    if (templateFlag.error !== undefined) {
      return {
        flags,
        error: templateFlag.error
      };
    }

    if (templateFlag.handled) {
      return {
        flags,
        error: renderUnsupportedIssueFlag(
          "create",
          "--template",
          "Issue template expansion is not part of the supported issue create slice."
        )
      };
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

    const labelFlag = parseStringFlagValue(args, index, { long: "--label", short: "-l" });

    if (labelFlag.error !== undefined) {
      return {
        flags,
        error: labelFlag.error
      };
    }

    if (labelFlag.handled && labelFlag.value !== undefined) {
      flags.addLabels.push(...parseCsvValues(labelFlag.value));
      index = labelFlag.nextIndex;
      continue;
    }

    const assigneeFlag = parseStringFlagValue(args, index, { long: "--assignee", short: "-a" });

    if (assigneeFlag.error !== undefined) {
      return {
        flags,
        error: assigneeFlag.error
      };
    }

    if (assigneeFlag.handled && assigneeFlag.value !== undefined) {
      const assigneeValues = parseCsvValues(assigneeFlag.value);

      if (assigneeValues.includes("@copilot")) {
        return {
          flags,
          error: renderUnsupportedIssueFlag(
            "create",
            "--assignee",
            "Copilot assignee aliases are not supported on Gitea hosts."
          )
        };
      }

      flags.addAssignees.push(...assigneeValues);
      index = assigneeFlag.nextIndex;
      continue;
    }

    const milestoneFlag = parseStringFlagValue(args, index, { long: "--milestone", short: "-m" });

    if (milestoneFlag.error !== undefined) {
      return {
        flags,
        error: milestoneFlag.error
      };
    }

    if (milestoneFlag.handled && milestoneFlag.value !== undefined) {
      flags.milestone = milestoneFlag.value;
      index = milestoneFlag.nextIndex;
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
  options: { allowTitle: boolean; allowBody: boolean; allowBodyFile: boolean; allowMultipleIssueNumbers?: boolean }
): { flags: ParsedIssueMutationFlags; error?: CliResult } {
  const flags: ParsedIssueMutationFlags = {
    issueNumbers: [],
    addLabels: [],
    removeLabels: [],
    addAssignees: [],
    removeAssignees: []
  };

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

    const bodyFileFlag = options.allowBodyFile
      ? parseStringFlagValue(args, index, { long: "--body-file", allowDashValue: true })
      : { handled: false, nextIndex: index };

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

    const addLabelFlag = parseStringFlagValue(args, index, { long: "--add-label" });

    if (addLabelFlag.error !== undefined) {
      return {
        flags,
        error: addLabelFlag.error
      };
    }

    if (addLabelFlag.handled && addLabelFlag.value !== undefined) {
      flags.addLabels.push(...parseCsvValues(addLabelFlag.value));
      index = addLabelFlag.nextIndex;
      continue;
    }

    const removeLabelFlag = parseStringFlagValue(args, index, { long: "--remove-label" });

    if (removeLabelFlag.error !== undefined) {
      return {
        flags,
        error: removeLabelFlag.error
      };
    }

    if (removeLabelFlag.handled && removeLabelFlag.value !== undefined) {
      flags.removeLabels.push(...parseCsvValues(removeLabelFlag.value));
      index = removeLabelFlag.nextIndex;
      continue;
    }

    const addAssigneeFlag = parseStringFlagValue(args, index, { long: "--add-assignee" });

    if (addAssigneeFlag.error !== undefined) {
      return {
        flags,
        error: addAssigneeFlag.error
      };
    }

    if (addAssigneeFlag.handled && addAssigneeFlag.value !== undefined) {
      const assigneeValues = parseCsvValues(addAssigneeFlag.value);

      if (assigneeValues.includes("@copilot")) {
        return {
          flags,
          error: renderUnsupportedIssueFlag(
            "edit",
            "--add-assignee",
            "Copilot assignee aliases are not supported on Gitea hosts."
          )
        };
      }

      flags.addAssignees.push(...assigneeValues);
      index = addAssigneeFlag.nextIndex;
      continue;
    }

    const removeAssigneeFlag = parseStringFlagValue(args, index, { long: "--remove-assignee" });

    if (removeAssigneeFlag.error !== undefined) {
      return {
        flags,
        error: removeAssigneeFlag.error
      };
    }

    if (removeAssigneeFlag.handled && removeAssigneeFlag.value !== undefined) {
      const assigneeValues = parseCsvValues(removeAssigneeFlag.value);

      if (assigneeValues.includes("@copilot")) {
        return {
          flags,
          error: renderUnsupportedIssueFlag(
            "edit",
            "--remove-assignee",
            "Copilot assignee aliases are not supported on Gitea hosts."
          )
        };
      }

      flags.removeAssignees.push(...assigneeValues);
      index = removeAssigneeFlag.nextIndex;
      continue;
    }

    const milestoneFlag = parseStringFlagValue(args, index, { long: "--milestone" });

    if (milestoneFlag.error !== undefined) {
      return {
        flags,
        error: milestoneFlag.error
      };
    }

    if (milestoneFlag.handled && milestoneFlag.value !== undefined) {
      flags.milestone = milestoneFlag.value;
      index = milestoneFlag.nextIndex;
      continue;
    }

    if (token === "--remove-milestone") {
      flags.removeMilestone = true;
      continue;
    }

    const addProjectFlag = parseStringFlagValue(args, index, { long: "--add-project" });

    if (addProjectFlag.error !== undefined) {
      return {
        flags,
        error: addProjectFlag.error
      };
    }

    if (addProjectFlag.handled) {
      return {
        flags,
        error: renderUnsupportedIssueFlag(
          "edit",
          "--add-project",
          "Project edits are not part of the supported issue maintenance slice."
        )
      };
    }

    const removeProjectFlag = parseStringFlagValue(args, index, { long: "--remove-project" });

    if (removeProjectFlag.error !== undefined) {
      return {
        flags,
        error: removeProjectFlag.error
      };
    }

    if (removeProjectFlag.handled) {
      return {
        flags,
        error: renderUnsupportedIssueFlag(
          "edit",
          "--remove-project",
          "Project edits are not part of the supported issue maintenance slice."
        )
      };
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

    if (flags.issueNumber !== undefined && options.allowMultipleIssueNumbers !== true) {
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

    const issueNumber = Number.parseInt(token, 10);

    if (flags.issueNumber === undefined) {
      flags.issueNumber = issueNumber;
    }

    flags.issueNumbers.push(issueNumber);
  }

  return { flags };
}

function resolveIssueBodyInput(
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
        stderr: `Failed to read issue body from ${flags.bodyFile}: ${message}\n`
      }
    };
  }
}

function hasIssueMetadataChanges(flags: ParsedIssueMutationFlags): boolean {
  return (
    flags.addLabels.length > 0
    || flags.removeLabels.length > 0
    || flags.addAssignees.length > 0
    || flags.removeAssignees.length > 0
    || flags.milestone !== undefined
    || flags.removeMilestone === true
  );
}

function buildIssueCreateMutationFlags(flags: ParsedIssueCreateFlags): ParsedIssueMutationFlags {
  return {
    issueNumbers: [],
    addLabels: [...flags.addLabels],
    removeLabels: [],
    addAssignees: [...flags.addAssignees],
    removeAssignees: [],
    ...(flags.milestone === undefined ? {} : { milestone: flags.milestone })
  };
}

function uniqueValues(values: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];

  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }

    seen.add(value);
    unique.push(value);
  }

  return unique;
}

function applyStringListMutations(currentValues: string[], addValues: string[], removeValues: string[]): string[] {
  const removeSet = new Set(removeValues);
  const nextValues = currentValues.filter((value) => !removeSet.has(value));

  for (const value of addValues) {
    if (!nextValues.includes(value)) {
      nextValues.push(value);
    }
  }

  return uniqueValues(nextValues);
}

function currentIssueAssignees(issue: GiteaIssuePayload): string[] {
  const assigneeLogins = [issue.assignee?.login, ...(issue.assignees ?? []).map((assignee) => assignee?.login)]
    .filter((login): login is string => typeof login === "string" && login.length > 0);

  return uniqueValues(assigneeLogins);
}

function currentIssueLabelNames(issue: GiteaIssuePayload): string[] {
  return uniqueValues(
    (issue.labels ?? [])
      .map((label) => label?.name)
      .filter((label): label is string => typeof label === "string" && label.length > 0)
  );
}

function resolveAssigneeAliases(values: string[], currentUserLogin: string | undefined): string[] {
  return uniqueValues(
    values.map((value) => {
      if (value === "@me") {
        return currentUserLogin ?? value;
      }

      return value;
    })
  );
}

function buildIssueUrl(repository: RepositoryContext, issueNumber: number): string {
  return `${buildHostBaseUrl(repository.hostname)}/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repository)}/issues/${issueNumber}`;
}

function isPlainObjectValue(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasIssueNumber(payload: unknown): payload is GiteaIssuePayload & { number: number } {
  return isPlainObjectValue(payload)
    && typeof payload.number === "number"
    && Number.isSafeInteger(payload.number)
    && payload.number > 0;
}

function mapIssueUserRecord(payload?: GiteaUserPayload | null): IssueUserRecord | null {
  if (payload === undefined || payload === null) {
    return null;
  }

  const id = typeof payload.id === "number" ? payload.id : null;
  const login = typeof payload.login === "string" ? payload.login : null;
  const name = typeof payload.full_name === "string" ? payload.full_name : null;

  if (id === null && login === null && name === null) {
    return null;
  }

  return {
    id,
    login,
    name
  };
}

function mapIssueLabelRecord(payload?: GiteaLabelPayload | null): IssueLabelRecord | null {
  if (payload === undefined || payload === null) {
    return null;
  }

  const id = typeof payload.id === "number" ? payload.id : null;
  const name = typeof payload.name === "string" ? payload.name : null;
  const description = typeof payload.description === "string" ? payload.description : null;
  const color = typeof payload.color === "string" ? payload.color : null;

  if (id === null && name === null && description === null && color === null) {
    return null;
  }

  return {
    id,
    name,
    description,
    color
  };
}

function mapIssueAssigneeRecords(payload: GiteaIssuePayload): IssueUserRecord[] {
  const seen = new Set<string>();
  const assignees: IssueUserRecord[] = [];

  for (const candidate of [payload.assignee, ...(payload.assignees ?? [])]) {
    const assignee = mapIssueUserRecord(candidate);

    if (assignee === null) {
      continue;
    }

    const assigneeKey = `${String(assignee.id)}:${String(assignee.login)}:${String(assignee.name)}`;

    if (seen.has(assigneeKey)) {
      continue;
    }

    seen.add(assigneeKey);
    assignees.push(assignee);
  }

  return assignees;
}

function mapIssueMilestoneRecord(payload?: GiteaMilestonePayload | null): IssueMilestoneRecord | null {
  if (payload === undefined || payload === null) {
    return null;
  }

  return {
    id: typeof payload.id === "number" ? payload.id : null,
    title: typeof payload.title === "string" ? payload.title : null,
    description: typeof payload.description === "string" ? payload.description : null,
    state: typeof payload.state === "string" ? payload.state : null,
    createdAt: typeof payload.created_at === "string" ? payload.created_at : null,
    updatedAt: typeof payload.updated_at === "string" ? payload.updated_at : null,
    closedAt: typeof payload.closed_at === "string" ? payload.closed_at : null
  };
}

function mapIssueCommentRecord(
  repository: RepositoryContext,
  issueNumber: number,
  payload: GiteaIssueCommentPayload | null
): IssueCommentRecord | null {
  if (payload === null) {
    return null;
  }

  const author = mapIssueUserRecord(payload.user);
  const commentId = typeof payload.id === "number" ? payload.id : null;

  return {
    id: commentId,
    author,
    body: typeof payload.body === "string" ? payload.body : "",
    createdAt: typeof payload.created_at === "string" ? payload.created_at : null,
    updatedAt: typeof payload.updated_at === "string" ? payload.updated_at : null,
    url: typeof payload.html_url === "string"
      ? payload.html_url
      : commentId === null
        ? null
        : `${buildIssueUrl(repository, issueNumber)}#issuecomment-${commentId}`
  };
}

function mapIssueRecord(repository: RepositoryContext, payload: GiteaIssuePayload, fallbackNumber: number): IssueRecord {
  const number = typeof payload.number === "number" ? payload.number : fallbackNumber;
  const id = typeof payload.id === "number" ? payload.id : undefined;
  const state = typeof payload.state === "string" ? payload.state : "unknown";
  const body = typeof payload.body === "string" ? payload.body : undefined;
  const author = mapIssueUserRecord(payload.user);
  const authorLogin = typeof payload.user?.login === "string" ? payload.user.login : undefined;
  const assignees = mapIssueAssigneeRecords(payload);
  const labels = Array.isArray(payload.labels)
    ? payload.labels
      .map((label) => mapIssueLabelRecord(label))
      .filter((label): label is IssueLabelRecord => label !== null)
    : [];
  const labelNames = Array.isArray(payload.labels)
    ? payload.labels
      .map((label) => (typeof label?.name === "string" ? label.name : undefined))
      .filter((label): label is string => label !== undefined && label.length > 0)
    : [];
  const commentCount = typeof payload.comments === "number" ? payload.comments : undefined;
  const milestone = mapIssueMilestoneRecord(payload.milestone);
  const createdAt = typeof payload.created_at === "string" ? payload.created_at : undefined;
  const updatedAt = typeof payload.updated_at === "string" ? payload.updated_at : undefined;
  const closedAt = typeof payload.closed_at === "string" ? payload.closed_at : undefined;

  return {
    number,
    title: typeof payload.title === "string" ? payload.title : `Issue #${number}`,
    state,
    url: buildIssueUrl(repository, number),
    assignees,
    labels,
    closed: state === "closed",
    isPinned: typeof payload.pin_order === "number" && payload.pin_order > 0,
    ...(id === undefined ? {} : { id }),
    ...(body === undefined ? {} : { body }),
    ...(author === null ? {} : { author }),
    ...(authorLogin === undefined ? {} : { authorLogin }),
    ...(labelNames.length === 0 ? {} : { labelNames }),
    ...(commentCount === undefined ? {} : { commentCount, comments: commentCount }),
    ...(milestone === null ? {} : { milestone }),
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
    ...(closedAt === undefined ? {} : { closedAt })
  };
}

async function resolveIssueListFilterUser(
  rawValue: string | undefined,
  repository: RepositoryContext,
  context: ResolvedCliExecutionContext
): Promise<{ value?: string; error?: CliResult }> {
  if (rawValue === undefined || rawValue !== "@me") {
    return rawValue === undefined ? {} : { value: rawValue };
  }

  const currentUserResult = await readCurrentUser(repository.hostname, context, "list");

  if (currentUserResult.error !== undefined || currentUserResult.login === undefined) {
    return {
      error: currentUserResult.error ?? {
        exitCode: 1,
        stdout: "",
        stderr: "Failed to resolve the current user.\n"
      }
    };
  }

  return { value: currentUserResult.login };
}

async function resolveIssueListQueryOptions(
  flags: ParsedIssueFlags,
  repository: RepositoryContext,
  context: ResolvedCliExecutionContext
): Promise<{ options?: IssueListQueryOptions; error?: CliResult }> {
  const assigneeResult = await resolveIssueListFilterUser(flags.assignee, repository, context);

  if (assigneeResult.error !== undefined) {
    return { error: assigneeResult.error };
  }

  const authorResult = await resolveIssueListFilterUser(flags.author, repository, context);

  if (authorResult.error !== undefined) {
    return { error: authorResult.error };
  }

  const mentionResult = await resolveIssueListFilterUser(flags.mention, repository, context);

  if (mentionResult.error !== undefined) {
    return { error: mentionResult.error };
  }

  const options: IssueListQueryOptions = {
    labels: flags.labels ?? [],
    state: flags.state ?? "open"
  };

  if (assigneeResult.value !== undefined) {
    options.assignee = assigneeResult.value;
  }

  if (authorResult.value !== undefined) {
    options.author = authorResult.value;
  }

  if (flags.limit !== undefined) {
    options.limit = flags.limit;
  }

  if (mentionResult.value !== undefined) {
    options.mention = mentionResult.value;
  }

  if (flags.milestone !== undefined) {
    options.milestone = flags.milestone;
  }

  if (flags.search !== undefined) {
    options.search = flags.search;
  }

  return {
    options
  };
}

function buildIssueListRequestUrl(repository: RepositoryContext, options: IssueListQueryOptions): string {
  const params = new URLSearchParams();

  params.set("state", options.state);

  if (options.labels.length > 0) {
    params.set("labels", options.labels.join(","));
  }

  if (options.search !== undefined) {
    params.set("q", options.search);
  }

  if (options.milestone !== undefined) {
    params.set("milestones", options.milestone);
  }

  if (options.author !== undefined) {
    params.set("created_by", options.author);
  }

  if (options.assignee !== undefined) {
    params.set("assigned_by", options.assignee);
  }

  if (options.mention !== undefined) {
    params.set("mentioned_by", options.mention);
  }

  if (options.limit !== undefined) {
    params.set("limit", String(options.limit));
  }

  return `${buildHostBaseUrl(repository.hostname)}/api/v1/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repository)}/issues?${params.toString()}`;
}

async function readIssue(
  repository: RepositoryContext,
  issueNumber: number,
  context: ResolvedCliExecutionContext
): Promise<{ issue?: IssueRecord; error?: CliResult }> {
  const issuePayloadResult = await readIssuePayload(repository, issueNumber, context);

  if (issuePayloadResult.error !== undefined || issuePayloadResult.payload === undefined) {
    return {
      error: issuePayloadResult.error ?? {
        exitCode: 1,
        stdout: "",
        stderr: `Failed to read issue #${issueNumber}.\n`
      }
    };
  }

  return {
    issue: mapIssueRecord(repository, issuePayloadResult.payload, issueNumber)
  };
}

async function readIssuePayload(
  repository: RepositoryContext,
  issueNumber: number,
  context: ResolvedCliExecutionContext
): Promise<{ payload?: GiteaIssuePayload; error?: CliResult }> {
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

    const payload = await response.json() as unknown;

    if (!isPlainObjectValue(payload)) {
      return {
        error: {
          exitCode: 1,
          stdout: "",
          stderr: `Gitea returned an invalid issue payload while reading issue #${issueNumber}.\n`
        }
      };
    }

    return {
      payload: payload as GiteaIssuePayload
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

    const payload = await response.json() as unknown;

    if (!Array.isArray(payload)) {
      return {
        error: {
          exitCode: 1,
          stdout: "",
          stderr: `Gitea returned an invalid issue comment payload while reading issue #${issueNumber}.\n`
        }
      };
    }

    const comments = payload
      .map((comment) => mapIssueCommentRecord(repository, issueNumber, isPlainObjectValue(comment) ? comment as GiteaIssueCommentPayload : null))
      .filter((comment): comment is IssueCommentRecord => comment !== null);

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

async function readIssueEditLookupPayload<T>(
  repository: RepositoryContext,
  issueNumber: number,
  requestUrl: string,
  context: ResolvedCliExecutionContext,
  commandName: IssueMutationCommandName
): Promise<{ payload: T } | { error: CliResult }> {
  const token = resolveOptionalToken(repository.hostname, context);
  const actionLabel = issueMutationActionLabel(commandName);

  try {
    const response = await fetch(requestUrl, {
      headers: {
        Authorization: `token ${token ?? ""}`
      }
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
      payload: await response.json() as T
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return {
      error: {
        exitCode: 1,
        stdout: "",
        stderr: `Failed to edit issue #${issueNumber} on ${repository.hostname}: ${message}\n`
      }
    };
  }
}

async function readRepositoryLabels(
  repository: RepositoryContext,
  issueNumber: number,
  context: ResolvedCliExecutionContext,
  commandName: IssueMutationCommandName
): Promise<{ labels?: GiteaLabelPayload[]; error?: CliResult }> {
  const requestUrl = `${buildHostBaseUrl(repository.hostname)}/api/v1/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repository)}/labels`;
  const result = await readIssueEditLookupPayload<GiteaLabelPayload[]>(
    repository,
    issueNumber,
    requestUrl,
    context,
    commandName
  );

  return "error" in result
    ? { error: result.error }
    : { labels: result.payload };
}

async function readRepositoryMilestones(
  repository: RepositoryContext,
  issueNumber: number,
  context: ResolvedCliExecutionContext,
  commandName: IssueMutationCommandName
): Promise<{ milestones?: GiteaMilestonePayload[]; error?: CliResult }> {
  const requestUrl = `${buildHostBaseUrl(repository.hostname)}/api/v1/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repository)}/milestones?state=all`;
  const result = await readIssueEditLookupPayload<GiteaMilestonePayload[]>(
    repository,
    issueNumber,
    requestUrl,
    context,
    commandName
  );

  return "error" in result
    ? { error: result.error }
    : { milestones: result.payload };
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
  payload: IssueUpdatePayload,
  context: ResolvedCliExecutionContext,
  commandName: "create" | "edit" | "close" | "reopen",
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

async function replaceIssueLabels(
  repository: RepositoryContext,
  issueNumber: number,
  labelIds: number[],
  context: ResolvedCliExecutionContext,
  commandName: IssueMutationCommandName
): Promise<{ error?: CliResult }> {
  const token = resolveOptionalToken(repository.hostname, context);
  const actionLabel = issueMutationActionLabel(commandName);

  if (token === undefined) {
    return {
      error: {
        exitCode: 1,
        stdout: "",
        stderr: `gtea issue ${commandName} requires an authenticated host credential. Run gtea auth login or set GTEA_TOKEN/GH_TOKEN.\n`
      }
    };
  }

  const requestUrl = `${buildHostBaseUrl(repository.hostname)}/api/v1/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repository)}/issues/${issueNumber}/labels`;

  try {
    const response = await fetch(requestUrl, {
      method: "PUT",
      headers: {
        Authorization: `token ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ labels: labelIds })
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

    return {};
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

async function planIssueEditMutations(
  repository: RepositoryContext,
  issueNumber: number,
  flags: ParsedIssueMutationFlags,
  body: string | undefined,
  context: ResolvedCliExecutionContext,
  commandName: IssueMutationCommandName = "edit"
): Promise<{ patchPayload: IssueUpdatePayload; labelIds?: number[]; error?: CliResult }> {
  const actionLabel = issueMutationActionLabel(commandName);

  if (flags.milestone !== undefined && flags.removeMilestone === true) {
    return {
      patchPayload: {},
      error: {
        exitCode: 1,
        stdout: "",
        stderr: "Specify only one of --milestone or --remove-milestone.\n"
      }
    };
  }

  const patchPayload: IssueUpdatePayload = {
    ...(flags.title === undefined ? {} : { title: flags.title }),
    ...(body === undefined ? {} : { body })
  };

  if (!hasIssueMetadataChanges(flags)) {
    return { patchPayload };
  }

  const issuePayloadResult = await readIssuePayload(repository, issueNumber, context);

  if (issuePayloadResult.error !== undefined || issuePayloadResult.payload === undefined) {
    return {
      patchPayload,
      error: issuePayloadResult.error ?? {
        exitCode: 1,
        stdout: "",
        stderr: `Failed to read issue #${issueNumber}.\n`
      }
    };
  }

  const currentIssue = issuePayloadResult.payload;

  if (flags.addAssignees.length > 0 || flags.removeAssignees.length > 0) {
    let currentUserLogin: string | undefined;

    if (flags.addAssignees.includes("@me") || flags.removeAssignees.includes("@me")) {
      const currentUserResult = await readCurrentUser(repository.hostname, context, commandName);

      if (currentUserResult.error !== undefined || currentUserResult.login === undefined) {
        return {
          patchPayload,
          error: currentUserResult.error ?? {
            exitCode: 1,
            stdout: "",
            stderr: `Failed to resolve @me while ${actionLabel} issue #${issueNumber}.\n`
          }
        };
      }

      currentUserLogin = currentUserResult.login;
    }

    patchPayload.assignees = applyStringListMutations(
      currentIssueAssignees(currentIssue),
      resolveAssigneeAliases(flags.addAssignees, currentUserLogin),
      resolveAssigneeAliases(flags.removeAssignees, currentUserLogin)
    );
  }

  if (flags.milestone !== undefined) {
    const milestoneResult = await readRepositoryMilestones(repository, issueNumber, context, commandName);

    if (milestoneResult.error !== undefined || milestoneResult.milestones === undefined) {
      return {
        patchPayload,
        error: milestoneResult.error ?? {
          exitCode: 1,
          stdout: "",
          stderr: `Failed to resolve milestone while ${actionLabel} issue #${issueNumber}.\n`
        }
      };
    }

    const matchingMilestone = milestoneResult.milestones.find(
      (milestone) => milestone.title === flags.milestone && typeof milestone.id === "number"
    );

    if (matchingMilestone?.id === undefined) {
      return {
        patchPayload,
        error: {
          exitCode: 1,
          stdout: "",
          stderr: `Validation failed while ${actionLabel} issue #${issueNumber} in ${repository.owner}/${repository.repository}: milestone "${flags.milestone}" was not found.\n`
        }
      };
    }

    patchPayload.milestone = matchingMilestone.id;
  }

  if (flags.removeMilestone === true) {
    patchPayload.milestone = 0;
  }

  if (flags.addLabels.length === 0 && flags.removeLabels.length === 0) {
    return { patchPayload };
  }

  const labelResult = await readRepositoryLabels(repository, issueNumber, context, commandName);

  if (labelResult.error !== undefined || labelResult.labels === undefined) {
    return {
      patchPayload,
      error: labelResult.error ?? {
        exitCode: 1,
        stdout: "",
        stderr: `Failed to resolve labels while ${actionLabel} issue #${issueNumber}.\n`
      }
    };
  }

  const finalLabelNames = applyStringListMutations(
    currentIssueLabelNames(currentIssue),
    flags.addLabels,
    flags.removeLabels
  );
  const availableLabels = new Map(
    labelResult.labels
      .filter((label) => typeof label.name === "string" && label.name.length > 0 && typeof label.id === "number")
      .map((label) => [label.name as string, label.id as number])
  );
  const labelIds: number[] = [];

  for (const labelName of finalLabelNames) {
    const labelId = availableLabels.get(labelName);

    if (labelId === undefined) {
      return {
        patchPayload,
        error: {
          exitCode: 1,
          stdout: "",
          stderr: `Validation failed while ${actionLabel} issue #${issueNumber} in ${repository.owner}/${repository.repository}: label "${labelName}" was not found.\n`
        }
      };
    }

    labelIds.push(labelId);
  }

  return {
    patchPayload,
    labelIds
  };
}

async function applyIssueMutationPlan(
  repository: RepositoryContext,
  issueNumber: number,
  plan: { patchPayload: IssueUpdatePayload; labelIds?: number[] },
  context: ResolvedCliExecutionContext,
  commandName: "create" | "edit"
): Promise<{ error?: CliResult }> {
  const actionLabel = commandName === "create" ? "creating" : "editing";
  const hasPatchPayload = Object.keys(plan.patchPayload).length > 0;

  if (hasPatchPayload) {
    const updateResult = await updateIssue(
      repository,
      issueNumber,
      plan.patchPayload,
      context,
      commandName,
      actionLabel
    );

    if (updateResult.error !== undefined || updateResult.issue === undefined) {
      return {
        error: updateResult.error ?? {
          exitCode: 1,
          stdout: "",
          stderr: `Failed to ${commandName} issue.\n`
        }
      };
    }
  }

  if (plan.labelIds !== undefined) {
    const labelResult = await replaceIssueLabels(
      repository,
      issueNumber,
      plan.labelIds,
      context,
      commandName
    );

    if (labelResult.error !== undefined) {
      return {
        error: labelResult.error
      };
    }
  }

  return {};
}

async function readIssueList(
  repository: RepositoryContext,
  context: ResolvedCliExecutionContext,
  options: IssueListQueryOptions = { labels: [], state: "open" }
): Promise<{ issues?: IssueRecord[]; payload?: GiteaIssuePayload[]; error?: CliResult }> {
  const requestUrl = buildIssueListRequestUrl(repository, options);
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

    const payload = await response.json() as unknown;

    if (!Array.isArray(payload)) {
      return {
        error: {
          exitCode: 1,
          stdout: "",
          stderr: `Gitea returned an invalid issue list payload for ${repository.owner}/${repository.repository}.\n`
        }
      };
    }

    const issuesPayload = payload.filter((entry): entry is GiteaIssuePayload & { number: number } => hasIssueNumber(entry));

    return {
      issues: issuesPayload.map((entry) => mapIssueRecord(repository, entry, entry.number)),
      payload: issuesPayload
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

async function readCurrentUser(
  hostname: string,
  context: ResolvedCliExecutionContext,
  commandName: "create" | "list" | "status" | "edit" = "status"
): Promise<{ login?: string; error?: CliResult }> {
  const token = resolveOptionalToken(hostname, context);

  if (token === undefined) {
    return {
      error: {
        exitCode: 1,
        stdout: "",
        stderr: `gtea issue ${commandName} requires an authenticated host credential. Run gtea auth login or set GTEA_TOKEN/GH_TOKEN.\n`
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

  if (Array.isArray(issue.comments) && issue.comments.length > 0) {
    if (options?.showAllComments === true) {
      for (const comment of issue.comments) {
        const commentAuthorLogin = comment.author?.login ?? comment.authorLogin ?? undefined;

        lines.push(
          "",
          commentAuthorLogin === undefined ? "Comment" : `${commentAuthorLogin} • Comment`,
          "",
          comment.body
        );
      }
    } else {
      const newestComment = issue.comments[issue.comments.length - 1]!;
      const newestCommentAuthorLogin = newestComment.author?.login ?? newestComment.authorLogin ?? undefined;

      const hiddenCommentCount = Math.max((issue.commentCount ?? issue.comments.length) - 1, 0);

      if (hiddenCommentCount > 0) {
        lines.push("", `-------- Not showing ${hiddenCommentCount} comment${hiddenCommentCount === 1 ? "" : "s"} --------`);
      }

      lines.push(
        "",
        newestCommentAuthorLogin === undefined ? "Newest comment" : `${newestCommentAuthorLogin} • Newest comment`,
        "",
        newestComment.body
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

function renderIssueList(issues: IssueRecord[], options?: { state?: IssueListState }): string {
  if (issues.length === 0) {
    if (options?.state === "closed") {
      return "No closed issues found.\n";
    }

    if (options?.state === "all") {
      return "No issues found.\n";
    }

    return "No open issues found.\n";
  }

  return `${issues.map((issue) => `#${issue.number}  [${issue.state}] ${issue.title}`).join("\n")}\n`;
}

function isIssueAssignedToUser(issue: GiteaIssuePayload, login: string): boolean {
  if (issue.assignee?.login === login) {
    return true;
  }

  return issue.assignees?.some((assignee) => assignee?.login === login) ?? false;
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
  supportedFields: Iterable<string>,
  jqExpression?: string,
  template?: string
): { stdout?: string; error?: CliResult } {
  const renderedOutput = renderStructuredJson(value, jsonFields, supportedFields);

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

    const bodyInputResult = resolveIssueBodyInput(parsedCreateFlags.flags, context);

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
      bodyInputResult.body,
      context
    );

    if (createResult.error !== undefined || createResult.issue === undefined) {
      return createResult.error ?? {
        exitCode: 1,
        stdout: "",
        stderr: "Failed to create issue.\n"
      };
    }

    const createMetadataFlags = buildIssueCreateMutationFlags(parsedCreateFlags.flags);

    if (hasIssueMetadataChanges(createMetadataFlags)) {
      const metadataPlanResult = await planIssueEditMutations(
        repositoryResult.repository,
        createResult.issue.number,
        createMetadataFlags,
        undefined,
        context,
        "create"
      );

      if (metadataPlanResult.error !== undefined) {
        return metadataPlanResult.error;
      }

      const metadataApplyResult = await applyIssueMutationPlan(
        repositoryResult.repository,
        createResult.issue.number,
        metadataPlanResult,
        context,
        "create"
      );

      if (metadataApplyResult.error !== undefined) {
        return metadataApplyResult.error;
      }
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
      allowBody: true,
      allowBodyFile: false
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
      allowBody: true,
      allowBodyFile: true,
      allowMultipleIssueNumbers: true
    });

    if (parsedMutationFlags.error !== undefined) {
      return parsedMutationFlags.error;
    }

    const bodyInputResult = resolveIssueBodyInput(parsedMutationFlags.flags, context);

    if (bodyInputResult.error !== undefined) {
      return bodyInputResult.error;
    }

    if (parsedMutationFlags.flags.issueNumbers.length === 0) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: "Issue number is required.\n"
      };
    }

    if (
      parsedMutationFlags.flags.title === undefined
      && parsedMutationFlags.flags.body === undefined
      && parsedMutationFlags.flags.bodyFile === undefined
      && !hasIssueMetadataChanges(parsedMutationFlags.flags)
    ) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: "At least one supported issue edit flag is required.\n"
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

    const failureMessages: string[] = [];

    for (const issueNumber of parsedMutationFlags.flags.issueNumbers) {
      const editPlanResult = await planIssueEditMutations(
        repositoryResult.repository,
        issueNumber,
        parsedMutationFlags.flags,
        bodyInputResult.body,
        context
      );

      if (editPlanResult.error !== undefined) {
        failureMessages.push(editPlanResult.error.stderr);
        continue;
      }

      const applyResult = await applyIssueMutationPlan(
        repositoryResult.repository,
        issueNumber,
        editPlanResult,
        context,
        "edit"
      );

      if (applyResult.error !== undefined) {
        failureMessages.push(applyResult.error.stderr);
      }
    }

    if (failureMessages.length > 0) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: failureMessages.join("")
      };
    }

    return {
      exitCode: 0,
      stdout: "",
      stderr: ""
    };
  }

  if (subcommand === "close") {
    const parsedMutationFlags = parseIssueMutationFlags(args.slice(2), {
      allowTitle: false,
      allowBody: false,
      allowBodyFile: false
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
      stdout: "",
      stderr: ""
    };
  }

  if (subcommand === "reopen") {
    const parsedMutationFlags = parseIssueMutationFlags(args.slice(2), {
      allowTitle: false,
      allowBody: false,
      allowBodyFile: false
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
      stdout: "",
      stderr: ""
    };
  }

  const parsedFlags = parseIssueFlags(args.slice(2), subcommand);

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
    const queryOptionsResult = await resolveIssueListQueryOptions(
      parsedFlags.flags,
      repositoryResult.repository,
      context
    );

    if (queryOptionsResult.error !== undefined || queryOptionsResult.options === undefined) {
      return queryOptionsResult.error ?? {
        exitCode: 1,
        stdout: "",
        stderr: "Failed to resolve issue list filters.\n"
      };
    }

    const issueListResult = await readIssueList(repositoryResult.repository, context, queryOptionsResult.options);

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
        issueListOutputFields,
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
      stdout: renderIssueList(issueListResult.issues, { state: queryOptionsResult.options.state }),
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
        issueStatusOutputFields,
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
    if (parsedFlags.flags.jsonFields.includes("comments")) {
      if (issueResult.issue.commentCount === 0) {
        issueResult.issue = {
          ...issueResult.issue,
          comments: []
        };
      } else {
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
    }

    const renderedOutput = renderStructuredIssueOutput(
      issueResult.issue,
      parsedFlags.flags.jsonFields,
      issueViewOutputFields,
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