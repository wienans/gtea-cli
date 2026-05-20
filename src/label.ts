import { CliResult, ResolvedCliExecutionContext } from "./cli-runtime.js";
import { buildHostBaseUrl } from "./host-config.js";
import {
  buildAuthorizationHeaders,
  preferOptionalTokenError,
  resolveOptionalTokenResult,
  resolveRepositoryCommandTarget
} from "./repository-context.js";
import { renderStructuredJq, renderStructuredJson, renderStructuredTemplate, type StructuredObject } from "./structured-output.js";
import { ManifestCommand, ManifestGroup, supportManifest } from "./support-manifest.js";

interface ParsedLabelListFlags {
  repository?: string;
  limit?: number;
  jsonFields?: string[];
  jqExpression?: string;
  template?: string;
}

interface LabelRecord extends StructuredObject {
  color: string | null;
  description: string | null;
  id: number | null;
  name: string | null;
  url: string | null;
}

interface GiteaLabelPayload {
  color?: string | null;
  description?: string | null;
  id?: number;
  name?: string | null;
  url?: string | null;
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

function renderUnsupportedLabelFlag(flag: string, reason: string): CliResult {
  return {
    exitCode: 1,
    stdout: "",
    stderr: `${supportManifest.cliName} label list flag ${flag} is currently unsupported: ${reason}\n`
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
          error: renderUnsupportedLabelFlag(unsupportedFlag.long, unsupportedFlag.reason)
        };
      }
    }

    if (token === "--web" || token === "-w") {
      return {
        flags,
        error: renderUnsupportedLabelFlag(
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

function mapLabelRecord(payload: GiteaLabelPayload | null | undefined): LabelRecord | null {
  if (payload === null || payload === undefined || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }

  return {
    color: typeof payload.color === "string" && payload.color.length > 0 ? payload.color : null,
    description: typeof payload.description === "string" && payload.description.length > 0 ? payload.description : null,
    id: typeof payload.id === "number" ? payload.id : null,
    name: typeof payload.name === "string" && payload.name.length > 0 ? payload.name : null,
    url: typeof payload.url === "string" && payload.url.length > 0 ? payload.url : null
  };
}

async function readRepositoryLabels(
  repository: { hostname: string; owner: string; repository: string },
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
        .map((entry) => mapLabelRecord(entry as GiteaLabelPayload | null | undefined))
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