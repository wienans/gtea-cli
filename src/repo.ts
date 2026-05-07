import { spawnSync } from "node:child_process";

import { CliResult, ResolvedCliExecutionContext } from "./cli-runtime.js";
import { buildHostBaseUrl, buildProcessEnv, isEligibleHost, loadNativeAuthConfig, parseHostname } from "./host-config.js";
import {
  buildAuthorizationHeaders,
  preferOptionalTokenError,
  type RepositoryContext,
  resolveOptionalTokenResult,
  resolveRequiredTokenResult,
  resolveRepositoryContext
} from "./repository-context.js";
import { renderStructuredJq, renderStructuredJson, renderStructuredTemplate, type StructuredObject } from "./structured-output.js";
import { ManifestCommand, ManifestGroup, supportManifest } from "./support-manifest.js";

interface ParsedRepoFlags {
  repository?: string;
  jsonFields?: string[];
  jqExpression?: string;
  template?: string;
  destination?: string;
}

interface ParsedRepoCreateFlags {
  name?: string;
  visibility?: "public" | "private";
  description?: string;
  clone: boolean;
}

interface ParsedRepoRenameFlags {
  repository?: string;
  newName?: string;
}

interface ParsedRepoForkFlags {
  repository?: string;
  forkName?: string;
  organization?: string;
  clone: boolean;
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

interface RepoCreateTarget {
  hostname: string;
  owner?: string;
  repository: string;
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

function renderUnsupportedRepoFlag(subcommand: string, flag: string, reason: string): CliResult {
  return {
    exitCode: 1,
    stdout: "",
    stderr: `${supportManifest.cliName} repo ${subcommand} flag ${flag} is currently unsupported: ${reason}\n`
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

function parseRepoCreateFlags(args: string[]): { flags: ParsedRepoCreateFlags; error?: CliResult } {
  const flags: ParsedRepoCreateFlags = {
    clone: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];

    if (token === undefined) {
      break;
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

    if (token === "--clone" || token === "-c") {
      flags.clone = true;
      continue;
    }

    if (token === "--private") {
      if (flags.visibility === "public") {
        return {
          flags,
          error: {
            exitCode: 1,
            stdout: "",
            stderr: "Choose at most one of --public and --private.\n"
          }
        };
      }

      flags.visibility = "private";
      continue;
    }

    if (token === "--public") {
      if (flags.visibility === "private") {
        return {
          flags,
          error: {
            exitCode: 1,
            stdout: "",
            stderr: "Choose at most one of --public and --private.\n"
          }
        };
      }

      flags.visibility = "public";
      continue;
    }

    if (token === "--add-readme") {
      return {
        flags,
        error: renderUnsupportedRepoFlag(
          "create",
          "--add-readme",
          "Repository template materialization is not part of the supported repository administration slice."
        )
      };
    }

    if (token === "--disable-issues") {
      return {
        flags,
        error: renderUnsupportedRepoFlag(
          "create",
          "--disable-issues",
          "Issue tracker policy toggles are not part of the supported repository administration slice."
        )
      };
    }

    if (token === "--disable-wiki") {
      return {
        flags,
        error: renderUnsupportedRepoFlag(
          "create",
          "--disable-wiki",
          "Wiki policy toggles are not part of the supported repository administration slice."
        )
      };
    }

    if (token === "--include-all-branches") {
      return {
        flags,
        error: renderUnsupportedRepoFlag(
          "create",
          "--include-all-branches",
          "Template branch expansion is not part of the supported repository administration slice."
        )
      };
    }

    if (token === "--internal") {
      return {
        flags,
        error: renderUnsupportedRepoFlag(
          "create",
          "--internal",
          "Internal visibility is not part of the supported repository administration slice."
        )
      };
    }

    const unsupportedStringFlags = [
      {
        long: "--gitignore",
        short: "-g",
        reason: "Repository template materialization is not part of the supported repository administration slice."
      },
      {
        long: "--homepage",
        short: "-h",
        reason: "Homepage configuration is not part of the supported repository administration slice."
      },
      {
        long: "--license",
        short: "-l",
        reason: "Repository template materialization is not part of the supported repository administration slice."
      },
      {
        long: "--remote",
        short: "-r",
        reason: "Remote naming for source-driven repository creation is not part of the supported repository administration slice."
      },
      {
        long: "--source",
        short: "-s",
        reason: "Creating a remote repository from a local source checkout is not part of the supported repository administration slice."
      },
      {
        long: "--team",
        short: "-t",
        reason: "Organization team assignment is not part of the supported repository administration slice."
      },
      {
        long: "--template",
        short: "-p",
        reason: "Template repository creation is not part of the supported repository administration slice."
      }
    ] as const;

    for (const unsupportedFlag of unsupportedStringFlags) {
      const unsupportedValue = parseStringFlagValue(args, index, {
        long: unsupportedFlag.long,
        short: unsupportedFlag.short
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
          error: renderUnsupportedRepoFlag("create", unsupportedFlag.long, unsupportedFlag.reason)
        };
      }
    }

    if (token === "--push") {
      return {
        flags,
        error: renderUnsupportedRepoFlag(
          "create",
          "--push",
          "Pushing local refs during repository creation is not part of the supported repository administration slice."
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

    if (flags.name !== undefined) {
      return {
        flags,
        error: {
          exitCode: 1,
          stdout: "",
          stderr: `Unexpected argument: ${token}\n`
        }
      };
    }

    flags.name = token;
  }

  return { flags };
}

function parseRepoRenameFlags(args: string[]): { flags: ParsedRepoRenameFlags; error?: CliResult } {
  const flags: ParsedRepoRenameFlags = {};

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

    if (flags.newName !== undefined) {
      return {
        flags,
        error: {
          exitCode: 1,
          stdout: "",
          stderr: `Unexpected argument: ${token}\n`
        }
      };
    }

    flags.newName = token;
  }

  return { flags };
}

function parseRepoForkFlags(args: string[]): { flags: ParsedRepoForkFlags; error?: CliResult } {
  const flags: ParsedRepoForkFlags = {
    clone: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];

    if (token === undefined) {
      break;
    }

    const forkNameFlag = parseStringFlagValue(args, index, { long: "--fork-name" });

    if (forkNameFlag.error !== undefined) {
      return {
        flags,
        error: forkNameFlag.error
      };
    }

    if (forkNameFlag.handled && forkNameFlag.value !== undefined) {
      flags.forkName = forkNameFlag.value;
      index = forkNameFlag.nextIndex;
      continue;
    }

    const organizationFlag = parseStringFlagValue(args, index, { long: "--org" });

    if (organizationFlag.error !== undefined) {
      return {
        flags,
        error: organizationFlag.error
      };
    }

    if (organizationFlag.handled && organizationFlag.value !== undefined) {
      flags.organization = organizationFlag.value;
      index = organizationFlag.nextIndex;
      continue;
    }

    const remoteNameFlag = parseStringFlagValue(args, index, { long: "--remote-name" });

    if (remoteNameFlag.error !== undefined) {
      return {
        flags,
        error: remoteNameFlag.error
      };
    }

    if (remoteNameFlag.handled) {
      return {
        flags,
        error: renderUnsupportedRepoFlag(
          "fork",
          "--remote-name",
          "Git remote rewriting is not part of the supported repository administration slice."
        )
      };
    }

    if (token === "--clone") {
      flags.clone = true;
      continue;
    }

    if (token === "--default-branch-only") {
      return {
        flags,
        error: renderUnsupportedRepoFlag(
          "fork",
          "--default-branch-only",
          "Selective branch transfer is not part of the supported repository administration slice."
        )
      };
    }

    if (token === "--remote") {
      return {
        flags,
        error: renderUnsupportedRepoFlag(
          "fork",
          "--remote",
          "Git remote rewriting is not part of the supported repository administration slice."
        )
      };
    }

    if (token === "--") {
      return {
        flags,
        error: renderUnsupportedRepoFlag(
          "fork",
          "--",
          "Passing raw git clone flags after -- is not part of the supported repository administration slice."
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

    if (flags.repository !== undefined) {
      return {
        flags,
        error: {
          exitCode: 1,
          stdout: "",
          stderr: `Unexpected argument: ${token}\n`
        }
      };
    }

    flags.repository = token;
  }

  return { flags };
}

function parseRepoCreateName(rawName: string): { owner?: string; repository?: string; error?: CliResult } {
  const segments = rawName.split("/");

  if (segments.length === 1) {
    const repository = segments[0];

    if (repository === undefined || repository.length === 0) {
      return {
        error: {
          exitCode: 1,
          stdout: "",
          stderr: `Invalid repository name: ${rawName}\n`
        }
      };
    }

    return { repository };
  }

  if (segments.length === 2) {
    const [owner, repository] = segments;

    if (owner === undefined || repository === undefined || owner.length === 0 || repository.length === 0) {
      return {
        error: {
          exitCode: 1,
          stdout: "",
          stderr: `Invalid repository name: ${rawName}\n`
        }
      };
    }

    return {
      owner,
      repository
    };
  }

  return {
    error: {
      exitCode: 1,
      stdout: "",
      stderr: `Invalid repository name: ${rawName}\n`
    }
  };
}

function resolveSelectedRepoHost(context: ResolvedCliExecutionContext): { hostname?: string; error?: CliResult } {
  const config = loadNativeAuthConfig(context);

  if (config.error !== undefined) {
    return {
      error: config.error
    };
  }

  const envHost = parseHostname(context.env.GTEA_HOST) ?? parseHostname(context.env.GH_HOST);
  const hostname = envHost ?? config.activeHost ?? Object.keys(config.hosts).sort()[0];

  if (hostname === undefined) {
    return {
      error: {
        exitCode: 1,
        stdout: "",
        stderr: "No Gitea Host selected. Set GTEA_HOST/GH_HOST or run gtea auth login.\n"
      }
    };
  }

  if (!isEligibleHost(hostname)) {
    return {
      error: {
        exitCode: 1,
        stdout: "",
        stderr: `Host ${hostname} is not an Eligible Host for gtea.\n`
      }
    };
  }

  return { hostname };
}

function resolveRequiredRepoToken(
  hostname: string,
  subcommand: "create" | "rename" | "fork",
  context: ResolvedCliExecutionContext
): { token: string } | { error: CliResult } {
  return resolveRequiredTokenResult(hostname, context, {
    exitCode: 1,
    stdout: "",
    stderr: `gtea repo ${subcommand} requires an authenticated host credential. Run gtea auth login or set GTEA_TOKEN/GH_TOKEN.\n`
  });
}

async function readGiteaErrorMessage(response: Response): Promise<string | undefined> {
  try {
    const payload = await response.json() as { message?: string };

    return typeof payload.message === "string" && payload.message.length > 0 ? payload.message : undefined;
  } catch {
    return undefined;
  }
}

async function resolveAuthenticatedRepoUserLogin(
  hostname: string,
  token: string
): Promise<{ login: string } | { error: CliResult }> {
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
          stderr: `Authentication failed while reading the active user on ${hostname}.\n`
        }
      };
    }

    if (!response.ok) {
      return {
        error: {
          exitCode: 1,
          stdout: "",
          stderr: `Gitea returned ${response.status} while reading the active user on ${hostname}.\n`
        }
      };
    }

    const payload = await response.json() as GiteaRepositoryOwnerPayload;

    if (typeof payload.login !== "string" || payload.login.length === 0) {
      return {
        error: {
          exitCode: 1,
          stdout: "",
          stderr: `Gitea did not return a login for the active user on ${hostname}.\n`
        }
      };
    }

    return {
      login: payload.login
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return {
      error: {
        exitCode: 1,
        stdout: "",
        stderr: `Failed to read the active user from ${hostname}: ${message}\n`
      }
    };
  }
}

async function createRepository(
  target: RepoCreateTarget,
  visibility: "public" | "private",
  description: string | undefined,
  context: ResolvedCliExecutionContext
): Promise<{ repo?: RepositoryRecord; cloneUrl?: string; error?: CliResult }> {
  const tokenResult = resolveRequiredRepoToken(target.hostname, "create", context);

  if ("error" in tokenResult) {
    return { error: tokenResult.error };
  }

  const currentUserResult = await resolveAuthenticatedRepoUserLogin(target.hostname, tokenResult.token);

  if ("error" in currentUserResult) {
    return { error: currentUserResult.error };
  }

  const owner = target.owner ?? currentUserResult.login;
  const requestUrl = owner === currentUserResult.login
    ? `${buildHostBaseUrl(target.hostname)}/api/v1/user/repos`
    : `${buildHostBaseUrl(target.hostname)}/api/v1/orgs/${encodeURIComponent(owner)}/repos`;
  const requestBody: Record<string, string | boolean> = {
    name: target.repository,
    private: visibility === "private"
  };

  if (description !== undefined) {
    requestBody.description = description;
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
          stderr: `Authentication failed while creating a repository on ${target.hostname}.\n`
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
            ? `Validation failed while creating repository ${owner}/${target.repository}.\n`
            : `Validation failed while creating repository ${owner}/${target.repository}: ${validationMessage}\n`
        }
      };
    }

    if (!response.ok) {
      return {
        error: {
          exitCode: 1,
          stdout: "",
          stderr: `Gitea returned ${response.status} while creating repository ${owner}/${target.repository}.\n`
        }
      };
    }

    const repository = {
      hostname: target.hostname,
      owner,
      repository: target.repository
    };
    const payload = await response.json() as GiteaRepositoryPayload;
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
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return {
      error: {
        exitCode: 1,
        stdout: "",
        stderr: `Failed to create repository ${owner}/${target.repository} on ${target.hostname}: ${message}\n`
      }
    };
  }
}

async function renameRepository(
  repository: RepositoryContext,
  newName: string,
  context: ResolvedCliExecutionContext
): Promise<{ repo?: RepositoryRecord; error?: CliResult }> {
  const tokenResult = resolveRequiredRepoToken(repository.hostname, "rename", context);

  if ("error" in tokenResult) {
    return { error: tokenResult.error };
  }

  try {
    const response = await fetch(
      `${buildHostBaseUrl(repository.hostname)}/api/v1/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repository)}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `token ${tokenResult.token}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({ name: newName })
      }
    );

    if (response.status === 401 || response.status === 403) {
      return {
        error: {
          exitCode: 1,
          stdout: "",
          stderr: `Authentication failed while renaming repository ${repository.owner}/${repository.repository} on ${repository.hostname}.\n`
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
            ? `Validation failed while renaming repository ${repository.owner}/${repository.repository}.\n`
            : `Validation failed while renaming repository ${repository.owner}/${repository.repository}: ${validationMessage}\n`
        }
      };
    }

    if (!response.ok) {
      return {
        error: {
          exitCode: 1,
          stdout: "",
          stderr: `Gitea returned ${response.status} while renaming repository ${repository.owner}/${repository.repository}.\n`
        }
      };
    }

    return {
      repo: mapRepositoryRecord(
        {
          ...repository,
          repository: newName
        },
        await response.json() as GiteaRepositoryPayload
      )
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return {
      error: {
        exitCode: 1,
        stdout: "",
        stderr: `Failed to rename repository ${repository.owner}/${repository.repository} on ${repository.hostname}: ${message}\n`
      }
    };
  }
}

async function forkRepository(
  repository: RepositoryContext,
  options: { forkName?: string; organization?: string },
  context: ResolvedCliExecutionContext
): Promise<{ repo?: RepositoryRecord; cloneUrl?: string; error?: CliResult }> {
  const tokenResult = resolveRequiredRepoToken(repository.hostname, "fork", context);

  if ("error" in tokenResult) {
    return { error: tokenResult.error };
  }

  const currentUserResult = await resolveAuthenticatedRepoUserLogin(repository.hostname, tokenResult.token);

  if ("error" in currentUserResult) {
    return { error: currentUserResult.error };
  }

  const owner = options.organization ?? currentUserResult.login;
  const requestBody: Record<string, string> = {};

  if (options.forkName !== undefined) {
    requestBody.name = options.forkName;
  }

  if (options.organization !== undefined) {
    requestBody.organization = options.organization;
  }

  try {
    const response = await fetch(
      `${buildHostBaseUrl(repository.hostname)}/api/v1/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repository)}/forks`,
      {
        method: "POST",
        headers: {
          Authorization: `token ${tokenResult.token}`,
          "content-type": "application/json"
        },
        body: JSON.stringify(requestBody)
      }
    );

    if (response.status === 401 || response.status === 403) {
      return {
        error: {
          exitCode: 1,
          stdout: "",
          stderr: `Authentication failed while forking repository ${repository.owner}/${repository.repository} on ${repository.hostname}.\n`
        }
      };
    }

    if (response.status === 400 || response.status === 409 || response.status === 422) {
      const validationMessage = await readGiteaErrorMessage(response);

      return {
        error: {
          exitCode: 1,
          stdout: "",
          stderr: validationMessage === undefined
            ? `Validation failed while forking repository ${repository.owner}/${repository.repository}.\n`
            : `Validation failed while forking repository ${repository.owner}/${repository.repository}: ${validationMessage}\n`
        }
      };
    }

    if (!response.ok) {
      return {
        error: {
          exitCode: 1,
          stdout: "",
          stderr: `Gitea returned ${response.status} while forking repository ${repository.owner}/${repository.repository}.\n`
        }
      };
    }

    const targetRepository = {
      hostname: repository.hostname,
      owner,
      repository: options.forkName ?? repository.repository
    };
    const payload = await response.json() as GiteaRepositoryPayload;
    const repo = mapRepositoryRecord(targetRepository, payload);
    const cloneUrl = typeof payload.clone_url === "string" && payload.clone_url.length > 0
      ? payload.clone_url
      : buildRepositoryGitUrl({
        ...targetRepository,
        owner: repo.owner,
        repository: repo.name
      });

    return {
      repo,
      cloneUrl
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return {
      error: {
        exitCode: 1,
        stdout: "",
        stderr: `Failed to fork repository ${repository.owner}/${repository.repository} on ${repository.hostname}: ${message}\n`
      }
    };
  }
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
  const tokenResult = resolveOptionalTokenResult(repository.hostname, context);
  const headers = buildAuthorizationHeaders(tokenResult.token);

  try {
    const response = await fetch(requestUrl, headers === undefined ? undefined : { headers });

    if (response.status === 404) {
      return {
        error: preferOptionalTokenError(tokenResult, {
          exitCode: 1,
          stdout: "",
          stderr: `Repository ${repository.owner}/${repository.repository} was not found on ${repository.hostname}.\n`
        })
      };
    }

    if (!response.ok) {
      return {
        error: preferOptionalTokenError(tokenResult, {
          exitCode: 1,
          stdout: "",
          stderr: `Gitea returned ${response.status} while reading repository ${repository.owner}/${repository.repository}.\n`
        })
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
  const tokenResult = resolveOptionalTokenResult(repository.hostname, context);
  const headers = buildAuthorizationHeaders(tokenResult.token);

  try {
    const response = await fetch(requestUrl, headers === undefined ? undefined : { headers });

    if (!response.ok) {
      return {
        error: preferOptionalTokenError(tokenResult, {
          exitCode: 1,
          stdout: "",
          stderr: `Gitea returned ${response.status} while listing repositories for ${repository.owner}.\n`
        })
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

  if (subcommand !== "view" && subcommand !== "list" && subcommand !== "clone" && subcommand !== "create" && subcommand !== "rename" && subcommand !== "fork") {
    return undefined;
  }

  if (subcommand === "create") {
    const parsedCreateFlags = parseRepoCreateFlags(args.slice(2));

    if (parsedCreateFlags.error !== undefined) {
      return parsedCreateFlags.error;
    }

    if (parsedCreateFlags.flags.name === undefined) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: "Repository name is required.\n"
      };
    }

    if (parsedCreateFlags.flags.visibility === undefined) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: "Pass one of --public or --private.\n"
      };
    }

    const selectedHostResult = resolveSelectedRepoHost(context);

    if (selectedHostResult.error !== undefined || selectedHostResult.hostname === undefined) {
      return selectedHostResult.error;
    }

    const parsedName = parseRepoCreateName(parsedCreateFlags.flags.name);

    if (parsedName.error !== undefined || parsedName.repository === undefined) {
      return parsedName.error;
    }

    const createTarget: RepoCreateTarget = {
      hostname: selectedHostResult.hostname,
      repository: parsedName.repository
    };

    if (parsedName.owner !== undefined) {
      createTarget.owner = parsedName.owner;
    }

    const createResult = await createRepository(
      createTarget,
      parsedCreateFlags.flags.visibility,
      parsedCreateFlags.flags.description,
      context
    );

    if (createResult.error !== undefined || createResult.repo === undefined) {
      return createResult.error ?? {
        exitCode: 1,
        stdout: "",
        stderr: `Failed to create repository ${parsedCreateFlags.flags.name}.\n`
      };
    }

    if (parsedCreateFlags.flags.clone) {
      const cloneResult = cloneRepository(
        {
          hostname: selectedHostResult.hostname,
          owner: createResult.repo.owner,
          repository: createResult.repo.name
        },
        createResult.cloneUrl ?? buildRepositoryGitUrl({
          hostname: selectedHostResult.hostname,
          owner: createResult.repo.owner,
          repository: createResult.repo.name
        }),
        createResult.repo.name,
        context
      );

      if (cloneResult.error !== undefined) {
        return cloneResult.error;
      }
    }

    return {
      exitCode: 0,
      stdout: `${createResult.repo.url}\n`,
      stderr: ""
    };
  }

  if (subcommand === "rename") {
    const parsedRenameFlags = parseRepoRenameFlags(args.slice(2));

    if (parsedRenameFlags.error !== undefined) {
      return parsedRenameFlags.error;
    }

    if (parsedRenameFlags.flags.newName === undefined) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: "New repository name is required.\n"
      };
    }

    const repositoryResult = resolveRepositoryContext(parsedRenameFlags.flags.repository, context);

    if (repositoryResult.error !== undefined || repositoryResult.repository === undefined) {
      return repositoryResult.error ?? {
        exitCode: 1,
        stdout: "",
        stderr: "No Repository Context selected.\n"
      };
    }

    const renameResult = await renameRepository(repositoryResult.repository, parsedRenameFlags.flags.newName, context);

    if (renameResult.error !== undefined || renameResult.repo === undefined) {
      return renameResult.error ?? {
        exitCode: 1,
        stdout: "",
        stderr: `Failed to rename repository ${repositoryResult.repository.owner}/${repositoryResult.repository.repository}.\n`
      };
    }

    return {
      exitCode: 0,
      stdout: `${renameResult.repo.url}\n`,
      stderr: ""
    };
  }

  if (subcommand === "fork") {
    const parsedForkFlags = parseRepoForkFlags(args.slice(2));

    if (parsedForkFlags.error !== undefined) {
      return parsedForkFlags.error;
    }

    const repositoryResult = resolveRepositoryContext(parsedForkFlags.flags.repository, context);

    if (repositoryResult.error !== undefined || repositoryResult.repository === undefined) {
      return repositoryResult.error ?? {
        exitCode: 1,
        stdout: "",
        stderr: "No Repository Context selected.\n"
      };
    }

    const forkOptions: { forkName?: string; organization?: string } = {};

    if (parsedForkFlags.flags.forkName !== undefined) {
      forkOptions.forkName = parsedForkFlags.flags.forkName;
    }

    if (parsedForkFlags.flags.organization !== undefined) {
      forkOptions.organization = parsedForkFlags.flags.organization;
    }

    const forkResult = await forkRepository(repositoryResult.repository, forkOptions, context);

    if (forkResult.error !== undefined || forkResult.repo === undefined) {
      return forkResult.error ?? {
        exitCode: 1,
        stdout: "",
        stderr: `Failed to fork repository ${repositoryResult.repository.owner}/${repositoryResult.repository.repository}.\n`
      };
    }

    if (parsedForkFlags.flags.clone) {
      const cloneResult = cloneRepository(
        {
          hostname: repositoryResult.repository.hostname,
          owner: forkResult.repo.owner,
          repository: forkResult.repo.name
        },
        forkResult.cloneUrl ?? buildRepositoryGitUrl({
          hostname: repositoryResult.repository.hostname,
          owner: forkResult.repo.owner,
          repository: forkResult.repo.name
        }),
        forkResult.repo.name,
        context
      );

      if (cloneResult.error !== undefined) {
        return cloneResult.error;
      }
    }

    return {
      exitCode: 0,
      stdout: `${forkResult.repo.url}\n`,
      stderr: ""
    };
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