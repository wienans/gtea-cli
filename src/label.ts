import { CliResult, ResolvedCliExecutionContext } from "./cli-runtime.js";
import { buildHostBaseUrl } from "./host-config.js";
import {
  buildAuthorizationHeaders,
  preferOptionalTokenError,
  resolveOptionalTokenResult,
  resolveRepositoryCommandTarget,
  resolveRequiredTokenResult,
  type RepositoryContext
} from "./repository-context.js";
import {
  buildRepositoryLabelIdLookup,
  mapRepositoryLabelRecord,
  type GiteaRepositoryLabelPayload as GiteaLabelPayload,
  type RepositoryLabelRecord as LabelRecord
} from "./repository-labels.js";
import { renderStructuredJq, renderStructuredJson, renderStructuredTemplate, type StructuredObject } from "./structured-output.js";
import { ManifestCommand, ManifestGroup, supportManifest } from "./support-manifest.js";

interface ParsedLabelCreateFlags {
  color?: string;
  description?: string;
  name?: string;
  repository?: string;
}

interface ParsedLabelEditFlags {
  color?: string;
  currentName?: string;
  description?: string;
  newName?: string;
  repository?: string;
}

interface ParsedLabelDeleteFlags {
  name?: string;
  repository?: string;
}

interface ParsedLabelListFlags {
  repository?: string;
  limit?: number;
  jsonFields?: string[];
  jqExpression?: string;
  template?: string;
}

const labelGroup = supportManifest.children.find(
  (node): node is ManifestGroup => node.kind === "group" && node.name === "label"
);
const labelCommands = new Map(
  (labelGroup?.children ?? [])
    .filter((node): node is ManifestCommand => node.kind === "command")
    .map((node) => [node.name, node] as const)
);
const labelListOutputFields = new Set(
  (labelCommands.get("list")?.outputFields ?? [])
    .filter((field) => field.status !== "unsupported")
    .map((field) => field.name)
);

function renderUnsupportedLabelFlag(subcommand: string, flag: string, reason: string): CliResult {
  return {
    exitCode: 1,
    stdout: "",
    stderr: `${supportManifest.cliName} label ${subcommand} flag ${flag} is currently unsupported: ${reason}\n`
  };
}

function resolveRequiredLabelToken(
  hostname: string,
  context: ResolvedCliExecutionContext,
  commandName: "create" | "edit" | "delete"
): { token: string } | { error: CliResult } {
  return resolveRequiredTokenResult(hostname, context, {
    exitCode: 1,
    stdout: "",
    stderr: `gtea label ${commandName} requires an authenticated host credential. Run gtea auth login or set GTEA_TOKEN/GH_TOKEN.\n`
  });
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

function parseLabelListFlags(args: string[]): { flags: ParsedLabelListFlags; error?: CliResult } {
  const flags: ParsedLabelListFlags = {};

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

    const jqFlag = parseStringFlagValue(args, index, { long: "--jq", short: "-q" });

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

    const templateFlag = parseStringFlagValue(args, index, { long: "--template", short: "-t" });

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

    const limitFlag = parseStringFlagValue(args, index, { long: "--limit", short: "-L" });

    if (limitFlag.error !== undefined) {
      return {
        flags,
        error: limitFlag.error
      };
    }

    if (limitFlag.handled && limitFlag.value !== undefined) {
      if (!/^\d+$/.test(limitFlag.value)) {
        return {
          flags,
          error: {
            exitCode: 1,
            stdout: "",
            stderr: `Invalid value for --limit: ${limitFlag.value}. Expected a positive integer.\n`
          }
        };
      }

      const parsedLimit = Number.parseInt(limitFlag.value, 10);

      if (!Number.isSafeInteger(parsedLimit) || parsedLimit <= 0) {
        return {
          flags,
          error: {
            exitCode: 1,
            stdout: "",
            stderr: `Invalid value for --limit: ${limitFlag.value}. Expected a positive integer.\n`
          }
        };
      }

      flags.limit = parsedLimit;
      index = limitFlag.nextIndex;
      continue;
    }

    const unsupportedStringFlags: Array<{ long: string; short?: string; reason: string }> = [
      {
        long: "--order",
        reason: "Gitea repository label lists do not expose gh-compatible sort order selection."
      },
      {
        long: "--search",
        short: "-S",
        reason: "Gitea repository label lists do not expose a gh-compatible label search query."
      },
      {
        long: "--sort",
        reason: "Gitea repository label lists do not expose gh-compatible label sort selection."
      }
    ] as const;

    for (const unsupportedFlag of unsupportedStringFlags) {
      const unsupportedValue = parseStringFlagValue(args, index, {
        long: unsupportedFlag.long,
        ...(unsupportedFlag.short === undefined ? {} : { short: unsupportedFlag.short })
      });

      if (unsupportedValue.error !== undefined) {
        return {
          flags,
          error: unsupportedValue.error
        };
      }

      if (unsupportedValue.handled) {
        return {
          flags,
          error: renderUnsupportedLabelFlag("list", unsupportedFlag.long, unsupportedFlag.reason)
        };
      }
    }

    if (token === "--web" || token === "-w") {
      return {
        flags,
        error: renderUnsupportedLabelFlag(
          "list",
          "--web",
          "Browser label listings with gh-compatible filter propagation are not part of the supported label list slice."
        )
      };
    }

    return {
      flags,
      error: {
        exitCode: 1,
        stdout: "",
        stderr: token.startsWith("-")
          ? `Unknown flag or argument: ${token}\n`
          : `Unexpected argument: ${token}\n`
      }
    };
  }

  return { flags };
}

function parseLabelCreateFlags(args: string[]): { flags: ParsedLabelCreateFlags; error?: CliResult } {
  const flags: ParsedLabelCreateFlags = {};

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

    const colorFlag = parseStringFlagValue(args, index, { long: "--color", short: "-c" });

    if (colorFlag.error !== undefined) {
      return {
        flags,
        error: colorFlag.error
      };
    }

    if (colorFlag.handled && colorFlag.value !== undefined) {
      flags.color = colorFlag.value;
      index = colorFlag.nextIndex;
      continue;
    }

    const descriptionFlag = parseStringFlagValue(args, index, { long: "--description", short: "-d" });

    if (descriptionFlag.error !== undefined) {
      return {
        flags,
        error: descriptionFlag.error
      };
    }

    if (descriptionFlag.handled && descriptionFlag.value !== undefined) {
      flags.description = descriptionFlag.value;
      index = descriptionFlag.nextIndex;
      continue;
    }

    if (token === "--force" || token === "-f") {
      return {
        flags,
        error: renderUnsupportedLabelFlag(
          "create",
          "--force",
          "Replacing an existing Repository Label during create is not part of the supported label write slice."
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

    if (flags.name === undefined) {
      flags.name = token;
      continue;
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

function parseLabelEditFlags(args: string[]): { flags: ParsedLabelEditFlags; error?: CliResult } {
  const flags: ParsedLabelEditFlags = {};

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

    const nameFlag = parseStringFlagValue(args, index, { long: "--name", short: "-n" });

    if (nameFlag.error !== undefined) {
      return {
        flags,
        error: nameFlag.error
      };
    }

    if (nameFlag.handled && nameFlag.value !== undefined) {
      flags.newName = nameFlag.value;
      index = nameFlag.nextIndex;
      continue;
    }

    const colorFlag = parseStringFlagValue(args, index, { long: "--color", short: "-c" });

    if (colorFlag.error !== undefined) {
      return {
        flags,
        error: colorFlag.error
      };
    }

    if (colorFlag.handled && colorFlag.value !== undefined) {
      flags.color = colorFlag.value;
      index = colorFlag.nextIndex;
      continue;
    }

    const descriptionFlag = parseStringFlagValue(args, index, { long: "--description", short: "-d" });

    if (descriptionFlag.error !== undefined) {
      return {
        flags,
        error: descriptionFlag.error
      };
    }

    if (descriptionFlag.handled && descriptionFlag.value !== undefined) {
      flags.description = descriptionFlag.value;
      index = descriptionFlag.nextIndex;
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

    if (flags.currentName === undefined) {
      flags.currentName = token;
      continue;
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

function parseLabelDeleteFlags(args: string[]): { flags: ParsedLabelDeleteFlags; error?: CliResult } {
  const flags: ParsedLabelDeleteFlags = {};

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

    if (token === "--yes" || token === "-y") {
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

    if (flags.name === undefined) {
      flags.name = token;
      continue;
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

function labelMutationActionLabel(commandName: "edit" | "delete"): "editing" | "deleting" {
  return commandName === "edit" ? "editing" : "deleting";
}

function normalizeLabelColor(rawColor: string): { color?: string; error?: CliResult } {
  const color = rawColor.startsWith("#") ? rawColor.slice(1) : rawColor;

  if (!/^[0-9a-fA-F]{6}$/.test(color)) {
    return {
      error: {
        exitCode: 1,
        stdout: "",
        stderr: `Invalid value for --color: ${rawColor}. Expected a 6-digit hex label color.\n`
      }
    };
  }

  return {
    color: color.toLowerCase()
  };
}

function validateStructuredLabelFlags(flags: ParsedLabelListFlags): CliResult | undefined {
  if (flags.jqExpression !== undefined && flags.jsonFields === undefined) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "--jq requires --json.\n"
    };
  }

  if (flags.template !== undefined && flags.jsonFields === undefined) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "--template requires --json.\n"
    };
  }

  if (flags.template !== undefined && flags.jqExpression !== undefined) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "Choose at most one of --jq and --template.\n"
    };
  }

  return undefined;
}

function resolveLabelRepositoryTarget(
  repositoryFlag: string | undefined,
  context: ResolvedCliExecutionContext
): { repository?: RepositoryContext; error?: CliResult } {
  const repositoryResult = resolveRepositoryCommandTarget(repositoryFlag, { mode: "none" }, context);

  if (repositoryResult.error !== undefined || repositoryResult.target?.repository === undefined) {
    return {
      error: repositoryResult.error ?? {
        exitCode: 1,
        stdout: "",
        stderr: "No Repository Context selected.\n"
      }
    };
  }

  return {
    repository: repositoryResult.target.repository
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

async function readRepositoryLabels(
  repository: RepositoryContext,
  flags: ParsedLabelListFlags,
  context: ResolvedCliExecutionContext
): Promise<{ labels?: LabelRecord[]; error?: CliResult }> {
  const requestUrl = new URL(
    `${buildHostBaseUrl(repository.hostname)}/api/v1/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repository)}/labels`
  );

  if (flags.limit !== undefined) {
    requestUrl.searchParams.set("limit", String(flags.limit));
  }

  const tokenResult = resolveOptionalTokenResult(repository.hostname, context);
  const headers = buildAuthorizationHeaders(tokenResult.token);

  try {
    const response = await fetch(requestUrl, headers === undefined ? undefined : { headers });

    if (!response.ok) {
      return {
        error: preferOptionalTokenError(tokenResult, {
          exitCode: 1,
          stdout: "",
          stderr: `Gitea returned ${response.status} while listing labels for ${repository.owner}/${repository.repository}.\n`
        })
      };
    }

    const payload = await response.json();

    if (!Array.isArray(payload)) {
      return {
        error: {
          exitCode: 1,
          stdout: "",
          stderr: `Failed to list labels for ${repository.owner}/${repository.repository}.\n`
        }
      };
    }

    return {
      labels: payload
        .map((entry) => mapRepositoryLabelRecord(entry as GiteaLabelPayload | null | undefined))
        .filter((entry): entry is LabelRecord => entry !== null)
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return {
      error: {
        exitCode: 1,
        stdout: "",
        stderr: `Failed to list labels for ${repository.owner}/${repository.repository} from ${repository.hostname}: ${message}\n`
      }
    };
  }
}

async function readRepositoryLabelsForMutation(
  repository: RepositoryContext,
  currentName: string,
  context: ResolvedCliExecutionContext,
  commandName: "edit" | "delete"
): Promise<{ labels?: GiteaLabelPayload[]; error?: CliResult }> {
  const tokenResult = resolveRequiredLabelToken(repository.hostname, context, commandName);

  if ("error" in tokenResult) {
    return { error: tokenResult.error };
  }

  const actionLabel = labelMutationActionLabel(commandName);
  const requestUrl = `${buildHostBaseUrl(repository.hostname)}/api/v1/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repository)}/labels`;

  try {
    const response = await fetch(requestUrl, {
      headers: buildAuthorizationHeaders(tokenResult.token) ?? {}
    });

    if (response.status === 401 || response.status === 403) {
      return {
        error: {
          exitCode: 1,
          stdout: "",
          stderr: `Authentication failed while ${actionLabel} label "${currentName}" on ${repository.hostname}.\n`
        }
      };
    }

    if (!response.ok) {
      return {
        error: {
          exitCode: 1,
          stdout: "",
          stderr: `Gitea returned ${response.status} while ${actionLabel} label "${currentName}" in ${repository.owner}/${repository.repository}.\n`
        }
      };
    }

    const payload = await response.json();

    if (!Array.isArray(payload)) {
      return {
        error: {
          exitCode: 1,
          stdout: "",
          stderr: `Failed to resolve label "${currentName}" in ${repository.owner}/${repository.repository}.\n`
        }
      };
    }

    return {
      labels: payload as GiteaLabelPayload[]
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return {
      error: {
        exitCode: 1,
        stdout: "",
        stderr: `Failed to ${commandName} label "${currentName}" on ${repository.hostname}: ${message}\n`
      }
    };
  }
}

async function createRepositoryLabel(
  repository: RepositoryContext,
  input: { name: string; color: string; description?: string },
  context: ResolvedCliExecutionContext
): Promise<{ error?: CliResult }> {
  const tokenResult = resolveRequiredLabelToken(repository.hostname, context, "create");

  if ("error" in tokenResult) {
    return { error: tokenResult.error };
  }

  const requestUrl = `${buildHostBaseUrl(repository.hostname)}/api/v1/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repository)}/labels`;

  try {
    const response = await fetch(requestUrl, {
      method: "POST",
      headers: {
        Authorization: `token ${tokenResult.token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        name: input.name,
        color: input.color,
        ...(input.description === undefined ? {} : { description: input.description })
      })
    });

    if (response.status === 401 || response.status === 403) {
      return {
        error: {
          exitCode: 1,
          stdout: "",
          stderr: `Authentication failed while creating label "${input.name}" on ${repository.hostname}.\n`
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
            ? `Validation failed while creating label "${input.name}" in ${repository.owner}/${repository.repository}.\n`
            : `Validation failed while creating label "${input.name}" in ${repository.owner}/${repository.repository}: ${validationMessage}\n`
        }
      };
    }

    if (!response.ok) {
      return {
        error: {
          exitCode: 1,
          stdout: "",
          stderr: `Gitea returned ${response.status} while creating label "${input.name}" in ${repository.owner}/${repository.repository}.\n`
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
        stderr: `Failed to create label "${input.name}" on ${repository.hostname}: ${message}\n`
      }
    };
  }
}

async function editRepositoryLabel(
  repository: RepositoryContext,
  labelId: number,
  currentName: string,
  input: { name?: string; color?: string; description?: string },
  context: ResolvedCliExecutionContext
): Promise<{ error?: CliResult }> {
  const tokenResult = resolveRequiredLabelToken(repository.hostname, context, "edit");

  if ("error" in tokenResult) {
    return { error: tokenResult.error };
  }

  const requestUrl = `${buildHostBaseUrl(repository.hostname)}/api/v1/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repository)}/labels/${labelId}`;

  try {
    const response = await fetch(requestUrl, {
      method: "PATCH",
      headers: {
        Authorization: `token ${tokenResult.token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.color === undefined ? {} : { color: input.color }),
        ...(input.description === undefined ? {} : { description: input.description })
      })
    });

    if (response.status === 401 || response.status === 403) {
      return {
        error: {
          exitCode: 1,
          stdout: "",
          stderr: `Authentication failed while editing label "${currentName}" on ${repository.hostname}.\n`
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
            ? `Validation failed while editing label "${currentName}" in ${repository.owner}/${repository.repository}.\n`
            : `Validation failed while editing label "${currentName}" in ${repository.owner}/${repository.repository}: ${validationMessage}\n`
        }
      };
    }

    if (!response.ok) {
      return {
        error: {
          exitCode: 1,
          stdout: "",
          stderr: `Gitea returned ${response.status} while editing label "${currentName}" in ${repository.owner}/${repository.repository}.\n`
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
        stderr: `Failed to edit label "${currentName}" on ${repository.hostname}: ${message}\n`
      }
    };
  }
}

async function deleteRepositoryLabel(
  repository: RepositoryContext,
  labelId: number,
  currentName: string,
  context: ResolvedCliExecutionContext
): Promise<{ error?: CliResult }> {
  const tokenResult = resolveRequiredLabelToken(repository.hostname, context, "delete");

  if ("error" in tokenResult) {
    return { error: tokenResult.error };
  }

  const requestUrl = `${buildHostBaseUrl(repository.hostname)}/api/v1/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repository)}/labels/${labelId}`;

  try {
    const response = await fetch(requestUrl, {
      method: "DELETE",
      headers: buildAuthorizationHeaders(tokenResult.token)
    });

    if (response.status === 401 || response.status === 403) {
      return {
        error: {
          exitCode: 1,
          stdout: "",
          stderr: `Authentication failed while deleting label "${currentName}" on ${repository.hostname}.\n`
        }
      };
    }

    if (!response.ok) {
      return {
        error: {
          exitCode: 1,
          stdout: "",
          stderr: `Gitea returned ${response.status} while deleting label "${currentName}" in ${repository.owner}/${repository.repository}.\n`
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
        stderr: `Failed to delete label "${currentName}" on ${repository.hostname}: ${message}\n`
      }
    };
  }
}

async function resolveRepositoryLabelIdForMutation(
  repository: RepositoryContext,
  currentName: string,
  context: ResolvedCliExecutionContext,
  commandName: "edit" | "delete"
): Promise<{ labelId?: number; error?: CliResult }> {
  const labelLookupResult = await readRepositoryLabelsForMutation(repository, currentName, context, commandName);

  if (labelLookupResult.error !== undefined || labelLookupResult.labels === undefined) {
    return {
      error: labelLookupResult.error ?? {
        exitCode: 1,
        stdout: "",
        stderr: `Failed to resolve label "${currentName}".\n`
      }
    };
  }

  const labelId = buildRepositoryLabelIdLookup(labelLookupResult.labels).get(currentName);

  if (labelId === undefined) {
    return {
      error: {
        exitCode: 1,
        stdout: "",
        stderr: `Validation failed while ${labelMutationActionLabel(commandName)} label "${currentName}" in ${repository.owner}/${repository.repository}: label "${currentName}" was not found.\n`
      }
    };
  }

  return { labelId };
}

function renderLabelList(labels: LabelRecord[]): string {
  if (labels.length === 0) {
    return "No labels found.\n";
  }

  const rows = labels.map((label) => ({
    name: label.name ?? "",
    description: label.description ?? "",
    color: label.color === null ? "" : `#${label.color}`
  }));
  const nameWidth = Math.max("NAME".length, ...rows.map((row) => row.name.length)) + 2;
  const descriptionWidth = Math.max("DESCRIPTION".length, ...rows.map((row) => row.description.length)) + 2;
  const lines = [
    `${"NAME".padEnd(nameWidth)}${"DESCRIPTION".padEnd(descriptionWidth)}COLOR`
  ];

  lines.push(
    ...rows.map((row) => `${row.name.padEnd(nameWidth)}${row.description.padEnd(descriptionWidth)}${row.color}`)
  );

  return `${lines.join("\n")}\n`;
}

function renderStructuredLabelOutput(
  labels: LabelRecord[],
  jsonFields: string[],
  jqExpression?: string,
  template?: string
): { stdout?: string; error?: CliResult } {
  const renderedOutput = renderStructuredJson(labels, jsonFields, labelListOutputFields);

  if (renderedOutput.error !== undefined || renderedOutput.output === undefined) {
    return {
      error: {
        exitCode: 1,
        stdout: "",
        stderr: `${renderedOutput.error ?? "Failed to render structured label output."}\n`
      }
    };
  }

  if (jqExpression !== undefined) {
    const filteredOutput = renderStructuredJq(JSON.parse(renderedOutput.output) as StructuredObject[], jqExpression);

    if (filteredOutput.error !== undefined || filteredOutput.output === undefined) {
      return {
        error: {
          exitCode: 1,
          stdout: "",
          stderr: `${filteredOutput.error ?? "Failed to filter structured label output."}\n`
        }
      };
    }

    return {
      stdout: filteredOutput.output
    };
  }

  if (template !== undefined) {
    const templatedOutput = renderStructuredTemplate(JSON.parse(renderedOutput.output) as StructuredObject[], template);

    if (templatedOutput.error !== undefined || templatedOutput.output === undefined) {
      return {
        error: {
          exitCode: 1,
          stdout: "",
          stderr: `${templatedOutput.error ?? "Failed to render structured label template."}\n`
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

export async function executeLabelCommand(
  args: string[],
  context: ResolvedCliExecutionContext
): Promise<CliResult | undefined> {
  if (args[0] !== "label") {
    return undefined;
  }

  if (args[1] === "create") {
    const parsedFlags = parseLabelCreateFlags(args.slice(2));

    if (parsedFlags.error !== undefined) {
      return parsedFlags.error;
    }

    if (parsedFlags.flags.name === undefined) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: "Label name is required.\n"
      };
    }

    if (parsedFlags.flags.color === undefined) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: "Label color is required.\n"
      };
    }

    const colorResult = normalizeLabelColor(parsedFlags.flags.color);

    if (colorResult.error !== undefined || colorResult.color === undefined) {
      return colorResult.error;
    }

    const repositoryResult = resolveRepositoryCommandTarget(parsedFlags.flags.repository, { mode: "none" }, context);

    if (repositoryResult.error !== undefined || repositoryResult.target?.repository === undefined) {
      return repositoryResult.error ?? {
        exitCode: 1,
        stdout: "",
        stderr: "No Repository Context selected.\n"
      };
    }

    const createResult = await createRepositoryLabel(
      repositoryResult.target.repository,
      {
        name: parsedFlags.flags.name,
        color: colorResult.color,
        ...(parsedFlags.flags.description === undefined ? {} : { description: parsedFlags.flags.description })
      },
      context
    );

    if (createResult.error !== undefined) {
      return createResult.error;
    }

    return {
      exitCode: 0,
      stdout: "",
      stderr: ""
    };
  }

  if (args[1] === "edit") {
    const parsedFlags = parseLabelEditFlags(args.slice(2));

    if (parsedFlags.error !== undefined) {
      return parsedFlags.error;
    }

    if (parsedFlags.flags.currentName === undefined) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: "Label name is required.\n"
      };
    }

    if (
      parsedFlags.flags.newName === undefined
      && parsedFlags.flags.color === undefined
      && parsedFlags.flags.description === undefined
    ) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: "Specify at least one of --name, --color, or --description.\n"
      };
    }

    let color = parsedFlags.flags.color;

    if (color !== undefined) {
      const colorResult = normalizeLabelColor(color);

      if (colorResult.error !== undefined || colorResult.color === undefined) {
        return colorResult.error;
      }

      color = colorResult.color;
    }

    const repositoryResult = resolveRepositoryCommandTarget(parsedFlags.flags.repository, { mode: "none" }, context);

    if (repositoryResult.error !== undefined || repositoryResult.target?.repository === undefined) {
      return repositoryResult.error ?? {
        exitCode: 1,
        stdout: "",
        stderr: "No Repository Context selected.\n"
      };
    }

    const labelLookupResult = await readRepositoryLabelsForMutation(
      repositoryResult.target.repository,
      parsedFlags.flags.currentName,
      context,
      "edit"
    );

    if (labelLookupResult.error !== undefined || labelLookupResult.labels === undefined) {
      return labelLookupResult.error ?? {
        exitCode: 1,
        stdout: "",
        stderr: `Failed to resolve label "${parsedFlags.flags.currentName}".\n`
      };
    }

    const labelId = buildRepositoryLabelIdLookup(labelLookupResult.labels).get(parsedFlags.flags.currentName);

    if (labelId === undefined) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `Validation failed while editing label "${parsedFlags.flags.currentName}" in ${repositoryResult.target.repository.owner}/${repositoryResult.target.repository.repository}: label "${parsedFlags.flags.currentName}" was not found.\n`
      };
    }

    const editResult = await editRepositoryLabel(
      repositoryResult.target.repository,
      labelId,
      parsedFlags.flags.currentName,
      {
        ...(parsedFlags.flags.newName === undefined ? {} : { name: parsedFlags.flags.newName }),
        ...(color === undefined ? {} : { color }),
        ...(parsedFlags.flags.description === undefined ? {} : { description: parsedFlags.flags.description })
      },
      context
    );

    if (editResult.error !== undefined) {
      return editResult.error;
    }

    return {
      exitCode: 0,
      stdout: "",
      stderr: ""
    };
  }

  if (args[1] === "delete") {
    const parsedFlags = parseLabelDeleteFlags(args.slice(2));

    if (parsedFlags.error !== undefined) {
      return parsedFlags.error;
    }

    if (parsedFlags.flags.name === undefined) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: "Label name is required.\n"
      };
    }

    const repositoryResult = resolveRepositoryCommandTarget(parsedFlags.flags.repository, { mode: "none" }, context);

    if (repositoryResult.error !== undefined || repositoryResult.target?.repository === undefined) {
      return repositoryResult.error ?? {
        exitCode: 1,
        stdout: "",
        stderr: "No Repository Context selected.\n"
      };
    }

    const labelLookupResult = await readRepositoryLabelsForMutation(
      repositoryResult.target.repository,
      parsedFlags.flags.name,
      context,
      "delete"
    );

    if (labelLookupResult.error !== undefined || labelLookupResult.labels === undefined) {
      return labelLookupResult.error ?? {
        exitCode: 1,
        stdout: "",
        stderr: `Failed to resolve label "${parsedFlags.flags.name}".\n`
      };
    }

    const labelId = buildRepositoryLabelIdLookup(labelLookupResult.labels).get(parsedFlags.flags.name);

    if (labelId === undefined) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `Validation failed while deleting label "${parsedFlags.flags.name}" in ${repositoryResult.target.repository.owner}/${repositoryResult.target.repository.repository}: label "${parsedFlags.flags.name}" was not found.\n`
      };
    }

    const deleteResult = await deleteRepositoryLabel(
      repositoryResult.target.repository,
      labelId,
      parsedFlags.flags.name,
      context
    );

    if (deleteResult.error !== undefined) {
      return deleteResult.error;
    }

    return {
      exitCode: 0,
      stdout: "",
      stderr: ""
    };
  }

  if (args[1] !== "list") {
    return undefined;
  }

  const parsedFlags = parseLabelListFlags(args.slice(2));

  if (parsedFlags.error !== undefined) {
    return parsedFlags.error;
  }

  const structuredFlagsError = validateStructuredLabelFlags(parsedFlags.flags);

  if (structuredFlagsError !== undefined) {
    return structuredFlagsError;
  }

  const repositoryResult = resolveRepositoryCommandTarget(parsedFlags.flags.repository, { mode: "none" }, context);

  if (repositoryResult.error !== undefined || repositoryResult.target?.repository === undefined) {
    return repositoryResult.error ?? {
      exitCode: 1,
      stdout: "",
      stderr: "No Repository Context selected.\n"
    };
  }

  const labelResult = await readRepositoryLabels(repositoryResult.target.repository, parsedFlags.flags, context);

  if (labelResult.error !== undefined || labelResult.labels === undefined) {
    return labelResult.error ?? {
      exitCode: 1,
      stdout: "",
      stderr: `Failed to list labels for ${repositoryResult.target.repository.owner}/${repositoryResult.target.repository.repository}.\n`
    };
  }

  if (parsedFlags.flags.jsonFields !== undefined) {
    const structuredOutput = renderStructuredLabelOutput(
      labelResult.labels,
      parsedFlags.flags.jsonFields,
      parsedFlags.flags.jqExpression,
      parsedFlags.flags.template
    );

    if (structuredOutput.error !== undefined || structuredOutput.stdout === undefined) {
      return structuredOutput.error;
    }

    return {
      exitCode: 0,
      stdout: structuredOutput.stdout,
      stderr: ""
    };
  }

  return {
    exitCode: 0,
    stdout: renderLabelList(labelResult.labels),
    stderr: ""
  };
}