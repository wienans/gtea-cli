import { spawnSync } from "node:child_process";

import { CliResult, ResolvedCliExecutionContext } from "./cli-runtime.js";
import {
  buildHostBaseUrl,
  buildProcessEnv,
  loadNativeAuthConfig,
  parseHostname,
  saveNativeAuthConfig,
  type NativeAuthConfig
} from "./host-config.js";
import { resolveHostCommandTarget } from "./repository-context.js";
import { supportManifest } from "./support-manifest.js";

interface ParsedAuthFlags {
  hostname?: string;
  showToken: boolean;
  withToken: boolean;
}

interface GitCredentialInput {
  host?: string;
}

function parseProvidedHostname(
  rawValue: string | undefined,
  source: string
): { hostname?: string; error?: CliResult } {
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

function parseAuthFlags(args: string[]): { flags: ParsedAuthFlags; error?: CliResult } {
  const flags: ParsedAuthFlags = {
    showToken: false,
    withToken: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];

    if (token === undefined) {
      break;
    }

    if (token === "--with-token") {
      flags.withToken = true;
      continue;
    }

    if (token === "--show-token") {
      flags.showToken = true;
      continue;
    }

    if (token === "--hostname") {
      const rawHostname = args[index + 1];

      if (rawHostname === undefined || rawHostname.startsWith("-")) {
        return {
          flags,
          error: {
            exitCode: 1,
            stdout: "",
            stderr: "Missing value for --hostname.\n"
          }
        };
      }

      const parsedHostname = parseProvidedHostname(rawHostname, "--hostname");

      if (parsedHostname.error !== undefined) {
        return {
          flags,
          error: parsedHostname.error
        };
      }

      if (parsedHostname.hostname !== undefined) {
        flags.hostname = parsedHostname.hostname;
      }
      index += 1;
      continue;
    }

    if (token.startsWith("--hostname=")) {
      const parsedHostname = parseProvidedHostname(token.slice("--hostname=".length), "--hostname");

      if (parsedHostname.error !== undefined) {
        return {
          flags,
          error: parsedHostname.error
        };
      }

      if (parsedHostname.hostname !== undefined) {
        flags.hostname = parsedHostname.hostname;
      }
      continue;
    }

    return {
      flags,
      error: {
        exitCode: 1,
        stdout: "",
        stderr: `Unknown flag or argument: ${token}\n`
      }
    };
  }

  return { flags };
}

function resolveEnvToken(context: ResolvedCliExecutionContext): { token: string; source: string } | undefined {
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

function readTokenFromStdin(context: ResolvedCliExecutionContext): string | undefined {
  const trimmedInput = context.stdin.trim();

  return trimmedInput.length > 0 ? trimmedInput : undefined;
}

function parseGitCredentialInput(stdin: string): GitCredentialInput {
  const input: GitCredentialInput = {};

  for (const line of stdin.split(/\r?\n/)) {
    if (line.length === 0 || !line.includes("=")) {
      continue;
    }

    const [key, ...valueParts] = line.split("=");
    const value = valueParts.join("=");

    if (key === "host") {
      input.host = value;
    }
  }

  return input;
}

function resolveRequestedToken(flags: ParsedAuthFlags, context: ResolvedCliExecutionContext): string | undefined {
  return flags.withToken ? readTokenFromStdin(context) : resolveEnvToken(context)?.token;
}

function resolveAuthHostTarget(
  rawHostname: string | undefined,
  context: ResolvedCliExecutionContext,
  explicitHostnameSource = "--hostname"
): { hostname?: string; error?: CliResult } {
  const hostTarget = resolveHostCommandTarget(rawHostname, { mode: "none" }, context, explicitHostnameSource);

  if (hostTarget.error !== undefined || hostTarget.target === undefined) {
    return {
      error: hostTarget.error ?? {
        exitCode: 1,
        stdout: "",
        stderr: "No Gitea Host selected.\n"
      }
    };
  }

  return {
    hostname: hostTarget.target.hostname
  };
}

function resolveAuthCredentialTarget(
  rawHostname: string | undefined,
  context: ResolvedCliExecutionContext,
  explicitHostnameSource = "--hostname"
): { hostname?: string; token?: string; credentialSource?: string; error?: CliResult } {
  const hostTarget = resolveHostCommandTarget(rawHostname, { mode: "optional" }, context, explicitHostnameSource);

  if (hostTarget.error !== undefined || hostTarget.target === undefined) {
    return {
      error: hostTarget.error ?? {
        exitCode: 1,
        stdout: "",
        stderr: "No Gitea Host selected.\n"
      }
    };
  }

  if (hostTarget.target.credential === undefined) {
    return {
      error: {
        exitCode: 1,
        stdout: "",
        stderr: `No Personal Access Token is configured for ${hostTarget.target.hostname}. Run gtea auth login first.\n`
      }
    };
  }

  return {
    hostname: hostTarget.target.hostname,
    token: hostTarget.target.credential.token,
    credentialSource: hostTarget.target.credential.source
  };
}

function loadAuthConfig(context: ResolvedCliExecutionContext): { config?: NativeAuthConfig; error?: CliResult } {
  const config = loadNativeAuthConfig(context);

  if (config.error !== undefined) {
    return {
      error: config.error
    };
  }

  return {
    config
  };
}

function handleAuthLogin(args: string[], context: ResolvedCliExecutionContext): CliResult {
  const parsedFlags = parseAuthFlags(args);

  if (parsedFlags.error !== undefined) {
    return parsedFlags.error;
  }

  const configResult = loadAuthConfig(context);

  if (configResult.error !== undefined || configResult.config === undefined) {
    return configResult.error ?? {
      exitCode: 1,
      stdout: "",
      stderr: "Could not read the native auth config.\n"
    };
  }

  const selectedHostResult = resolveAuthHostTarget(parsedFlags.flags.hostname, context);

  if (selectedHostResult.error !== undefined || selectedHostResult.hostname === undefined) {
    return selectedHostResult.error ?? {
      exitCode: 1,
      stdout: "",
      stderr: "No Gitea Host selected.\n"
    };
  }

  const config = configResult.config;

  const token = resolveRequestedToken(parsedFlags.flags, context);

  if (token === undefined) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "A Personal Access Token is required. Pass --with-token or set GTEA_TOKEN/GH_TOKEN.\n"
    };
  }

  config.hosts[selectedHostResult.hostname] = {
    token,
    tokenStorage: "native-config-store"
  };
  config.activeHost = selectedHostResult.hostname;

  saveNativeAuthConfig(config, context);

  return {
    exitCode: 0,
    stdout: `Logged in to ${selectedHostResult.hostname} using a Personal Access Token stored in the native config store.\n`,
    stderr: ""
  };
}

function handleAuthRefresh(args: string[], context: ResolvedCliExecutionContext): CliResult {
  const parsedFlags = parseAuthFlags(args);

  if (parsedFlags.error !== undefined) {
    return parsedFlags.error;
  }

  const configResult = loadAuthConfig(context);

  if (configResult.error !== undefined || configResult.config === undefined) {
    return configResult.error ?? {
      exitCode: 1,
      stdout: "",
      stderr: "Could not read the native auth config.\n"
    };
  }

  const selectedHostResult = resolveAuthHostTarget(parsedFlags.flags.hostname, context);

  if (selectedHostResult.error !== undefined || selectedHostResult.hostname === undefined) {
    return selectedHostResult.error ?? {
      exitCode: 1,
      stdout: "",
      stderr: "No Gitea Host selected.\n"
    };
  }

  const config = configResult.config;

  if (config.hosts[selectedHostResult.hostname] === undefined) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `No stored credential exists for ${selectedHostResult.hostname}. Run gtea auth login first.\n`
    };
  }

  const token = resolveRequestedToken(parsedFlags.flags, context);

  if (token === undefined) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "A Personal Access Token is required. Pass --with-token or set GTEA_TOKEN/GH_TOKEN.\n"
    };
  }

  config.hosts[selectedHostResult.hostname] = {
    token,
    tokenStorage: "native-config-store"
  };
  config.activeHost = selectedHostResult.hostname;

  saveNativeAuthConfig(config, context);

  return {
    exitCode: 0,
    stdout: `Refreshed the stored credential for ${selectedHostResult.hostname}.\n`,
    stderr: ""
  };
}

function handleAuthSetupGit(args: string[], context: ResolvedCliExecutionContext): CliResult {
  const parsedFlags = parseAuthFlags(args);

  if (parsedFlags.error !== undefined) {
    return parsedFlags.error;
  }

  const configResult = loadAuthConfig(context);

  if (configResult.error !== undefined || configResult.config === undefined) {
    return configResult.error ?? {
      exitCode: 1,
      stdout: "",
      stderr: "Could not read the native auth config.\n"
    };
  }

  const credentialResult = resolveAuthCredentialTarget(parsedFlags.flags.hostname, context);

  if (
    credentialResult.error !== undefined
    || credentialResult.hostname === undefined
    || credentialResult.token === undefined
    || credentialResult.credentialSource === undefined
  ) {
    return credentialResult.error ?? {
      exitCode: 1,
      stdout: "",
      stderr: "No active credential configured.\n"
    };
  }

  const credentialBaseUrl = buildHostBaseUrl(credentialResult.hostname);
  const helperKey = `credential.${credentialBaseUrl}.helper`;
  const usernameKey = `credential.${credentialBaseUrl}.username`;
  const helperValue = `!${supportManifest.cliName} auth git-credential --hostname ${credentialResult.hostname}`;

  const helperWrite = spawnSync("git", ["config", "--global", helperKey, helperValue], {
    cwd: context.cwd,
    encoding: "utf8",
    env: buildProcessEnv(context)
  });

  if (helperWrite.status !== 0) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: helperWrite.stderr.length > 0 ? helperWrite.stderr : "Failed to configure the Git credential helper.\n"
    };
  }

  const usernameWrite = spawnSync("git", ["config", "--global", usernameKey, "oauth2"], {
    cwd: context.cwd,
    encoding: "utf8",
    env: buildProcessEnv(context)
  });

  if (usernameWrite.status !== 0) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: usernameWrite.stderr.length > 0 ? usernameWrite.stderr : "Failed to configure the Git credential username.\n"
    };
  }

  return {
    exitCode: 0,
    stdout: `Configured Git credential helper for ${credentialResult.hostname}.\n`,
    stderr: ""
  };
}

function handleAuthGitCredential(args: string[], context: ResolvedCliExecutionContext): CliResult {
  const action = args.at(-1);
  const flagArgs = action === undefined ? args : args.slice(0, -1);
  const parsedFlags = parseAuthFlags(flagArgs);

  if (parsedFlags.error !== undefined) {
    return parsedFlags.error;
  }

  if (action === undefined) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "Missing git credential action.\n"
    };
  }

  if (action === "store" || action === "erase") {
    return {
      exitCode: 0,
      stdout: "",
      stderr: ""
    };
  }

  if (action !== "get") {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Unknown git credential action: ${action}\n`
    };
  }

  const gitCredentialInput = parseGitCredentialInput(context.stdin);
  const credentialHost = parsedFlags.flags.hostname ?? gitCredentialInput.host;
  const credentialHostSource = parsedFlags.flags.hostname !== undefined ? "--hostname" : "git credential input host";
  const credentialResult = resolveAuthCredentialTarget(credentialHost, context, credentialHostSource);

  if (credentialResult.error !== undefined || credentialResult.token === undefined) {
    return credentialResult.error ?? {
      exitCode: 1,
      stdout: "",
      stderr: "No active credential configured.\n"
    };
  }

  return {
    exitCode: 0,
    stdout: `username=oauth2\npassword=${credentialResult.token}\n`,
    stderr: ""
  };
}

function handleAuthStatus(args: string[], context: ResolvedCliExecutionContext): CliResult {
  const parsedFlags = parseAuthFlags(args);

  if (parsedFlags.error !== undefined) {
    return parsedFlags.error;
  }

  const credentialResult = resolveAuthCredentialTarget(parsedFlags.flags.hostname, context);

  if (
    credentialResult.error !== undefined
    || credentialResult.hostname === undefined
    || credentialResult.token === undefined
    || credentialResult.credentialSource === undefined
  ) {
    return credentialResult.error ?? {
      exitCode: 1,
      stdout: "",
      stderr: "No active credential configured.\n"
    };
  }

  const lines = [
    `Active host: ${credentialResult.hostname}`,
    `Credential source: ${credentialResult.credentialSource}`
  ];

  if (parsedFlags.flags.showToken) {
    lines.push(`Token: ${credentialResult.token}`);
  }

  return {
    exitCode: 0,
    stdout: `${lines.join("\n")}\n`,
    stderr: ""
  };
}

function handleAuthToken(args: string[], context: ResolvedCliExecutionContext): CliResult {
  const parsedFlags = parseAuthFlags(args);

  if (parsedFlags.error !== undefined) {
    return parsedFlags.error;
  }

  const credentialResult = resolveAuthCredentialTarget(parsedFlags.flags.hostname, context);

  if (credentialResult.error !== undefined || credentialResult.token === undefined) {
    return credentialResult.error ?? {
      exitCode: 1,
      stdout: "",
      stderr: "No active credential configured.\n"
    };
  }

  return {
    exitCode: 0,
    stdout: `${credentialResult.token}\n`,
    stderr: ""
  };
}

function handleAuthSwitch(args: string[], context: ResolvedCliExecutionContext): CliResult {
  const parsedFlags = parseAuthFlags(args);

  if (parsedFlags.error !== undefined) {
    return parsedFlags.error;
  }

  const configResult = loadAuthConfig(context);

  if (configResult.error !== undefined || configResult.config === undefined) {
    return configResult.error ?? {
      exitCode: 1,
      stdout: "",
      stderr: "Could not read the native auth config.\n"
    };
  }

  const selectedHostResult = resolveAuthHostTarget(parsedFlags.flags.hostname, context);

  if (selectedHostResult.error !== undefined || selectedHostResult.hostname === undefined) {
    return selectedHostResult.error ?? {
      exitCode: 1,
      stdout: "",
      stderr: "No Gitea Host selected.\n"
    };
  }

  const config = configResult.config;

  if (config.hosts[selectedHostResult.hostname] === undefined) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `No stored credential exists for ${selectedHostResult.hostname}. Run gtea auth login first.\n`
    };
  }

  config.activeHost = selectedHostResult.hostname;
  saveNativeAuthConfig(config, context);

  return {
    exitCode: 0,
    stdout: `Switched active host to ${selectedHostResult.hostname}.\n`,
    stderr: ""
  };
}

function handleAuthLogout(args: string[], context: ResolvedCliExecutionContext): CliResult {
  const parsedFlags = parseAuthFlags(args);

  if (parsedFlags.error !== undefined) {
    return parsedFlags.error;
  }

  const configResult = loadAuthConfig(context);

  if (configResult.error !== undefined || configResult.config === undefined) {
    return configResult.error ?? {
      exitCode: 1,
      stdout: "",
      stderr: "Could not read the native auth config.\n"
    };
  }

  const selectedHostResult = resolveAuthHostTarget(parsedFlags.flags.hostname, context);

  if (selectedHostResult.error !== undefined || selectedHostResult.hostname === undefined) {
    return selectedHostResult.error ?? {
      exitCode: 1,
      stdout: "",
      stderr: "No Gitea Host selected.\n"
    };
  }

  const config = configResult.config;

  if (config.hosts[selectedHostResult.hostname] === undefined) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `No stored credential exists for ${selectedHostResult.hostname}.\n`
    };
  }

  delete config.hosts[selectedHostResult.hostname];

  if (config.activeHost === selectedHostResult.hostname) {
    const fallbackHost = Object.keys(config.hosts).sort()[0];

    if (fallbackHost === undefined) {
      delete config.activeHost;
    } else {
      config.activeHost = fallbackHost;
    }
  }

  saveNativeAuthConfig(config, context);

  return {
    exitCode: 0,
    stdout: `Removed the stored credential for ${selectedHostResult.hostname}.\n`,
    stderr: ""
  };
}

export function executeAuthCommand(args: string[], context: ResolvedCliExecutionContext): CliResult | undefined {
  if (args[0] !== "auth") {
    return undefined;
  }

  const subcommand = args[1];
  const subcommandArgs = args.slice(2);

  if (subcommand === "login") {
    return handleAuthLogin(subcommandArgs, context);
  }

  if (subcommand === "status") {
    return handleAuthStatus(subcommandArgs, context);
  }

  if (subcommand === "token") {
    return handleAuthToken(subcommandArgs, context);
  }

  if (subcommand === "switch") {
    return handleAuthSwitch(subcommandArgs, context);
  }

  if (subcommand === "logout") {
    return handleAuthLogout(subcommandArgs, context);
  }

  if (subcommand === "refresh") {
    return handleAuthRefresh(subcommandArgs, context);
  }

  if (subcommand === "setup-git") {
    return handleAuthSetupGit(subcommandArgs, context);
  }

  if (subcommand === "git-credential") {
    return handleAuthGitCredential(subcommandArgs, context);
  }

  return undefined;
}