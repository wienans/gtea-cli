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

const explicitSchemePattern = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//;
const supportedHostProtocols = new Set(["http:", "https:"]);

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
    const hasExplicitScheme = explicitSchemePattern.test(trimmedValue);
    const normalizedUrl = new URL(
      hasExplicitScheme ? trimmedValue : `https://${trimmedValue}`
    );

    if (hasExplicitScheme && !supportedHostProtocols.has(normalizedUrl.protocol)) {
      return undefined;
    }

    if (normalizedUrl.pathname !== "/" && normalizedUrl.pathname !== "") {
      return undefined;
    }

    if (normalizedUrl.search.length > 0 || normalizedUrl.hash.length > 0) {
      return undefined;
    }

    const portSuffix = normalizedUrl.port.length > 0 ? `:${normalizedUrl.port}` : "";
    const normalizedHost = `${normalizedUrl.hostname.toLowerCase()}${portSuffix}`;

    return hasExplicitScheme ? `${normalizedUrl.protocol}//${normalizedHost}` : normalizedHost;
  } catch {
    return undefined;
  }
}

export function isEligibleHost(hostname: string): boolean {
  try {
    const normalizedUrl = new URL(explicitSchemePattern.test(hostname) ? hostname : `https://${hostname}`);

    return !/(^|\.)github\.com$/i.test(normalizedUrl.hostname);
  } catch {
    return false;
  }
}

export function buildHostBaseUrl(hostname: string): string {
  if (explicitSchemePattern.test(hostname)) {
    return hostname;
  }

  const hostnameWithoutPort = hostname.split(":")[0] ?? hostname;
  const protocol = /^(localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)$/i.test(hostnameWithoutPort) ? "http" : "https";

  return `${protocol}://${hostname}`;
}

export function buildProcessEnv(context: ResolvedCliExecutionContext): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...context.env
  };
}