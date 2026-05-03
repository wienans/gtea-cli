import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { CliResult, ResolvedCliExecutionContext } from "./cli-runtime.js";
import { supportManifest } from "./support-manifest.js";

interface StoredHostCredential {
  token: string;
  tokenStorage: "native-config-store";
}

interface NativeAuthConfig {
  activeHost?: string;
  hosts: Record<string, StoredHostCredential>;
}

interface ParsedAuthFlags {
  hostname?: string;
  showToken: boolean;
  withToken: boolean;
}

interface ResolvedCredential {
  hostname: string;
  token: string;
  credentialSource: string;
}

interface GitCredentialInput {
  host?: string;
}

function resolveConfigDirectory(context: ResolvedCliExecutionContext): string {
  const env = context.env;
  const homeDirectory = env.HOME ?? homedir();

  if (context.platform === "win32") {
    return join(env.APPDATA ?? join(homeDirectory, "AppData", "Roaming"), "gtea");
  }

  if (context.platform === "darwin") {
    return join(homeDirectory, "Library", "Application Support", "gtea");
  }

  return join(env.XDG_CONFIG_HOME ?? join(homeDirectory, ".config"), "gtea");
}

function resolveConfigPath(context: ResolvedCliExecutionContext): string {
  return join(resolveConfigDirectory(context), "config.json");
}

function loadNativeAuthConfig(context: ResolvedCliExecutionContext): NativeAuthConfig {
  const configPath = resolveConfigPath(context);

  try {
    const content = readFileSync(configPath, "utf8");
    const parsed = JSON.parse(content) as Partial<NativeAuthConfig>;

    const config: NativeAuthConfig = {
      hosts: parsed.hosts ?? {}
    };

    if (parsed.activeHost !== undefined) {
      config.activeHost = parsed.activeHost;
    }

    return config;
  } catch {
    return {
      hosts: {}
    };
  }
}

function saveNativeAuthConfig(config: NativeAuthConfig, context: ResolvedCliExecutionContext): void {
  const configPath = resolveConfigPath(context);

  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function parseHostname(rawValue: string | undefined): string | undefined {
  if (rawValue === undefined) {
    return undefined;
  }

  const trimmedValue = rawValue.trim();

  if (trimmedValue.length === 0) {
    return undefined;
  }

  try {
    const normalizedUrl = new URL(
      /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(trimmedValue) ? trimmedValue : `https://${trimmedValue}`
    );

    if (normalizedUrl.pathname !== "/" && normalizedUrl.pathname !== "") {
      return undefined;
    }

    const portSuffix = normalizedUrl.port.length > 0 ? `:${normalizedUrl.port}` : "";

    return `${normalizedUrl.hostname.toLowerCase()}${portSuffix}`;
  } catch {
    return undefined;
  }
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

function isEligibleHost(hostname: string): boolean {
  const hostnameWithoutPort = hostname.split(":")[0] ?? hostname;

  return !/(^|\.)github\.com$/i.test(hostnameWithoutPort);
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

function resolveEnvHost(context: ResolvedCliExecutionContext): { hostname?: string; error?: CliResult } {
  if (context.env.GTEA_HOST !== undefined) {
    return parseProvidedHostname(context.env.GTEA_HOST, "GTEA_HOST");
  }

  if (context.env.GH_HOST !== undefined) {
    return parseProvidedHostname(context.env.GH_HOST, "GH_HOST");
  }

  return {};
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

function resolveSelectedHost(
  explicitHostname: string | undefined,
  context: ResolvedCliExecutionContext,
  config: NativeAuthConfig,
  explicitHostnameSource = "--hostname"
): { hostname?: string; error?: CliResult } {
  const fallbackStoredHost = Object.keys(config.hosts).sort()[0];
  const explicitHost = parseProvidedHostname(explicitHostname, explicitHostnameSource);

  if (explicitHost.error !== undefined) {
    return {
      error: explicitHost.error
    };
  }

  const envHost = resolveEnvHost(context);

  if (envHost.error !== undefined) {
    return {
      error: envHost.error
    };
  }

  const parsedHostname = explicitHost.hostname ?? envHost.hostname ?? config.activeHost ?? fallbackStoredHost;

  if (parsedHostname === undefined) {
    return {
      error: {
        exitCode: 1,
        stdout: "",
        stderr: "No Gitea Host selected. Pass --hostname or set GTEA_HOST/GH_HOST.\n"
      }
    };
  }

  if (!isEligibleHost(parsedHostname)) {
    return {
      error: {
        exitCode: 1,
        stdout: "",
        stderr: `Host ${parsedHostname} is not an Eligible Host for ${"gtea"}.\n`
      }
    };
  }

  return {
    hostname: parsedHostname
  };
}

function resolveCredential(
  explicitHostname: string | undefined,
  context: ResolvedCliExecutionContext,
  config: NativeAuthConfig,
  explicitHostnameSource = "--hostname"
): { credential?: ResolvedCredential; error?: CliResult } {
  const selectedHostResult = resolveSelectedHost(explicitHostname, context, config, explicitHostnameSource);

  if (selectedHostResult.error !== undefined) {
    return {
      error: selectedHostResult.error
    };
  }

  if (selectedHostResult.hostname === undefined) {
    return {
      error: {
        exitCode: 1,
        stdout: "",
        stderr: "No Gitea Host selected.\n"
      }
    };
  }

  const envToken = resolveEnvToken(context);

  if (envToken !== undefined) {
    return {
      credential: {
        hostname: selectedHostResult.hostname,
        token: envToken.token,
        credentialSource: envToken.source
      }
    };
  }

  const storedCredential = config.hosts[selectedHostResult.hostname];

  if (storedCredential === undefined) {
    return {
      error: {
        exitCode: 1,
        stdout: "",
        stderr: `No Personal Access Token is configured for ${selectedHostResult.hostname}. Run gtea auth login first.\n`
      }
    };
  }

  return {
    credential: {
      hostname: selectedHostResult.hostname,
      token: storedCredential.token,
      credentialSource: "native config store"
    }
  };
}

function readTokenFromStdin(context: ResolvedCliExecutionContext): string | undefined {
  const trimmedInput = context.stdin.trim();

  return trimmedInput.length > 0 ? trimmedInput : undefined;
}

function buildProcessEnv(context: ResolvedCliExecutionContext): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...context.env
  };
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

function handleAuthLogin(args: string[], context: ResolvedCliExecutionContext): CliResult {
  const parsedFlags = parseAuthFlags(args);

  if (parsedFlags.error !== undefined) {
    return parsedFlags.error;
  }

  const config = loadNativeAuthConfig(context);
  const selectedHostResult = resolveSelectedHost(parsedFlags.flags.hostname, context, config);

  if (selectedHostResult.error !== undefined || selectedHostResult.hostname === undefined) {
    return selectedHostResult.error ?? {
      exitCode: 1,
      stdout: "",
      stderr: "No Gitea Host selected.\n"
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
    stdout: `Logged in to ${selectedHostResult.hostname} using a Personal Access Token stored in the native config store.\n`,
    stderr: ""
  };
}

function handleAuthRefresh(args: string[], context: ResolvedCliExecutionContext): CliResult {
  const parsedFlags = parseAuthFlags(args);

  if (parsedFlags.error !== undefined) {
    return parsedFlags.error;
  }

  const config = loadNativeAuthConfig(context);
  const selectedHostResult = resolveSelectedHost(parsedFlags.flags.hostname, context, config);

  if (selectedHostResult.error !== undefined || selectedHostResult.hostname === undefined) {
    return selectedHostResult.error ?? {
      exitCode: 1,
      stdout: "",
      stderr: "No Gitea Host selected.\n"
    };
  }

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

  const config = loadNativeAuthConfig(context);
  const credentialResult = resolveCredential(parsedFlags.flags.hostname, context, config);

  if (credentialResult.error !== undefined || credentialResult.credential === undefined) {
    return credentialResult.error ?? {
      exitCode: 1,
      stdout: "",
      stderr: "No active credential configured.\n"
    };
  }

  const helperKey = `credential.https://${credentialResult.credential.hostname}.helper`;
  const usernameKey = `credential.https://${credentialResult.credential.hostname}.username`;
  const helperValue = `!${supportManifest.cliName} auth git-credential --hostname ${credentialResult.credential.hostname}`;

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
    stdout: `Configured Git credential helper for ${credentialResult.credential.hostname}.\n`,
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
  const config = loadNativeAuthConfig(context);
  const credentialHost = parsedFlags.flags.hostname ?? gitCredentialInput.host;
  const credentialHostSource = parsedFlags.flags.hostname !== undefined ? "--hostname" : "git credential input host";
  const credentialResult = resolveCredential(credentialHost, context, config, credentialHostSource);

  if (credentialResult.error !== undefined || credentialResult.credential === undefined) {
    return credentialResult.error ?? {
      exitCode: 1,
      stdout: "",
      stderr: "No active credential configured.\n"
    };
  }

  return {
    exitCode: 0,
    stdout: `username=oauth2\npassword=${credentialResult.credential.token}\n`,
    stderr: ""
  };
}

function handleAuthStatus(args: string[], context: ResolvedCliExecutionContext): CliResult {
  const parsedFlags = parseAuthFlags(args);

  if (parsedFlags.error !== undefined) {
    return parsedFlags.error;
  }

  const config = loadNativeAuthConfig(context);
  const credentialResult = resolveCredential(parsedFlags.flags.hostname, context, config);

  if (credentialResult.error !== undefined || credentialResult.credential === undefined) {
    return credentialResult.error ?? {
      exitCode: 1,
      stdout: "",
      stderr: "No active credential configured.\n"
    };
  }

  const lines = [
    `Active host: ${credentialResult.credential.hostname}`,
    `Credential source: ${credentialResult.credential.credentialSource}`
  ];

  if (parsedFlags.flags.showToken) {
    lines.push(`Token: ${credentialResult.credential.token}`);
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

  const config = loadNativeAuthConfig(context);
  const credentialResult = resolveCredential(parsedFlags.flags.hostname, context, config);

  if (credentialResult.error !== undefined || credentialResult.credential === undefined) {
    return credentialResult.error ?? {
      exitCode: 1,
      stdout: "",
      stderr: "No active credential configured.\n"
    };
  }

  return {
    exitCode: 0,
    stdout: `${credentialResult.credential.token}\n`,
    stderr: ""
  };
}

function handleAuthSwitch(args: string[], context: ResolvedCliExecutionContext): CliResult {
  const parsedFlags = parseAuthFlags(args);

  if (parsedFlags.error !== undefined) {
    return parsedFlags.error;
  }

  const config = loadNativeAuthConfig(context);
  const selectedHostResult = resolveSelectedHost(parsedFlags.flags.hostname, context, config);

  if (selectedHostResult.error !== undefined || selectedHostResult.hostname === undefined) {
    return selectedHostResult.error ?? {
      exitCode: 1,
      stdout: "",
      stderr: "No Gitea Host selected.\n"
    };
  }

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

  const config = loadNativeAuthConfig(context);
  const selectedHostResult = resolveSelectedHost(parsedFlags.flags.hostname, context, config);

  if (selectedHostResult.error !== undefined || selectedHostResult.hostname === undefined) {
    return selectedHostResult.error ?? {
      exitCode: 1,
      stdout: "",
      stderr: "No Gitea Host selected.\n"
    };
  }

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