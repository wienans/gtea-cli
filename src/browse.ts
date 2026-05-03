import { spawnSync } from "node:child_process";

import { CliResult, ResolvedCliExecutionContext } from "./cli-runtime.js";
import {
  buildProcessEnv,
  isEligibleHost,
  loadNativeAuthConfig,
  parseHostname,
  type NativeAuthConfig
} from "./host-config.js";

interface ParsedBrowseFlags {
  noBrowser: boolean;
  repository?: string;
  releases: boolean;
  settings: boolean;
  wiki: boolean;
  location?: string;
}

interface RepositoryContext {
  hostname: string;
  owner: string;
  repository: string;
}

interface GitBrowseRef {
  kind: "branch" | "commit";
  value: string;
}

function resolveSelectedHost(context: ResolvedCliExecutionContext, config: NativeAuthConfig): string | undefined {
  const envHost = parseHostname(context.env.GTEA_HOST) ?? parseHostname(context.env.GH_HOST);

  return envHost ?? config.activeHost ?? Object.keys(config.hosts).sort()[0];
}

function parseBrowseFlags(args: string[]): { flags: ParsedBrowseFlags; error?: CliResult } {
  const flags: ParsedBrowseFlags = {
    noBrowser: false,
    releases: false,
    settings: false,
    wiki: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];

    if (token === undefined) {
      break;
    }

    if (token === "--no-browser" || token === "-n") {
      flags.noBrowser = true;
      continue;
    }

    if (token === "--settings" || token === "-s") {
      flags.settings = true;
      continue;
    }

    if (token === "--wiki" || token === "-w") {
      flags.wiki = true;
      continue;
    }

    if (token === "--releases" || token === "-r") {
      flags.releases = true;
      continue;
    }

    if (token === "--repo" || token === "-R") {
      const rawRepository = args[index + 1];

      if (rawRepository === undefined || rawRepository.startsWith("-")) {
        return {
          flags,
          error: {
            exitCode: 1,
            stdout: "",
            stderr: "Missing value for --repo.\n"
          }
        };
      }

      flags.repository = rawRepository;
      index += 1;
      continue;
    }

    if (token.startsWith("--repo=")) {
      flags.repository = token.slice("--repo=".length);
      continue;
    }

    if (!token.startsWith("-")) {
      if (flags.location !== undefined) {
        return {
          flags,
          error: {
            exitCode: 1,
            stdout: "",
            stderr: `Unexpected argument: ${token}\n`
          }
        };
      }

      flags.location = token;
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

function resolveGitBrowseRef(context: ResolvedCliExecutionContext): GitBrowseRef | undefined {
  const branchResult = spawnSync("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], {
    cwd: context.cwd,
    encoding: "utf8",
    env: buildProcessEnv(context)
  });

  if (branchResult.status === 0 && branchResult.stdout.trim().length > 0) {
    return {
      kind: "branch",
      value: branchResult.stdout.trim()
    };
  }

  const commitResult = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: context.cwd,
    encoding: "utf8",
    env: buildProcessEnv(context)
  });

  if (commitResult.status !== 0 || commitResult.stdout.trim().length === 0) {
    return undefined;
  }

  return {
    kind: "commit",
    value: commitResult.stdout.trim()
  };
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

function synthesizeRepositoryUrl(repository: RepositoryContext): string {
  return `https://${repository.hostname}/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repository)}`;
}

function encodeRoutePath(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function synthesizeFileUrl(baseUrl: string, rawLocation: string, context: ResolvedCliExecutionContext): { url?: string; error?: CliResult } {
  const lineMatch = rawLocation.match(/^(.*?):(\d+)$/);
  const location = lineMatch === null ? rawLocation : (lineMatch[1] ?? rawLocation);
  const normalizedLocation = location.replace(/\\/g, "/").replace(/^\.?\//, "");

  if (normalizedLocation.length === 0) {
    return {
      error: {
        exitCode: 1,
        stdout: "",
        stderr: `Unsupported browse target: ${rawLocation}\n`
      }
    };
  }

  const gitRef = resolveGitBrowseRef(context);

  if (gitRef === undefined) {
    return {
      error: {
        exitCode: 1,
        stdout: "",
        stderr: "A local Git ref is required to browse a file path. Run from a Git repository with a checked-out ref.\n"
      }
    };
  }

  const lineAnchor = lineMatch === null ? "" : `#L${lineMatch[2]}`;

  return {
    url: `${baseUrl}/src/${gitRef.kind}/${encodeURIComponent(gitRef.value)}/${encodeRoutePath(normalizedLocation)}${lineAnchor}`
  };
}

function synthesizeBrowseUrl(
  repository: RepositoryContext,
  flags: ParsedBrowseFlags,
  context: ResolvedCliExecutionContext
): { url?: string; error?: CliResult } {
  const baseUrl = synthesizeRepositoryUrl(repository);
  const sectionFlags = [flags.settings, flags.wiki, flags.releases].filter(Boolean).length;

  if (sectionFlags > 1) {
    return {
      error: {
        exitCode: 1,
        stdout: "",
        stderr: "Choose at most one browse section flag.\n"
      }
    };
  }

  if (flags.settings) {
    return { url: `${baseUrl}/settings` };
  }

  if (flags.wiki) {
    return { url: `${baseUrl}/wiki` };
  }

  if (flags.releases) {
    return { url: `${baseUrl}/releases` };
  }

  if (flags.location === undefined) {
    return { url: baseUrl };
  }

  if (/^\d+$/.test(flags.location)) {
    return { url: `${baseUrl}/issues/${flags.location}` };
  }

  const pullRequestMatch = flags.location.match(/^(?:pull|pulls|pr)\/(\d+)$/);

  if (pullRequestMatch !== null) {
    return { url: `${baseUrl}/pulls/${pullRequestMatch[1]}` };
  }

  if (/^[0-9a-f]{7,40}$/i.test(flags.location)) {
    return { url: `${baseUrl}/commit/${flags.location}` };
  }

  return synthesizeFileUrl(baseUrl, flags.location, context);
}

function openBrowseUrl(url: string, context: ResolvedCliExecutionContext): CliResult {
  const processEnv = buildProcessEnv(context);
  const openResult = context.platform === "win32"
    ? spawnSync("cmd", ["/c", "start", "", url], {
        cwd: context.cwd,
        env: processEnv,
        stdio: "ignore",
        windowsHide: true
      })
    : spawnSync(context.platform === "darwin" ? "open" : "xdg-open", [url], {
        cwd: context.cwd,
        env: processEnv,
        stdio: "ignore"
      });

  if (openResult.error !== undefined || openResult.status !== 0) {
    const commandName = context.platform === "win32" ? "start" : context.platform === "darwin" ? "open" : "xdg-open";

    return {
      exitCode: 1,
      stdout: "",
      stderr: `Failed to open ${url} with ${commandName}.\n`
    };
  }

  return {
    exitCode: 0,
    stdout: "",
    stderr: ""
  };
}

export function executeBrowseCommand(args: string[], context: ResolvedCliExecutionContext): CliResult | undefined {
  if (args[0] !== "browse") {
    return undefined;
  }

  const parsedFlags = parseBrowseFlags(args.slice(1));

  if (parsedFlags.error !== undefined) {
    return parsedFlags.error;
  }

  const repositoryTarget = parsedFlags.flags.repository === undefined
    ? resolveRepositoryFromGit(context)
    : parseRepositoryTarget(parsedFlags.flags.repository, context);

  if (repositoryTarget.error !== undefined || repositoryTarget.repository === undefined) {
    return repositoryTarget.error ?? {
      exitCode: 1,
      stdout: "",
      stderr: "No Repository Context selected.\n"
    };
  }

  const browseUrl = synthesizeBrowseUrl(repositoryTarget.repository, parsedFlags.flags, context);

  if (browseUrl.error !== undefined || browseUrl.url === undefined) {
    return browseUrl.error ?? {
      exitCode: 1,
      stdout: "",
      stderr: "Unsupported browse target.\n"
    };
  }

  if (parsedFlags.flags.noBrowser) {
    return {
      exitCode: 0,
      stdout: `${browseUrl.url}\n`,
      stderr: ""
    };
  }

  return openBrowseUrl(browseUrl.url, context);
}