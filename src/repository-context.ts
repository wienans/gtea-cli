import { spawnSync } from "node:child_process";

import { CliResult, ResolvedCliExecutionContext } from "./cli-runtime.js";
import {
  buildProcessEnv,
  isEligibleHost,
  loadNativeAuthConfig,
  parseHostname,
  type NativeAuthConfig
} from "./host-config.js";

export interface RepositoryContext {
  hostname: string;
  owner: string;
  repository: string;
}

function resolveSelectedHost(context: ResolvedCliExecutionContext, config: NativeAuthConfig): string | undefined {
  const envHost = parseHostname(context.env.GTEA_HOST) ?? parseHostname(context.env.GH_HOST);

  return envHost ?? config.activeHost ?? Object.keys(config.hosts).sort()[0];
}

function parseRepositoryTarget(rawRepository: string, context: ResolvedCliExecutionContext): { repository?: RepositoryContext; error?: CliResult } {
  const segments = rawRepository.split("/");

  if (segments.length !== 2 && segments.length !== 3) {
    return {
      error: {
        exitCode: 1,
        stdout: "",
        stderr: `Invalid value for -R: ${rawRepository}\n`
      }
    };
  }

  const config = loadNativeAuthConfig(context);
  const [explicitHost, owner, repository] = segments.length === 3 ? segments : [undefined, segments[0], segments[1]];

  if (owner === undefined || repository === undefined || owner.length === 0 || repository.length === 0) {
    return {
      error: {
        exitCode: 1,
        stdout: "",
        stderr: `Invalid value for -R: ${rawRepository}\n`
      }
    };
  }

  const hostname = explicitHost === undefined ? resolveSelectedHost(context, config) : parseHostname(explicitHost);

  if (hostname === undefined) {
    return {
      error: {
        exitCode: 1,
        stdout: "",
        stderr: "No Gitea Host selected. Pass -R HOST/OWNER/REPO or set GTEA_HOST/GH_HOST.\n"
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

  return {
    repository: {
      hostname,
      owner,
      repository: repository.replace(/\.git$/i, "")
    }
  };
}

function parseRemotePath(hostname: string, rawPath: string): RepositoryContext | undefined {
  const normalizedHost = parseHostname(hostname);
  const normalizedPath = rawPath.replace(/^\/+/, "").replace(/\.git$/i, "");
  const segments = normalizedPath.split("/");

  if (normalizedHost === undefined || segments.length !== 2) {
    return undefined;
  }

  const [owner, repository] = segments;

  if (owner === undefined || repository === undefined || owner.length === 0 || repository.length === 0) {
    return undefined;
  }

  return {
    hostname: normalizedHost,
    owner,
    repository
  };
}

function parseGitRemote(rawRemote: string): RepositoryContext | undefined {
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(rawRemote)) {
    try {
      const remoteUrl = new URL(rawRemote);
      const hostname = remoteUrl.port.length > 0 ? `${remoteUrl.hostname}:${remoteUrl.port}` : remoteUrl.hostname;

      return parseRemotePath(hostname, remoteUrl.pathname);
    } catch {
      return undefined;
    }
  }

  const scpLikeMatch = rawRemote.match(/^(?:[^@]+@)?([^:]+):(.+)$/);

  if (scpLikeMatch === null) {
    return undefined;
  }

  const [, hostname, remotePath] = scpLikeMatch;

  if (hostname === undefined || remotePath === undefined) {
    return undefined;
  }

  return parseRemotePath(hostname, remotePath);
}

function resolveRepositoryFromGit(context: ResolvedCliExecutionContext): { repository?: RepositoryContext; error?: CliResult } {
  const remoteResult = spawnSync("git", ["config", "--get", "remote.origin.url"], {
    cwd: context.cwd,
    encoding: "utf8",
    env: buildProcessEnv(context)
  });

  if (remoteResult.status !== 0 || remoteResult.stdout.trim().length === 0) {
    return {
      error: {
        exitCode: 1,
        stdout: "",
        stderr: "No Repository Context selected. Pass -R or run from a Git repository.\n"
      }
    };
  }

  const repository = parseGitRemote(remoteResult.stdout.trim());

  if (repository === undefined) {
    return {
      error: {
        exitCode: 1,
        stdout: "",
        stderr: `Could not derive a Repository Context from ${remoteResult.stdout.trim()}.\n`
      }
    };
  }

  if (!isEligibleHost(repository.hostname)) {
    return {
      error: {
        exitCode: 1,
        stdout: "",
        stderr: `Host ${repository.hostname} is not an Eligible Host for gtea.\n`
      }
    };
  }

  return { repository };
}

export function resolveRepositoryContext(
  rawRepository: string | undefined,
  context: ResolvedCliExecutionContext
): { repository?: RepositoryContext; error?: CliResult } {
  if (rawRepository !== undefined) {
    return parseRepositoryTarget(rawRepository, context);
  }

  return resolveRepositoryFromGit(context);
}

export function resolveOptionalToken(hostname: string, context: ResolvedCliExecutionContext): string | undefined {
  const nativeConfig = loadNativeAuthConfig(context);
  const envHost = parseHostname(context.env.GTEA_HOST) ?? parseHostname(context.env.GH_HOST);

  if (envHost === hostname) {
    return context.env.GTEA_TOKEN ?? context.env.GH_TOKEN;
  }

  return nativeConfig.hosts[hostname]?.token;
}