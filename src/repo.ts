import { spawnSync } from "node:child_process";

import { CliResult, ResolvedCliExecutionContext } from "./cli-runtime.js";
import { buildHostBaseUrl, buildProcessEnv } from "./host-config.js";
import { type RepositoryContext, resolveOptionalToken, resolveRepositoryContext } from "./repository-context.js";
import { renderStructuredJq, renderStructuredJson, renderStructuredTemplate, type StructuredObject } from "./structured-output.js";
import { ManifestCommand, ManifestGroup, supportManifest } from "./support-manifest.js";

interface ParsedRepoFlags {
  repository?: string;
  jsonFields?: string[];
  jqExpression?: string;
  template?: string;
  destination?: string;
}

interface RepositoryRecord extends StructuredObject {
  name: string;
  owner: string;
  visibility: string;
  url: string;
  description: string | null;
}

interface GiteaRepositoryOwnerPayload {
  login?: string;
}

interface GiteaRepositoryPayload {
  name?: string;
  full_name?: string;
  private?: boolean;
  html_url?: string;
  clone_url?: string;
  description?: string | null;
  owner?: GiteaRepositoryOwnerPayload;
}

const repoGroup = supportManifest.children.find(
  (node): node is ManifestGroup => node.kind === "group" && node.name === "repo"
);
const repoCommands = new Map(
  (repoGroup?.children ?? [])
    .filter((node): node is ManifestCommand => node.kind === "command")
    .map((node) => [node.name, node] as const)
);

function collectSupportedRepoOutputFields(commandName: string): Set<string> {
  return new Set(
    (repoCommands.get(commandName)?.outputFields ?? [])
      .filter((field) => field.status !== "unsupported")
      .map((field) => field.name)
  );
}

const repoViewOutputFields = collectSupportedRepoOutputFields("view");
const repoListOutputFields = collectSupportedRepoOutputFields("list");

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

function parseRepoFlags(
  args: string[],
  options: { allowStructuredOutput: boolean; allowDestination: boolean }
): { flags: ParsedRepoFlags; error?: CliResult } {
  const flags: ParsedRepoFlags = {};

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

    if (options.allowStructuredOutput) {
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

    if (!options.allowDestination || flags.destination !== undefined) {
      return {
        flags,
        error: {
          exitCode: 1,
          stdout: "",
          stderr: `Unexpected argument: ${token}\n`
        }
      };
    }

    flags.destination = token;
  }

  return { flags };
}

function buildRepositoryUrl(repository: RepositoryContext): string {
  return `${buildHostBaseUrl(repository.hostname)}/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repository)}`;
}

function buildRepositoryGitUrl(repository: RepositoryContext): string {
  return `${buildRepositoryUrl(repository)}.git`;
}

function mapRepositoryRecord(repository: RepositoryContext, payload: GiteaRepositoryPayload): RepositoryRecord {
  const owner = typeof payload.owner?.login === "string" && payload.owner.login.length > 0
    ? payload.owner.login
    : repository.owner;
  const name = typeof payload.name === "string" && payload.name.length > 0
    ? payload.name
    : repository.repository;
  const url = typeof payload.html_url === "string" && payload.html_url.length > 0
    ? payload.html_url
    : buildRepositoryUrl({
      ...repository,
      owner,
      repository: name
    });

  return {
    name,
    owner,
    visibility: payload.private === true ? "private" : "public",
    url,
    description: typeof payload.description === "string" ? payload.description : null
  };
}

async function readRepositoryPayload(
  repository: RepositoryContext,
  context: ResolvedCliExecutionContext
): Promise<{ payload?: GiteaRepositoryPayload; error?: CliResult }> {
  const requestUrl = `${buildHostBaseUrl(repository.hostname)}/api/v1/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repository)}`;
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
          stderr: `Repository ${repository.owner}/${repository.repository} was not found on ${repository.hostname}.\n`
        }
      };
    }

    if (!response.ok) {
      return {
        error: {
          exitCode: 1,
          stdout: "",
          stderr: `Gitea returned ${response.status} while reading repository ${repository.owner}/${repository.repository}.\n`
        }
      };
    }

    return {
      payload: await response.json() as GiteaRepositoryPayload
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return {
      error: {
        exitCode: 1,
        stdout: "",
        stderr: `Failed to read repository ${repository.owner}/${repository.repository} from ${repository.hostname}: ${message}\n`
      }
    };
  }
}

async function readRepository(
  repository: RepositoryContext,
  context: ResolvedCliExecutionContext
): Promise<{ repo?: RepositoryRecord; error?: CliResult }> {
  const { payload, error } = await readRepositoryPayload(repository, context);

  if (error !== undefined) {
    return { error };
  }

  if (payload === undefined) {
    return {
      error: {
        exitCode: 1,
        stdout: "",
        stderr: `Failed to read repository ${repository.owner}/${repository.repository}.\n`
      }
    };
  }

  return {
    repo: mapRepositoryRecord(repository, payload)
  };
}

async function readRepositoryList(
  repository: RepositoryContext,
  context: ResolvedCliExecutionContext
): Promise<{ repos?: RepositoryRecord[]; error?: CliResult }> {
  const requestUrl = `${buildHostBaseUrl(repository.hostname)}/api/v1/users/${encodeURIComponent(repository.owner)}/repos`;
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
          stderr: `Gitea returned ${response.status} while listing repositories for ${repository.owner}.\n`
        }
      };
    }

    const payload = await response.json() as GiteaRepositoryPayload[];

    return {
      repos: payload.map((entry) => mapRepositoryRecord(repository, entry))
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return {
      error: {
        exitCode: 1,
        stdout: "",
        stderr: `Failed to list repositories for ${repository.owner} from ${repository.hostname}: ${message}\n`
      }
    };
  }
}

function renderRepository(repo: RepositoryRecord): string {
  const lines = [
    `${repo.owner}/${repo.name}`,
    `Visibility: ${repo.visibility}`,
    `URL: ${repo.url}`
  ];

  if (repo.description !== null && repo.description.length > 0) {
    lines.splice(1, 0, repo.description);
  }

  return `${lines.join("\n")}\n`;
}

function renderRepositoryList(repositories: RepositoryRecord[]): string {
  if (repositories.length === 0) {
    return "No repositories found.\n";
  }

  return `${repositories.map((repo) => `${repo.owner}/${repo.name} [${repo.visibility}]`).join("\n")}\n`;
}

function renderStructuredRepoOutput(
  value: RepositoryRecord | RepositoryRecord[],
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
        stderr: `${renderedOutput.error ?? "Failed to render structured repository output."}\n`
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
          stderr: `${filteredOutput.error ?? "Failed to filter structured repository output."}\n`
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
          stderr: `${templatedOutput.error ?? "Failed to render structured repository template."}\n`
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

function validateStructuredRepoFlags(flags: ParsedRepoFlags): CliResult | undefined {
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

async function resolveCloneSource(
  repository: RepositoryContext,
  context: ResolvedCliExecutionContext
): Promise<{ repo?: RepositoryRecord; cloneUrl?: string; error?: CliResult }> {
  const { payload, error } = await readRepositoryPayload(repository, context);

  if (error !== undefined) {
    return { error };
  }

  if (payload === undefined) {
    return {
      error: {
        exitCode: 1,
        stdout: "",
        stderr: `Failed to resolve a clone source for ${repository.owner}/${repository.repository}.\n`
      }
    };
  }

  const repo = mapRepositoryRecord(repository, payload);
  const cloneUrl = typeof payload.clone_url === "string" && payload.clone_url.length > 0
    ? payload.clone_url
    : buildRepositoryGitUrl({
      ...repository,
      owner: repo.owner,
      repository: repo.name
    });

  return {
    repo,
    cloneUrl
  };
}

function cloneRepository(
  repository: RepositoryContext,
  cloneUrl: string,
  destination: string | undefined,
  context: ResolvedCliExecutionContext
): { stdout?: string; error?: CliResult } {
  const cloneArgs = ["clone", cloneUrl];

  if (destination !== undefined) {
    cloneArgs.push(destination);
  }

  const cloneResult = spawnSync("git", cloneArgs, {
    cwd: context.cwd,
    encoding: "utf8",
    env: buildProcessEnv(context)
  });

  if (cloneResult.status !== 0) {
    const message = cloneResult.stderr.trim().length > 0 ? cloneResult.stderr.trim() : cloneResult.stdout.trim();

    return {
      error: {
        exitCode: 1,
        stdout: "",
        stderr: `Git failed to clone ${repository.owner}/${repository.repository}: ${message}\n`
      }
    };
  }

  const location = destination ?? repository.repository;

  return {
    stdout: `Cloned ${repository.owner}/${repository.repository} into ${location}.\n`
  };
}

export async function executeRepoCommand(args: string[], context: ResolvedCliExecutionContext): Promise<CliResult | undefined> {
  if (args[0] !== "repo") {
    return undefined;
  }

  const subcommand = args[1];

  if (subcommand !== "view" && subcommand !== "list" && subcommand !== "clone") {
    return undefined;
  }

  const { flags, error: flagsError } = parseRepoFlags(args.slice(2), {
    allowStructuredOutput: subcommand !== "clone",
    allowDestination: subcommand === "clone"
  });

  if (flagsError !== undefined) {
    return flagsError;
  }

  const structuredFlagsError = validateStructuredRepoFlags(flags);

  if (structuredFlagsError !== undefined) {
    return structuredFlagsError;
  }

  const { repository, error: repositoryError } = resolveRepositoryContext(flags.repository, context);

  if (repositoryError !== undefined || repository === undefined) {
    return repositoryError ?? {
      exitCode: 1,
      stdout: "",
      stderr: "No Repository Context selected.\n"
    };
  }

  if (subcommand === "view") {
    const { repo, error: repoError } = await readRepository(repository, context);

    if (repoError !== undefined || repo === undefined) {
      return repoError ?? {
        exitCode: 1,
        stdout: "",
        stderr: `Failed to read repository ${repository.owner}/${repository.repository}.\n`
      };
    }

    if (flags.jsonFields !== undefined) {
      const structuredOutput = renderStructuredRepoOutput(
        repo,
        flags.jsonFields,
        repoViewOutputFields,
        flags.jqExpression,
        flags.template
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
      stdout: renderRepository(repo),
      stderr: ""
    };
  }

  if (subcommand === "list") {
    const { repos, error: repoListError } = await readRepositoryList(repository, context);

    if (repoListError !== undefined || repos === undefined) {
      return repoListError ?? {
        exitCode: 1,
        stdout: "",
        stderr: `Failed to list repositories for ${repository.owner}.\n`
      };
    }

    if (flags.jsonFields !== undefined) {
      const structuredOutput = renderStructuredRepoOutput(
        repos,
        flags.jsonFields,
        repoListOutputFields,
        flags.jqExpression,
        flags.template
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
      stdout: renderRepositoryList(repos),
      stderr: ""
    };
  }

  const { repo, cloneUrl, error: cloneSourceError } = await resolveCloneSource(repository, context);

  if (cloneSourceError !== undefined || repo === undefined || cloneUrl === undefined) {
    return cloneSourceError ?? {
      exitCode: 1,
      stdout: "",
      stderr: `Failed to resolve a clone source for ${repository.owner}/${repository.repository}.\n`
    };
  }

  const cloneResult = cloneRepository(
    {
      ...repository,
      owner: repo.owner,
      repository: repo.name
    },
    cloneUrl,
    flags.destination,
    context
  );

  if (cloneResult.error !== undefined || cloneResult.stdout === undefined) {
    return cloneResult.error;
  }

  return {
    exitCode: 0,
    stdout: cloneResult.stdout,
    stderr: ""
  };
}