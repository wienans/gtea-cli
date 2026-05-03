import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { ResolvedCliExecutionContext } from "./cli-runtime.js";

export interface StoredHostCredential {
  token: string;
  tokenStorage: "native-config-store";
}

export interface NativeAuthConfig {
  activeHost?: string;
  hosts: Record<string, StoredHostCredential>;
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

export function loadNativeAuthConfig(context: ResolvedCliExecutionContext): NativeAuthConfig {
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

export function saveNativeAuthConfig(config: NativeAuthConfig, context: ResolvedCliExecutionContext): void {
  const configPath = resolveConfigPath(context);

  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export function parseHostname(rawValue: string | undefined): string | undefined {
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

export function isEligibleHost(hostname: string): boolean {
  const hostnameWithoutPort = hostname.split(":")[0] ?? hostname;

  return !/(^|\.)github\.com$/i.test(hostnameWithoutPort);
}

export function buildProcessEnv(context: ResolvedCliExecutionContext): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...context.env
  };
}