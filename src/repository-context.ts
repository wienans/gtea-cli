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

export type CredentialResolutionPolicy =
  | { mode: "none" }
  | { mode: "optional" }
  | { mode: "required"; missingCredentialError: CliResult };

export type CredentialSource = "GTEA_TOKEN environment variable" | "GH_TOKEN environment variable" | "native config store";

export interface ResolvedHostCredential {
  token: string;
  source: CredentialSource;
}

export interface ResolvedHostCommandTarget {
  hostname: string;
  credential?: ResolvedHostCredential;
}

export interface ResolvedRepositoryCommandTarget {
  repository: RepositoryContext;
  credential?: ResolvedHostCredential;
}

export interface ResolvedTokenResult {
  token?: string;
  error?: CliResult;
}

type RequiredTokenResult = { token: string } | { error: CliResult };
type HostResolutionResult = { hostname?: string; error?: CliResult };
type CredentialResolutionResult = { credential?: ResolvedHostCredential; error?: CliResult };
type LoadedConfigResult = { config?: NativeAuthConfig; error?: CliResult };

const noCredentialPolicy: CredentialResolutionPolicy = { mode: "none" };
const optionalCredentialPolicy: CredentialResolutionPolicy = { mode: "optional" };

function parseProvidedHostname(rawValue: string | undefined, source: string): HostResolutionResult {
  if (rawValue === undefined) {
    return {};
  }

  const hostname = parseHostname(rawValue);

  if (hostname === undefined) {
    return {
      error: {
        exitCode: 1,
        stdout: "",
        stderr: `Invalid value for ${source}: ${rawValue}\n`
      }
    };
  }

  return { hostname };
}

function resolveEnvironmentHost(
  context: ResolvedCliExecutionContext,
  options: { strict: boolean }
): HostResolutionResult {
  if (options.strict) {
    if (context.env.GTEA_HOST !== undefined) {
      return parseProvidedHostname(context.env.GTEA_HOST, "GTEA_HOST");
    }

    if (context.env.GH_HOST !== undefined) {
      return parseProvidedHostname(context.env.GH_HOST, "GH_HOST");
    }

    return {};
  }

  return {
    ...(parseHostname(context.env.GTEA_HOST) ?? parseHostname(context.env.GH_HOST)) as string | undefined extends never ? {} : {}
  };
}

function resolveLenientEnvironmentHost(context: ResolvedCliExecutionContext): HostResolutionResult {
  const hostname = parseHostname(context.env.GTEA_HOST) ?? parseHostname(context.env.GH_HOST);

  return {
    ...(hostname === undefined ? {} : { hostname })
  };
}

function resolveStoredHost(config: NativeAuthConfig): string | undefined {
  return config.activeHost ?? Object.keys(config.hosts).sort()[0];
}

function loadConfig(context: ResolvedCliExecutionContext): LoadedConfigResult {
  const config = loadNativeAuthConfig(context);

  if (config.error !== undefined) {
    return {
      error: config.error
    };
  }

  return { config };
}

function ensureEligibleHost(hostname: string): HostResolutionResult {
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

function resolveUnscopedEnvironmentCredential(context: ResolvedCliExecutionContext): ResolvedHostCredential | undefined {
  if (context.env.GTEA_TOKEN !== undefined) {
    return {
      token: context.env.GTEA_TOKEN,
      source: "GTEA_TOKEN environment variable"
    };
  }

  if (context.env.GH_TOKEN !== undefined) {
    return {
      token: context.env.GH_TOKEN,
      source: "GH_TOKEN environment variable"
    };
  }

  return undefined;
}

function resolveScopedEnvironmentCredential(
  hostname: string,
  context: ResolvedCliExecutionContext
): ResolvedHostCredential | undefined {
  const envHost = parseHostname(context.env.GTEA_HOST) ?? parseHostname(context.env.GH_HOST);

  if (envHost !== hostname) {
    return undefined;
  }

  return resolveUnscopedEnvironmentCredential(context);
}

function resolveCredentialForHost(
  hostname: string,
  credentialPolicy: CredentialResolutionPolicy,
  context: ResolvedCliExecutionContext,
  options: { scopeEnvironmentTokenToHost: boolean },
  config?: NativeAuthConfig
): CredentialResolutionResult {
  if (credentialPolicy.mode === "none") {
    return {};
  }

  const environmentCredential = options.scopeEnvironmentTokenToHost
    ? resolveScopedEnvironmentCredential(hostname, context)
    : resolveUnscopedEnvironmentCredential(context);

  if (environmentCredential !== undefined) {
    return {
      credential: environmentCredential
    };
  }

  let resolvedConfig = config;

  if (resolvedConfig === undefined) {
    const configResult = loadConfig(context);

    if (configResult.error !== undefined || configResult.config === undefined) {
      return {
        error: configResult.error ?? {
          exitCode: 1,
          stdout: "",
          stderr: "Could not read the native auth config.\n"
        }
      };
    }

    resolvedConfig = configResult.config;
  }

  const storedToken = resolvedConfig.hosts[hostname]?.token;

  if (storedToken === undefined) {
    if (credentialPolicy.mode === "required") {
      return {
        error: credentialPolicy.missingCredentialError
      };
    }

    return {};
  }

  return {
    credential: {
      token: storedToken,
      source: "native config store"
    }
  };
}

function resolveSelectedHostForCommand(
  explicitHostname: string | undefined,
  context: ResolvedCliExecutionContext,
  options: { explicitHostnameSource: string; strictEnvironmentHost: boolean; missingHostError: CliResult }
): { hostname?: string; config?: NativeAuthConfig; error?: CliResult } {
  const explicitHost = parseProvidedHostname(explicitHostname, options.explicitHostnameSource);

  if (explicitHost.error !== undefined) {
    return {
      error: explicitHost.error
    };
  }

  let hostname = explicitHost.hostname;

  if (hostname === undefined) {
    const environmentHost = options.strictEnvironmentHost
      ? resolveEnvironmentHost(context, { strict: true })
      : resolveLenientEnvironmentHost(context);

    if (environmentHost.error !== undefined) {
      return {
        error: environmentHost.error
      };
    }

    hostname = environmentHost.hostname;
  }

  let config: NativeAuthConfig | undefined;

  if (hostname === undefined) {
    const configResult = loadConfig(context);

    if (configResult.error !== undefined || configResult.config === undefined) {
      return {
        error: configResult.error ?? {
          exitCode: 1,
          stdout: "",
          stderr: "Could not read the native auth config.\n"
        }
      };
    }

    config = configResult.config;
    hostname = resolveStoredHost(config);
  }

  if (hostname === undefined) {
    return {
      error: options.missingHostError,
      ...(config === undefined ? {} : { config })
    };
  }

  const eligibleHost = ensureEligibleHost(hostname);

  if (eligibleHost.error !== undefined) {
    return {
      error: eligibleHost.error,
      ...(config === undefined ? {} : { config })
    };
  }

  return {
    hostname,
    ...(config === undefined ? {} : { config })
  };
}

function parseRepositoryTargetParts(
  rawRepository: string
): { owner?: string; repository?: string; explicitHost?: string; error?: CliResult } {
  const segments = rawRepository.split("/");

  if (segments.length < 2) {
    return {
      error: {
        exitCode: 1,
        stdout: "",
        stderr: `Invalid value for -R: ${rawRepository}\n`
      }
    };
  }

  const repository = segments.at(-1);
  const owner = segments.at(-2);
  const explicitHostSegments = segments.slice(0, -2);
  const explicitHost = explicitHostSegments.length > 0 ? explicitHostSegments.join("/") : undefined;

  if (owner === undefined || repository === undefined || owner.length === 0 || repository.length === 0) {
    return {
      error: {
        exitCode: 1,
        stdout: "",
        stderr: `Invalid value for -R: ${rawRepository}\n`
      }
    };
  }

  return {
    owner,
    repository: repository.replace(/\.git$/i, ""),
    ...(explicitHost === undefined ? {} : { explicitHost })
  };
}

function parseRepositoryTarget(rawRepository: string, context: ResolvedCliExecutionContext): { repository?: RepositoryContext; error?: CliResult } {
  const repositoryTargetParts = parseRepositoryTargetParts(rawRepository);

  if (repositoryTargetParts.error !== undefined) {
    return {
      error: repositoryTargetParts.error
    };
  }

  const selectedHostResult = resolveSelectedHostForCommand(repositoryTargetParts.explicitHost, context, {
    explicitHostnameSource: "-R",
    strictEnvironmentHost: false,
    missingHostError: {
      exitCode: 1,
      stdout: "",
      stderr: "No Gitea Host selected. Pass -R HOST/OWNER/REPO or set GTEA_HOST/GH_HOST.\n"
    }
  });

  if (
    selectedHostResult.error !== undefined
    || selectedHostResult.hostname === undefined
    || repositoryTargetParts.owner === undefined
    || repositoryTargetParts.repository === undefined
  ) {
    return {
      error: selectedHostResult.error ?? {
        exitCode: 1,
        stdout: "",
        stderr: `Invalid value for -R: ${rawRepository}\n`
      }
    };
  }

  return {
    repository: {
      hostname: selectedHostResult.hostname,
      owner: repositoryTargetParts.owner,
      repository: repositoryTargetParts.repository
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
      const authority = remoteUrl.port.length > 0 ? `${remoteUrl.hostname}:${remoteUrl.port}` : remoteUrl.hostname;
      const remoteHost = remoteUrl.protocol === "http:" || remoteUrl.protocol === "https:"
        ? `${remoteUrl.protocol}//${authority}`
        : authority;

      return parseRemotePath(remoteHost, remoteUrl.pathname);
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
  const repositoryTarget = resolveRepositoryCommandTarget(rawRepository, noCredentialPolicy, context);

  if (repositoryTarget.error !== undefined || repositoryTarget.target === undefined) {
    return {
      error: repositoryTarget.error ?? {
        exitCode: 1,
        stdout: "",
        stderr: "No Repository Context selected.\n"
      }
    };
  }

  return {
    repository: repositoryTarget.target.repository
  };
}

export function resolveHostCommandTarget(
  rawHostname: string | undefined,
  credentialPolicy: CredentialResolutionPolicy,
  context: ResolvedCliExecutionContext,
  explicitHostnameSource = "--hostname"
): { target?: ResolvedHostCommandTarget; error?: CliResult } {
  const selectedHostResult = resolveSelectedHostForCommand(rawHostname, context, {
    explicitHostnameSource,
    strictEnvironmentHost: true,
    missingHostError: {
      exitCode: 1,
      stdout: "",
      stderr: "No Gitea Host selected. Pass --hostname or set GTEA_HOST/GH_HOST.\n"
    }
  });

  if (selectedHostResult.error !== undefined || selectedHostResult.hostname === undefined) {
    return {
      error: selectedHostResult.error ?? {
        exitCode: 1,
        stdout: "",
        stderr: "No Gitea Host selected.\n"
      }
    };
  }

  const credentialResult = resolveCredentialForHost(
    selectedHostResult.hostname,
    credentialPolicy,
    context,
    { scopeEnvironmentTokenToHost: false },
    selectedHostResult.config
  );

  if (credentialResult.error !== undefined) {
    return {
      error: credentialResult.error
    };
  }

  return {
    target: {
      hostname: selectedHostResult.hostname,
      ...(credentialResult.credential === undefined ? {} : { credential: credentialResult.credential })
    }
  };
}

export function resolveRepositoryCommandTarget(
  rawRepository: string | undefined,
  credentialPolicy: CredentialResolutionPolicy,
  context: ResolvedCliExecutionContext
): { target?: ResolvedRepositoryCommandTarget; error?: CliResult } {
  if (rawRepository !== undefined) {
    const repositoryResult = parseRepositoryTarget(rawRepository, context);

    if (repositoryResult.error !== undefined || repositoryResult.repository === undefined) {
      return {
        error: repositoryResult.error ?? {
          exitCode: 1,
          stdout: "",
          stderr: `Invalid value for -R: ${rawRepository}\n`
        }
      };
    }

    const credentialResult = resolveCredentialForHost(
      repositoryResult.repository.hostname,
      credentialPolicy,
      context,
      { scopeEnvironmentTokenToHost: true }
    );

    if (credentialResult.error !== undefined) {
      return {
        error: credentialResult.error
      };
    }

    return {
      target: {
        repository: repositoryResult.repository,
        ...(credentialResult.credential === undefined ? {} : { credential: credentialResult.credential })
      }
    };
  }

  const repositoryResult = resolveRepositoryFromGit(context);

  if (repositoryResult.error !== undefined || repositoryResult.repository === undefined) {
    return {
      error: repositoryResult.error ?? {
        exitCode: 1,
        stdout: "",
        stderr: "No Repository Context selected. Pass -R or run from a Git repository.\n"
      }
    };
  }

  const credentialResult = resolveCredentialForHost(
    repositoryResult.repository.hostname,
    credentialPolicy,
    context,
    { scopeEnvironmentTokenToHost: true }
  );

  if (credentialResult.error !== undefined) {
    return {
      error: credentialResult.error
    };
  }

  return {
    target: {
      repository: repositoryResult.repository,
      ...(credentialResult.credential === undefined ? {} : { credential: credentialResult.credential })
    }
  };
}

export function resolveOptionalTokenResult(
  hostname: string,
  context: ResolvedCliExecutionContext
): ResolvedTokenResult {
  const credentialResult = resolveCredentialForHost(
    hostname,
    optionalCredentialPolicy,
    context,
    { scopeEnvironmentTokenToHost: true }
  );

  if (credentialResult.error !== undefined) {
    return {
      error: credentialResult.error
    };
  }

  return {
    ...(credentialResult.credential === undefined ? {} : { token: credentialResult.credential.token })
  };
}

export function resolveRequiredTokenResult(
  hostname: string,
  context: ResolvedCliExecutionContext,
  missingCredentialError: CliResult
): RequiredTokenResult {
  const credentialResult = resolveCredentialForHost(
    hostname,
    {
      mode: "required",
      missingCredentialError
    },
    context,
    { scopeEnvironmentTokenToHost: true }
  );

  if (credentialResult.error !== undefined) {
    return {
      error: credentialResult.error
    };
  }

  if (credentialResult.credential === undefined) {
    return {
      error: missingCredentialError
    };
  }

  return { token: credentialResult.credential.token };
}

export function buildAuthorizationHeaders(token: string): Record<string, string>;
export function buildAuthorizationHeaders(token: undefined): undefined;
export function buildAuthorizationHeaders(token: string | undefined): Record<string, string> | undefined;
export function buildAuthorizationHeaders(token: string | undefined): Record<string, string> | undefined {
  return token === undefined ? undefined : { Authorization: `token ${token}` };
}

export function preferOptionalTokenError(tokenResult: ResolvedTokenResult, fallback: CliResult): CliResult {
  return tokenResult.error ?? fallback;
}
