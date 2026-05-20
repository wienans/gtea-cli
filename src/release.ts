import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve as resolvePath } from "node:path";

import { CliResult, ResolvedCliExecutionContext } from "./cli-runtime.js";
import { buildHostBaseUrl } from "./host-config.js";
import {
  buildAuthorizationHeaders,
  preferOptionalTokenError,
  type RepositoryContext,
  resolveOptionalTokenResult,
  resolveRepositoryCommandTarget,
  resolveRequiredTokenResult
} from "./repository-context.js";
import {
  renderStructuredJq,
  renderStructuredJson,
  renderStructuredTemplate,
  type StructuredObject
} from "./structured-output.js";
import { ManifestCommand, ManifestGroup, supportManifest } from "./support-manifest.js";

interface ParsedReleaseFlags {
  tag?: string;
  repository?: string;
  jsonFields?: string[];
  jqExpression?: string;
  template?: string;
}

interface ParsedReleaseCreateFlags {
  tag?: string;
  repository?: string;
  title?: string;
  notes?: string;
  notesFile?: string;
  draft: boolean;
  prerelease: boolean;
  target?: string;
}

interface ParsedReleaseEditFlags {
  tag?: string;
  repository?: string;
  title?: string;
  notes?: string;
  notesFile?: string;
  draft?: boolean;
  prerelease?: boolean;
  target?: string;
  newTag?: string;
}

interface ParsedReleaseDeleteFlags {
  tag?: string;
  repository?: string;
  yes: boolean;
}

interface ParsedReleaseUploadFlags {
  tag?: string;
  repository?: string;
  files: string[];
}

interface ParsedReleaseDownloadFlags {
  tag?: string;
  repository?: string;
  directory?: string;
  patterns: string[];
}

interface ReleaseAssetRecord extends StructuredObject {
  name: string;
  size: number;
  downloadUrl: string;
  contentType: string | null;
}

interface ReleaseRecord extends StructuredObject {
  tagName: string;
  name: string;
  body: string;
  createdAt: string | null;
  publishedAt: string | null;
  isDraft: boolean;
  isPrerelease: boolean;
  targetCommitish: string | null;
  url: string;
  assets: ReleaseAssetRecord[];
}

interface GiteaReleaseAssetPayload {
  name?: string;
  size?: number;
  browser_download_url?: string;
  content_type?: string;
}

interface GiteaReleasePayload {
  id?: number;
  tag_name?: string;
  name?: string;
  body?: string;
  created_at?: string;
  published_at?: string;
  draft?: boolean;
  prerelease?: boolean;
  target_commitish?: string;
  html_url?: string;
  assets?: GiteaReleaseAssetPayload[];
}

const releaseGroup = supportManifest.children.find(
  (node): node is ManifestGroup => node.kind === "group" && node.name === "release"
);
const releaseCommands = new Map(
  (releaseGroup?.children ?? [])
    .filter((node): node is ManifestCommand => node.kind === "command")
    .map((node) => [node.name, node] as const)
);

function collectSupportedReleaseOutputFields(commandName: string): Set<string> {
  return new Set(
    (releaseCommands.get(commandName)?.outputFields ?? [])
      .filter((field) => field.status !== "unsupported")
      .map((field) => field.name)
  );
}

const releaseListOutputFields = collectSupportedReleaseOutputFields("list");
const releaseViewOutputFields = collectSupportedReleaseOutputFields("view");

type UnsupportedReleaseValueFlag = {
  long: string;
  short?: string;
  reason: string;
  allowDashValue?: boolean;
};

type UnsupportedReleaseBooleanFlag = {
  long: string;
  short?: string;
  reason: string;
};

function renderUnsupportedReleaseFlag(subcommand: string, flag: string, reason: string): CliResult {
  return {
    exitCode: 1,
    stdout: "",
    stderr: `${supportManifest.cliName} release ${subcommand} flag ${flag} is currently unsupported: ${reason}\n`
  };
}

function resolveUnsupportedReleaseValueFlag(
  args: string[],
  index: number,
  subcommand: string,
  unsupportedFlags: readonly UnsupportedReleaseValueFlag[]
): CliResult | undefined {
  for (const unsupportedFlag of unsupportedFlags) {
    const parsedFlag = parseStringFlagValue(args, index, unsupportedFlag);

    if (parsedFlag.error !== undefined) {
      return parsedFlag.error;
    }

    if (parsedFlag.handled) {
      return renderUnsupportedReleaseFlag(subcommand, unsupportedFlag.long, unsupportedFlag.reason);
    }
  }

  return undefined;
}

function resolveUnsupportedReleaseBooleanFlag(
  token: string,
  subcommand: string,
  unsupportedFlags: readonly UnsupportedReleaseBooleanFlag[]
): CliResult | undefined {
  for (const unsupportedFlag of unsupportedFlags) {
    if (
      token === unsupportedFlag.long
      || token.startsWith(`${unsupportedFlag.long}=`)
      || (unsupportedFlag.short !== undefined && token === unsupportedFlag.short)
    ) {
      return renderUnsupportedReleaseFlag(subcommand, unsupportedFlag.long, unsupportedFlag.reason);
    }
  }

  return undefined;
}

function parseStringFlagValue(
  args: string[],
  index: number,
  options: { long: string; short?: string; allowDashValue?: boolean }
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

  if (
    rawValue === undefined
    || (rawValue.startsWith("-") && !(options.allowDashValue === true && rawValue === "-"))
  ) {
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

function parseBooleanSwitchFlag(
  args: string[],
  index: number,
  options: { long: string; short?: string }
): { handled: boolean; nextIndex: number; value?: boolean; error?: CliResult } {
  const token = args[index];
  const longPrefix = `${options.long}=`;

  if (token === undefined) {
    return {
      handled: false,
      nextIndex: index
    };
  }

  if (token !== options.long && token !== options.short && !token.startsWith(longPrefix)) {
    return {
      handled: false,
      nextIndex: index
    };
  }

  if (token === options.long || token === options.short) {
    return {
      handled: true,
      nextIndex: index,
      value: true
    };
  }

  const rawValue = token.slice(longPrefix.length);

  if (rawValue === "true") {
    return {
      handled: true,
      nextIndex: index,
      value: true
    };
  }

  if (rawValue === "false") {
    return {
      handled: true,
      nextIndex: index,
      value: false
    };
  }

  return {
    handled: true,
    nextIndex: index,
    error: {
      exitCode: 1,
      stdout: "",
      stderr: `Invalid value for ${options.long}: ${rawValue}. Expected true or false.\n`
    }
  };
}

function parseReleaseFlags(
  args: string[],
  options: { allowTag: boolean }
): { flags: ParsedReleaseFlags; error?: CliResult } {
  const flags: ParsedReleaseFlags = {};

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

    if (!options.allowTag) {
      return {
        flags,
        error: {
          exitCode: 1,
          stdout: "",
          stderr: `Unexpected argument: ${token}\n`
        }
      };
    }

    if (flags.tag !== undefined) {
      return {
        flags,
        error: {
          exitCode: 1,
          stdout: "",
          stderr: `Unexpected argument: ${token}\n`
        }
      };
    }

    flags.tag = token;
  }

  return { flags };
}

function parseReleaseCreateFlags(args: string[]): { flags: ParsedReleaseCreateFlags; error?: CliResult } {
  const flags: ParsedReleaseCreateFlags = {
    draft: false,
    prerelease: false
  };

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

    const unsupportedValueFlags: UnsupportedReleaseValueFlag[] = [
      {
        long: "--discussion-category",
        reason: "Discussion creation is not part of the supported release create slice."
      },
      {
        long: "--notes-start-tag",
        reason: "Generated release note range selection is not part of the supported release create slice."
      }
    ] as const;

    const unsupportedValueError = resolveUnsupportedReleaseValueFlag(args, index, "create", unsupportedValueFlags);

    if (unsupportedValueError !== undefined) {
      return {
        flags,
        error: unsupportedValueError
      };
    }

    const unsupportedBooleanFlags: UnsupportedReleaseBooleanFlag[] = [
      {
        long: "--fail-on-no-commits",
        reason: "Commit-gap validation is not part of the supported release create slice."
      },
      {
        long: "--generate-notes",
        reason: "Automatic release note generation is not part of the supported release create slice."
      },
      {
        long: "--latest",
        reason: "Explicit latest-release promotion is not part of the supported release create slice."
      },
      {
        long: "--notes-from-tag",
        reason: "Tag-annotation note generation is not part of the supported release create slice."
      },
      {
        long: "--verify-tag",
        reason: "Remote tag verification is not part of the supported release create slice."
      }
    ];

    const unsupportedBooleanError = resolveUnsupportedReleaseBooleanFlag(token, "create", unsupportedBooleanFlags);

    if (unsupportedBooleanError !== undefined) {
      return {
        flags,
        error: unsupportedBooleanError
      };
    }

    const titleFlag = parseStringFlagValue(args, index, { long: "--title", short: "-t" });

    if (titleFlag.error !== undefined) {
      return {
        flags,
        error: titleFlag.error
      };
    }

    if (titleFlag.handled && titleFlag.value !== undefined) {
      flags.title = titleFlag.value;
      index = titleFlag.nextIndex;
      continue;
    }

    const notesFlag = parseStringFlagValue(args, index, { long: "--notes", short: "-n" });

    if (notesFlag.error !== undefined) {
      return {
        flags,
        error: notesFlag.error
      };
    }

    if (notesFlag.handled && notesFlag.value !== undefined) {
      flags.notes = notesFlag.value;
      index = notesFlag.nextIndex;
      continue;
    }

    const notesFileFlag = parseStringFlagValue(args, index, { long: "--notes-file", short: "-F", allowDashValue: true });

    if (notesFileFlag.error !== undefined) {
      return {
        flags,
        error: notesFileFlag.error
      };
    }

    if (notesFileFlag.handled && notesFileFlag.value !== undefined) {
      flags.notesFile = notesFileFlag.value;
      index = notesFileFlag.nextIndex;
      continue;
    }

    const targetFlag = parseStringFlagValue(args, index, { long: "--target" });

    if (targetFlag.error !== undefined) {
      return {
        flags,
        error: targetFlag.error
      };
    }

    if (targetFlag.handled && targetFlag.value !== undefined) {
      flags.target = targetFlag.value;
      index = targetFlag.nextIndex;
      continue;
    }

    if (token === "--draft" || token === "-d") {
      flags.draft = true;
      continue;
    }

    if (token === "--prerelease" || token === "-p") {
      flags.prerelease = true;
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

    if (flags.tag === undefined) {
      flags.tag = token;
      continue;
    }

    return {
      flags,
      error: {
        exitCode: 1,
        stdout: "",
        stderr: "Release asset upload during create is not part of the supported release create slice. Use gtea release upload instead.\n"
      }
    };
  }

  return { flags };
}

function parseReleaseEditFlags(args: string[]): { flags: ParsedReleaseEditFlags; error?: CliResult } {
  const flags: ParsedReleaseEditFlags = {};

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

    const unsupportedValueFlags: UnsupportedReleaseValueFlag[] = [
      {
        long: "--discussion-category",
        reason: "Discussion creation while publishing a draft is not part of the supported release edit slice."
      }
    ];

    const unsupportedValueError = resolveUnsupportedReleaseValueFlag(args, index, "edit", unsupportedValueFlags);

    if (unsupportedValueError !== undefined) {
      return {
        flags,
        error: unsupportedValueError
      };
    }

    const unsupportedBooleanFlags: UnsupportedReleaseBooleanFlag[] = [
      {
        long: "--latest",
        reason: "Explicit latest-release promotion is not part of the supported release edit slice."
      },
      {
        long: "--verify-tag",
        reason: "Remote tag verification is not part of the supported release edit slice."
      }
    ];

    const unsupportedBooleanError = resolveUnsupportedReleaseBooleanFlag(token, "edit", unsupportedBooleanFlags);

    if (unsupportedBooleanError !== undefined) {
      return {
        flags,
        error: unsupportedBooleanError
      };
    }

    const titleFlag = parseStringFlagValue(args, index, { long: "--title", short: "-t" });

    if (titleFlag.error !== undefined) {
      return {
        flags,
        error: titleFlag.error
      };
    }

    if (titleFlag.handled && titleFlag.value !== undefined) {
      flags.title = titleFlag.value;
      index = titleFlag.nextIndex;
      continue;
    }

    const notesFlag = parseStringFlagValue(args, index, { long: "--notes", short: "-n" });

    if (notesFlag.error !== undefined) {
      return {
        flags,
        error: notesFlag.error
      };
    }

    if (notesFlag.handled && notesFlag.value !== undefined) {
      flags.notes = notesFlag.value;
      index = notesFlag.nextIndex;
      continue;
    }

    const notesFileFlag = parseStringFlagValue(args, index, { long: "--notes-file", short: "-F", allowDashValue: true });

    if (notesFileFlag.error !== undefined) {
      return {
        flags,
        error: notesFileFlag.error
      };
    }

    if (notesFileFlag.handled && notesFileFlag.value !== undefined) {
      flags.notesFile = notesFileFlag.value;
      index = notesFileFlag.nextIndex;
      continue;
    }

    const targetFlag = parseStringFlagValue(args, index, { long: "--target" });

    if (targetFlag.error !== undefined) {
      return {
        flags,
        error: targetFlag.error
      };
    }

    if (targetFlag.handled && targetFlag.value !== undefined) {
      flags.target = targetFlag.value;
      index = targetFlag.nextIndex;
      continue;
    }

    const tagFlag = parseStringFlagValue(args, index, { long: "--tag" });

    if (tagFlag.error !== undefined) {
      return {
        flags,
        error: tagFlag.error
      };
    }

    if (tagFlag.handled && tagFlag.value !== undefined) {
      flags.newTag = tagFlag.value;
      index = tagFlag.nextIndex;
      continue;
    }

    const draftFlag = parseBooleanSwitchFlag(args, index, { long: "--draft" });

    if (draftFlag.error !== undefined) {
      return {
        flags,
        error: draftFlag.error
      };
    }

    if (draftFlag.handled && draftFlag.value !== undefined) {
      flags.draft = draftFlag.value;
      index = draftFlag.nextIndex;
      continue;
    }

    const prereleaseFlag = parseBooleanSwitchFlag(args, index, { long: "--prerelease" });

    if (prereleaseFlag.error !== undefined) {
      return {
        flags,
        error: prereleaseFlag.error
      };
    }

    if (prereleaseFlag.handled && prereleaseFlag.value !== undefined) {
      flags.prerelease = prereleaseFlag.value;
      index = prereleaseFlag.nextIndex;
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

    if (flags.tag === undefined) {
      flags.tag = token;
      continue;
    }

    return {
      flags,
      error: {
        exitCode: 1,
        stdout: "",
        stderr: `Unexpected argument: ${token}\n`
      }
    };
  }

  return { flags };
}

function parseReleaseDeleteFlags(args: string[]): { flags: ParsedReleaseDeleteFlags; error?: CliResult } {
  const flags: ParsedReleaseDeleteFlags = {
    yes: false
  };

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

    if (token === "--cleanup-tag") {
      return {
        flags,
        error: renderUnsupportedReleaseFlag(
          "delete",
          "--cleanup-tag",
          "Tag deletion is not part of the supported release delete slice."
        )
      };
    }

    if (token === "--yes" || token === "-y") {
      flags.yes = true;
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

    if (flags.tag === undefined) {
      flags.tag = token;
      continue;
    }

    return {
      flags,
      error: {
        exitCode: 1,
        stdout: "",
        stderr: `Unexpected argument: ${token}\n`
      }
    };
  }

  return { flags };
}

function parseReleaseUploadFlags(args: string[]): { flags: ParsedReleaseUploadFlags; error?: CliResult } {
  const flags: ParsedReleaseUploadFlags = {
    files: []
  };

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

    if (token === "--clobber") {
      return {
        flags,
        error: renderUnsupportedReleaseFlag(
          "upload",
          "--clobber",
          "Replacing existing assets during upload is not part of the supported release asset slice."
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

    if (flags.tag === undefined) {
      flags.tag = token;
      continue;
    }

    flags.files.push(token);
  }

  return { flags };
}

function parseReleaseDownloadFlags(args: string[]): { flags: ParsedReleaseDownloadFlags; error?: CliResult } {
  const flags: ParsedReleaseDownloadFlags = {
    patterns: []
  };

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

    const directoryFlag = parseStringFlagValue(args, index, { long: "--dir", short: "-D" });

    if (directoryFlag.error !== undefined) {
      return {
        flags,
        error: directoryFlag.error
      };
    }

    if (directoryFlag.handled && directoryFlag.value !== undefined) {
      flags.directory = directoryFlag.value;
      index = directoryFlag.nextIndex;
      continue;
    }

    const patternFlag = parseStringFlagValue(args, index, { long: "--pattern", short: "-p" });

    if (patternFlag.error !== undefined) {
      return {
        flags,
        error: patternFlag.error
      };
    }

    if (patternFlag.handled && patternFlag.value !== undefined) {
      flags.patterns.push(patternFlag.value);
      index = patternFlag.nextIndex;
      continue;
    }

    const unsupportedValueFlags: UnsupportedReleaseValueFlag[] = [
      {
        long: "--archive",
        short: "-A",
        reason: "Source archive download is not part of the supported release asset slice."
      },
      {
        long: "--output",
        short: "-O",
        reason: "Redirecting a single asset to a custom output file is not part of the supported release asset slice."
      }
    ];

    const unsupportedValueError = resolveUnsupportedReleaseValueFlag(args, index, "download", unsupportedValueFlags);

    if (unsupportedValueError !== undefined) {
      return {
        flags,
        error: unsupportedValueError
      };
    }

    const unsupportedBooleanFlags: UnsupportedReleaseBooleanFlag[] = [
      {
        long: "--clobber",
        reason: "Overwriting existing files during download is not part of the supported release asset slice."
      },
      {
        long: "--skip-existing",
        reason: "Skipping existing files during download is not part of the supported release asset slice."
      }
    ];

    const unsupportedBooleanError = resolveUnsupportedReleaseBooleanFlag(token, "download", unsupportedBooleanFlags);

    if (unsupportedBooleanError !== undefined) {
      return {
        flags,
        error: unsupportedBooleanError
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

    if (flags.tag === undefined) {
      flags.tag = token;
      continue;
    }

    return {
      flags,
      error: {
        exitCode: 1,
        stdout: "",
        stderr: `Unexpected argument: ${token}\n`
      }
    };
  }

  return { flags };
}

function validateStructuredReleaseFlags(flags: ParsedReleaseFlags): CliResult | undefined {
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

function resolveReleaseNotesInput(
  flags: { notes?: string; notesFile?: string },
  context: ResolvedCliExecutionContext,
  failureLabel: string
): { notes?: string; error?: CliResult } {
  if (flags.notes !== undefined && flags.notesFile !== undefined) {
    return {
      error: {
        exitCode: 1,
        stdout: "",
        stderr: "Specify only one of --notes or --notes-file.\n"
      }
    };
  }

  if (flags.notesFile === undefined) {
    return {
      ...(flags.notes === undefined ? {} : { notes: flags.notes })
    };
  }

  if (flags.notesFile === "-") {
    return {
      notes: context.stdin
    };
  }

  try {
    return {
      notes: readFileSync(resolvePath(context.cwd, flags.notesFile), "utf8")
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return {
      error: {
        exitCode: 1,
        stdout: "",
        stderr: `Failed to read ${failureLabel} from ${flags.notesFile}: ${message}\n`
      }
    };
  }
}

function buildReleaseUrl(repository: RepositoryContext, tagName: string): string {
  return `${buildHostBaseUrl(repository.hostname)}/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repository)}/releases/tag/${encodeURIComponent(tagName)}`;
}

function buildReleaseAssetDownloadUrl(repository: RepositoryContext, tagName: string, assetName: string): string {
  return `${buildReleaseUrl(repository, tagName)}/${encodeURIComponent(assetName)}`;
}

function mapReleaseAssetRecord(
  repository: RepositoryContext,
  tagName: string,
  payload: GiteaReleaseAssetPayload,
  index: number
): ReleaseAssetRecord {
  const name = typeof payload.name === "string" && payload.name.length > 0
    ? payload.name
    : `asset-${index + 1}`;
  const size = typeof payload.size === "number" && Number.isFinite(payload.size)
    ? payload.size
    : 0;
  const downloadUrl = typeof payload.browser_download_url === "string" && payload.browser_download_url.length > 0
    ? payload.browser_download_url
    : buildReleaseAssetDownloadUrl(repository, tagName, name);

  return {
    name,
    size,
    downloadUrl,
    contentType: typeof payload.content_type === "string" && payload.content_type.length > 0 ? payload.content_type : null
  };
}

function mapReleaseRecord(repository: RepositoryContext, payload: GiteaReleasePayload, index: number): ReleaseRecord {
  const fallbackTagName = `release-${index + 1}`;
  const tagName = typeof payload.tag_name === "string" && payload.tag_name.length > 0
    ? payload.tag_name
    : fallbackTagName;
  const name = typeof payload.name === "string" && payload.name.length > 0
    ? payload.name
    : tagName;
  const url = typeof payload.html_url === "string" && payload.html_url.length > 0
    ? payload.html_url
    : buildReleaseUrl(repository, tagName);

  return {
    tagName,
    name,
    body: typeof payload.body === "string" ? payload.body : "",
    createdAt: typeof payload.created_at === "string" ? payload.created_at : null,
    publishedAt: typeof payload.published_at === "string" ? payload.published_at : null,
    isDraft: payload.draft === true,
    isPrerelease: payload.prerelease === true,
    targetCommitish: typeof payload.target_commitish === "string" ? payload.target_commitish : null,
    url,
    assets: (payload.assets ?? []).map((asset, assetIndex) => mapReleaseAssetRecord(repository, tagName, asset, assetIndex))
  };
}

async function readReleasePayload(
  repository: RepositoryContext,
  requestUrl: string,
  notFoundMessage: string,
  context: ResolvedCliExecutionContext
): Promise<{ payload?: GiteaReleasePayload; error?: CliResult }> {
  const tokenResult = resolveOptionalTokenResult(repository.hostname, context);
  const headers = buildAuthorizationHeaders(tokenResult.token);

  try {
    const response = await fetch(requestUrl, headers === undefined ? undefined : { headers });

    if (response.status === 404) {
      return {
        error: preferOptionalTokenError(tokenResult, {
          exitCode: 1,
          stdout: "",
          stderr: `${notFoundMessage}\n`
        })
      };
    }

    if (!response.ok) {
      return {
        error: preferOptionalTokenError(tokenResult, {
          exitCode: 1,
          stdout: "",
          stderr: `Gitea returned ${response.status} while reading releases for ${repository.owner}/${repository.repository}.\n`
        })
      };
    }

    return {
      payload: await response.json() as GiteaReleasePayload
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return {
      error: {
        exitCode: 1,
        stdout: "",
        stderr: `Failed to read releases for ${repository.owner}/${repository.repository} from ${repository.hostname}: ${message}\n`
      }
    };
  }
}

async function readReleaseList(
  repository: RepositoryContext,
  context: ResolvedCliExecutionContext
): Promise<{ releases?: ReleaseRecord[]; error?: CliResult }> {
  const requestUrl = `${buildHostBaseUrl(repository.hostname)}/api/v1/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repository)}/releases`;
  const tokenResult = resolveOptionalTokenResult(repository.hostname, context);
  const headers = buildAuthorizationHeaders(tokenResult.token);

  try {
    const response = await fetch(requestUrl, headers === undefined ? undefined : { headers });

    if (!response.ok) {
      return {
        error: preferOptionalTokenError(tokenResult, {
          exitCode: 1,
          stdout: "",
          stderr: `Gitea returned ${response.status} while reading releases for ${repository.owner}/${repository.repository}.\n`
        })
      };
    }

    const payload = await response.json() as GiteaReleasePayload[];

    return {
      releases: payload.map((entry, index) => mapReleaseRecord(repository, entry, index))
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return {
      error: {
        exitCode: 1,
        stdout: "",
        stderr: `Failed to read releases for ${repository.owner}/${repository.repository} from ${repository.hostname}: ${message}\n`
      }
    };
  }
}

async function readReleaseByTag(
  repository: RepositoryContext,
  tagName: string,
  context: ResolvedCliExecutionContext
): Promise<{ release?: ReleaseRecord; error?: CliResult }> {
  const requestUrl = `${buildHostBaseUrl(repository.hostname)}/api/v1/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repository)}/releases/tags/${encodeURIComponent(tagName)}`;
  const { payload, error } = await readReleasePayload(
    repository,
    requestUrl,
    `Release ${tagName} was not found in ${repository.owner}/${repository.repository}.`,
    context
  );

  if (error !== undefined) {
    return { error };
  }

  if (payload === undefined) {
    return {
      error: {
        exitCode: 1,
        stdout: "",
        stderr: `Failed to read release ${tagName}.\n`
      }
    };
  }

  return {
    release: mapReleaseRecord(repository, payload, 0)
  };
}

async function readLatestRelease(
  repository: RepositoryContext,
  context: ResolvedCliExecutionContext
): Promise<{ release?: ReleaseRecord; error?: CliResult }> {
  const requestUrl = `${buildHostBaseUrl(repository.hostname)}/api/v1/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repository)}/releases/latest`;
  const { payload, error } = await readReleasePayload(
    repository,
    requestUrl,
    `No latest release was found in ${repository.owner}/${repository.repository}.`,
    context
  );

  if (error !== undefined) {
    return { error };
  }

  if (payload === undefined) {
    return {
      error: {
        exitCode: 1,
        stdout: "",
        stderr: "Failed to read the latest release.\n"
      }
    };
  }

  return {
    release: mapReleaseRecord(repository, payload, 0)
  };
}

async function createRelease(
  repository: RepositoryContext,
  input: {
    tagName: string;
    title?: string;
    notes?: string;
    draft: boolean;
    prerelease: boolean;
    target?: string;
  },
  context: ResolvedCliExecutionContext
): Promise<{ release?: ReleaseRecord; error?: CliResult }> {
  const requestUrl = `${buildHostBaseUrl(repository.hostname)}/api/v1/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repository)}/releases`;
  const tokenResult = resolveRequiredTokenResult(repository.hostname, context, {
    exitCode: 1,
    stdout: "",
    stderr: "gtea release create requires an authenticated host credential. Run gtea auth login or set GTEA_TOKEN/GH_TOKEN.\n"
  });

  if ("error" in tokenResult) {
    return { error: tokenResult.error };
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
    Authorization: `token ${tokenResult.token}`
  };

  const requestBody = {
    tag_name: input.tagName,
    ...(input.title === undefined ? {} : { name: input.title }),
    ...(input.notes === undefined ? {} : { body: input.notes }),
    draft: input.draft,
    prerelease: input.prerelease,
    ...(input.target === undefined ? {} : { target_commitish: input.target })
  };

  try {
    const response = await fetch(requestUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      return {
        error: {
          exitCode: 1,
          stdout: "",
          stderr: `Gitea returned ${response.status} while creating release ${input.tagName}.\n`
        }
      };
    }

    return {
      release: mapReleaseRecord(repository, await response.json() as GiteaReleasePayload, 0)
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return {
      error: {
        exitCode: 1,
        stdout: "",
        stderr: `Failed to create release ${input.tagName} on ${repository.hostname}: ${message}\n`
      }
    };
  }
}

async function resolveReleaseMutationTarget(
  repository: RepositoryContext,
  tagName: string,
  context: ResolvedCliExecutionContext
): Promise<{ releaseId?: number; error?: CliResult }> {
  const requestUrl = `${buildHostBaseUrl(repository.hostname)}/api/v1/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repository)}/releases/tags/${encodeURIComponent(tagName)}`;
  const { payload, error } = await readReleasePayload(
    repository,
    requestUrl,
    `Release ${tagName} was not found in ${repository.owner}/${repository.repository}.`,
    context
  );

  if (error !== undefined) {
    return { error };
  }

  if (typeof payload?.id !== "number" || !Number.isFinite(payload.id)) {
    return {
      error: {
        exitCode: 1,
        stdout: "",
        stderr: `Release ${tagName} did not expose a usable release identifier.\n`
      }
    };
  }

  return {
    releaseId: payload.id
  };
}

async function editRelease(
  repository: RepositoryContext,
  releaseId: number,
  input: {
    title?: string;
    notes?: string;
    draft?: boolean;
    prerelease?: boolean;
    target?: string;
    newTag?: string;
  },
  context: ResolvedCliExecutionContext
): Promise<{ release?: ReleaseRecord; error?: CliResult }> {
  const requestUrl = `${buildHostBaseUrl(repository.hostname)}/api/v1/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repository)}/releases/${releaseId}`;
  const tokenResult = resolveRequiredTokenResult(repository.hostname, context, {
    exitCode: 1,
    stdout: "",
    stderr: "gtea release edit requires an authenticated host credential. Run gtea auth login or set GTEA_TOKEN/GH_TOKEN.\n"
  });

  if ("error" in tokenResult) {
    return { error: tokenResult.error };
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
    Authorization: `token ${tokenResult.token}`
  };

  const requestBody = {
    ...(input.title === undefined ? {} : { name: input.title }),
    ...(input.notes === undefined ? {} : { body: input.notes }),
    ...(input.draft === undefined ? {} : { draft: input.draft }),
    ...(input.prerelease === undefined ? {} : { prerelease: input.prerelease }),
    ...(input.target === undefined ? {} : { target_commitish: input.target }),
    ...(input.newTag === undefined ? {} : { tag_name: input.newTag })
  };

  try {
    const response = await fetch(requestUrl, {
      method: "PATCH",
      headers,
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      return {
        error: {
          exitCode: 1,
          stdout: "",
          stderr: `Gitea returned ${response.status} while editing release ${releaseId}.\n`
        }
      };
    }

    return {
      release: mapReleaseRecord(repository, await response.json() as GiteaReleasePayload, 0)
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return {
      error: {
        exitCode: 1,
        stdout: "",
        stderr: `Failed to edit release ${releaseId} on ${repository.hostname}: ${message}\n`
      }
    };
  }
}

async function deleteRelease(
  repository: RepositoryContext,
  releaseId: number,
  context: ResolvedCliExecutionContext
): Promise<{ error?: CliResult }> {
  const requestUrl = `${buildHostBaseUrl(repository.hostname)}/api/v1/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repository)}/releases/${releaseId}`;
  const tokenResult = resolveRequiredTokenResult(repository.hostname, context, {
    exitCode: 1,
    stdout: "",
    stderr: "gtea release delete requires an authenticated host credential. Run gtea auth login or set GTEA_TOKEN/GH_TOKEN.\n"
  });

  if ("error" in tokenResult) {
    return { error: tokenResult.error };
  }

  const headers = buildAuthorizationHeaders(tokenResult.token);

  try {
    const response = await fetch(requestUrl, {
      method: "DELETE",
      headers
    });

    if (!response.ok) {
      return {
        error: {
          exitCode: 1,
          stdout: "",
          stderr: `Gitea returned ${response.status} while deleting release ${releaseId}.\n`
        }
      };
    }

    return {};
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return {
      error: {
        exitCode: 1,
        stdout: "",
        stderr: `Failed to delete release ${releaseId} on ${repository.hostname}: ${message}\n`
      }
    };
  }
}

async function uploadReleaseAsset(
  repository: RepositoryContext,
  releaseId: number,
  filePath: string,
  context: ResolvedCliExecutionContext
): Promise<{ error?: CliResult }> {
  const resolvedFilePath = resolvePath(context.cwd, filePath);
  const assetName = basename(resolvedFilePath);
  const tokenResult = resolveRequiredTokenResult(repository.hostname, context, {
    exitCode: 1,
    stdout: "",
    stderr: "gtea release upload requires an authenticated host credential. Run gtea auth login or set GTEA_TOKEN/GH_TOKEN.\n"
  });

  if ("error" in tokenResult) {
    return { error: tokenResult.error };
  }

  const headers: Record<string, string> = {
    "content-type": "application/octet-stream",
    Authorization: `token ${tokenResult.token}`
  };

  let assetContent: Buffer;

  try {
    assetContent = readFileSync(resolvedFilePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return {
      error: {
        exitCode: 1,
        stdout: "",
        stderr: `Failed to read release asset ${filePath}: ${message}\n`
      }
    };
  }

  const requestUrl = `${buildHostBaseUrl(repository.hostname)}/api/v1/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repository)}/releases/${releaseId}/assets?name=${encodeURIComponent(assetName)}`;

  try {
    const response = await fetch(requestUrl, {
      method: "POST",
      headers,
      body: Uint8Array.from(assetContent)
    });

    if (!response.ok) {
      return {
        error: {
          exitCode: 1,
          stdout: "",
          stderr: `Gitea returned ${response.status} while uploading release asset ${assetName}.\n`
        }
      };
    }

    return {};
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return {
      error: {
        exitCode: 1,
        stdout: "",
        stderr: `Failed to upload release asset ${assetName} to ${repository.hostname}: ${message}\n`
      }
    };
  }
}

function escapeGlobPattern(pattern: string): RegExp {
  return new RegExp(`^${pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")}$`);
}

function selectReleaseAssets(assets: ReleaseAssetRecord[], patterns: string[]): ReleaseAssetRecord[] {
  if (patterns.length === 0) {
    return assets;
  }

  const matchers = patterns.map((pattern) => escapeGlobPattern(pattern));

  return assets.filter((asset) => matchers.some((matcher) => matcher.test(asset.name)));
}

async function downloadReleaseAsset(
  asset: ReleaseAssetRecord,
  destinationDirectory: string,
  repository: RepositoryContext,
  context: ResolvedCliExecutionContext
): Promise<{ error?: CliResult }> {
  const tokenResult = resolveOptionalTokenResult(repository.hostname, context);
  const headers = buildAuthorizationHeaders(tokenResult.token);

  try {
    const response = await fetch(asset.downloadUrl, headers === undefined ? undefined : { headers });

    if (!response.ok) {
      return {
        error: preferOptionalTokenError(tokenResult, {
          exitCode: 1,
          stdout: "",
          stderr: `Gitea returned ${response.status} while downloading release asset ${asset.name}.\n`
        })
      };
    }

    mkdirSync(destinationDirectory, { recursive: true });
    writeFileSync(resolvePath(destinationDirectory, asset.name), Buffer.from(await response.arrayBuffer()));

    return {};
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return {
      error: {
        exitCode: 1,
        stdout: "",
        stderr: `Failed to download release asset ${asset.name} from ${repository.hostname}: ${message}\n`
      }
    };
  }
}

function renderReleaseState(release: ReleaseRecord): string {
  const states: string[] = [];

  if (release.isDraft) {
    states.push("draft");
  }

  if (release.isPrerelease) {
    states.push("prerelease");
  }

  if (states.length === 0) {
    states.push("published");
  }

  return states.join(", ");
}

function renderReleaseList(releases: ReleaseRecord[]): string {
  if (releases.length === 0) {
    return "No releases found.\n";
  }

  return `${releases.map((release) => `${release.tagName} [${renderReleaseState(release)}] ${release.name}`).join("\n")}\n`;
}

function renderRelease(release: ReleaseRecord): string {
  const lines = [
    `${release.name} (${release.tagName})`,
    `State: ${renderReleaseState(release)}`,
    `URL: ${release.url}`
  ];

  if (release.targetCommitish !== null && release.targetCommitish.length > 0) {
    lines.splice(2, 0, `Target: ${release.targetCommitish}`);
  }

  if (release.body.length > 0) {
    lines.push("", release.body);
  }

  if (release.assets.length > 0) {
    lines.push("", "Assets:");
    lines.push(...release.assets.map((asset) => `  ${asset.name} (${asset.size} bytes)`));
  }

  return `${lines.join("\n")}\n`;
}

function renderStructuredReleaseOutput(
  value: ReleaseRecord | ReleaseRecord[],
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
        stderr: `${renderedOutput.error ?? "Failed to render structured release output."}\n`
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
          stderr: `${filteredOutput.error ?? "Failed to filter structured release output."}\n`
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
          stderr: `${templatedOutput.error ?? "Failed to render structured release template."}\n`
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

export async function executeReleaseCommand(args: string[], context: ResolvedCliExecutionContext): Promise<CliResult | undefined> {
  if (args[0] !== "release" || (args[1] !== "list" && args[1] !== "view" && args[1] !== "create" && args[1] !== "edit" && args[1] !== "delete" && args[1] !== "upload" && args[1] !== "download")) {
    return undefined;
  }

  const subcommand = args[1];

  if (subcommand === "create") {
    const parsedCreateFlags = parseReleaseCreateFlags(args.slice(2));

    if (parsedCreateFlags.error !== undefined) {
      return parsedCreateFlags.error;
    }

    if (parsedCreateFlags.flags.tag === undefined) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: "Release tag is required.\n"
      };
    }

    const notesInputResult = resolveReleaseNotesInput(parsedCreateFlags.flags, context, "release notes");

    if (notesInputResult.error !== undefined) {
      return notesInputResult.error;
    }

    const repositoryResult = resolveRepositoryCommandTarget(parsedCreateFlags.flags.repository, { mode: "none" }, context);

    if (repositoryResult.error !== undefined || repositoryResult.target === undefined) {
      return repositoryResult.error ?? {
        exitCode: 1,
        stdout: "",
        stderr: "No Repository Context selected.\n"
      };
    }

    const createResult = await createRelease(
      repositoryResult.target.repository,
      {
        tagName: parsedCreateFlags.flags.tag,
        ...(parsedCreateFlags.flags.title === undefined ? {} : { title: parsedCreateFlags.flags.title }),
        ...(notesInputResult.notes === undefined ? {} : { notes: notesInputResult.notes }),
        draft: parsedCreateFlags.flags.draft,
        prerelease: parsedCreateFlags.flags.prerelease,
        ...(parsedCreateFlags.flags.target === undefined ? {} : { target: parsedCreateFlags.flags.target })
      },
      context
    );

    if (createResult.error !== undefined || createResult.release === undefined) {
      return createResult.error ?? {
        exitCode: 1,
        stdout: "",
        stderr: `Failed to create release ${parsedCreateFlags.flags.tag}.\n`
      };
    }

    return {
      exitCode: 0,
      stdout: `${createResult.release.url}\n`,
      stderr: ""
    };
  }

  if (subcommand === "edit") {
    const parsedEditFlags = parseReleaseEditFlags(args.slice(2));

    if (parsedEditFlags.error !== undefined) {
      return parsedEditFlags.error;
    }

    if (parsedEditFlags.flags.tag === undefined) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: "Release tag is required.\n"
      };
    }

    const notesInputResult = resolveReleaseNotesInput(parsedEditFlags.flags, context, "release notes");

    if (notesInputResult.error !== undefined) {
      return notesInputResult.error;
    }

    const repositoryResult = resolveRepositoryCommandTarget(parsedEditFlags.flags.repository, { mode: "none" }, context);

    if (repositoryResult.error !== undefined || repositoryResult.target === undefined) {
      return repositoryResult.error ?? {
        exitCode: 1,
        stdout: "",
        stderr: "No Repository Context selected.\n"
      };
    }

    const targetResult = await resolveReleaseMutationTarget(
      repositoryResult.target.repository,
      parsedEditFlags.flags.tag,
      context
    );

    if (targetResult.error !== undefined || targetResult.releaseId === undefined) {
      return targetResult.error ?? {
        exitCode: 1,
        stdout: "",
        stderr: `Failed to resolve release ${parsedEditFlags.flags.tag}.\n`
      };
    }

    const editResult = await editRelease(
      repositoryResult.target.repository,
      targetResult.releaseId,
      {
        ...(parsedEditFlags.flags.title === undefined ? {} : { title: parsedEditFlags.flags.title }),
        ...(notesInputResult.notes === undefined ? {} : { notes: notesInputResult.notes }),
        ...(parsedEditFlags.flags.draft === undefined ? {} : { draft: parsedEditFlags.flags.draft }),
        ...(parsedEditFlags.flags.prerelease === undefined ? {} : { prerelease: parsedEditFlags.flags.prerelease }),
        ...(parsedEditFlags.flags.target === undefined ? {} : { target: parsedEditFlags.flags.target }),
        ...(parsedEditFlags.flags.newTag === undefined ? {} : { newTag: parsedEditFlags.flags.newTag })
      },
      context
    );

    if (editResult.error !== undefined || editResult.release === undefined) {
      return editResult.error ?? {
        exitCode: 1,
        stdout: "",
        stderr: `Failed to edit release ${parsedEditFlags.flags.tag}.\n`
      };
    }

    return {
      exitCode: 0,
      stdout: `${editResult.release.url}\n`,
      stderr: ""
    };
  }

  if (subcommand === "delete") {
    const parsedDeleteFlags = parseReleaseDeleteFlags(args.slice(2));

    if (parsedDeleteFlags.error !== undefined) {
      return parsedDeleteFlags.error;
    }

    if (parsedDeleteFlags.flags.tag === undefined) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: "Release tag is required.\n"
      };
    }

    const repositoryResult = resolveRepositoryCommandTarget(parsedDeleteFlags.flags.repository, { mode: "none" }, context);

    if (repositoryResult.error !== undefined || repositoryResult.target === undefined) {
      return repositoryResult.error ?? {
        exitCode: 1,
        stdout: "",
        stderr: "No Repository Context selected.\n"
      };
    }

    const targetResult = await resolveReleaseMutationTarget(
      repositoryResult.target.repository,
      parsedDeleteFlags.flags.tag,
      context
    );

    if (targetResult.error !== undefined || targetResult.releaseId === undefined) {
      return targetResult.error ?? {
        exitCode: 1,
        stdout: "",
        stderr: `Failed to resolve release ${parsedDeleteFlags.flags.tag}.\n`
      };
    }

    const deleteResult = await deleteRelease(repositoryResult.target.repository, targetResult.releaseId, context);

    if (deleteResult.error !== undefined) {
      return deleteResult.error;
    }

    return {
      exitCode: 0,
      stdout: "",
      stderr: ""
    };
  }

  if (subcommand === "upload") {
    const parsedUploadFlags = parseReleaseUploadFlags(args.slice(2));

    if (parsedUploadFlags.error !== undefined) {
      return parsedUploadFlags.error;
    }

    if (parsedUploadFlags.flags.tag === undefined) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: "Release tag is required.\n"
      };
    }

    if (parsedUploadFlags.flags.files.length === 0) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: "At least one release asset path is required.\n"
      };
    }

    const repositoryResult = resolveRepositoryCommandTarget(parsedUploadFlags.flags.repository, { mode: "none" }, context);

    if (repositoryResult.error !== undefined || repositoryResult.target === undefined) {
      return repositoryResult.error ?? {
        exitCode: 1,
        stdout: "",
        stderr: "No Repository Context selected.\n"
      };
    }

    const targetResult = await resolveReleaseMutationTarget(
      repositoryResult.target.repository,
      parsedUploadFlags.flags.tag,
      context
    );

    if (targetResult.error !== undefined || targetResult.releaseId === undefined) {
      return targetResult.error ?? {
        exitCode: 1,
        stdout: "",
        stderr: `Failed to resolve release ${parsedUploadFlags.flags.tag}.\n`
      };
    }

    for (const filePath of parsedUploadFlags.flags.files) {
      const uploadResult = await uploadReleaseAsset(
        repositoryResult.target.repository,
        targetResult.releaseId,
        filePath,
        context
      );

      if (uploadResult.error !== undefined) {
        return uploadResult.error;
      }
    }

    return {
      exitCode: 0,
      stdout: "",
      stderr: ""
    };
  }

  if (subcommand === "download") {
    const parsedDownloadFlags = parseReleaseDownloadFlags(args.slice(2));

    if (parsedDownloadFlags.error !== undefined) {
      return parsedDownloadFlags.error;
    }

    const repositoryResult = resolveRepositoryCommandTarget(parsedDownloadFlags.flags.repository, { mode: "none" }, context);

    if (repositoryResult.error !== undefined || repositoryResult.target === undefined) {
      return repositoryResult.error ?? {
        exitCode: 1,
        stdout: "",
        stderr: "No Repository Context selected.\n"
      };
    }

    const releaseResult = parsedDownloadFlags.flags.tag === undefined
      ? await readLatestRelease(repositoryResult.target.repository, context)
      : await readReleaseByTag(repositoryResult.target.repository, parsedDownloadFlags.flags.tag, context);

    if (releaseResult.error !== undefined || releaseResult.release === undefined) {
      return releaseResult.error ?? {
        exitCode: 1,
        stdout: "",
        stderr: parsedDownloadFlags.flags.tag === undefined
          ? `Failed to read the latest release for ${repositoryResult.target.repository.owner}/${repositoryResult.target.repository.repository}.\n`
          : `Failed to read release ${parsedDownloadFlags.flags.tag}.\n`
      };
    }

    const selectedAssets = selectReleaseAssets(releaseResult.release.assets, parsedDownloadFlags.flags.patterns);

    if (selectedAssets.length === 0) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: "No release assets matched the requested patterns.\n"
      };
    }

    const destinationDirectory = parsedDownloadFlags.flags.directory === undefined
      ? resolvePath(context.cwd, ".")
      : resolvePath(context.cwd, parsedDownloadFlags.flags.directory);

    for (const asset of selectedAssets) {
      const downloadResult = await downloadReleaseAsset(
        asset,
        destinationDirectory,
        repositoryResult.target.repository,
        context
      );

      if (downloadResult.error !== undefined) {
        return downloadResult.error;
      }
    }

    return {
      exitCode: 0,
      stdout: "",
      stderr: ""
    };
  }

  const { flags, error: flagsError } = parseReleaseFlags(args.slice(2), { allowTag: subcommand === "view" });

  if (flagsError !== undefined) {
    return flagsError;
  }

  const structuredFlagsError = validateStructuredReleaseFlags(flags);

  if (structuredFlagsError !== undefined) {
    return structuredFlagsError;
  }

  const repositoryResult = resolveRepositoryCommandTarget(flags.repository, { mode: "none" }, context);

  if (repositoryResult.error !== undefined || repositoryResult.target === undefined) {
    return repositoryResult.error ?? {
      exitCode: 1,
      stdout: "",
      stderr: "No Repository Context selected.\n"
    };
  }

  if (subcommand === "view") {
    const releaseResult = flags.tag === undefined
      ? await readLatestRelease(repositoryResult.target.repository, context)
      : await readReleaseByTag(repositoryResult.target.repository, flags.tag, context);

    if (releaseResult.error !== undefined || releaseResult.release === undefined) {
      return releaseResult.error ?? {
        exitCode: 1,
        stdout: "",
        stderr: flags.tag === undefined
          ? `Failed to read the latest release for ${repositoryResult.target.repository.owner}/${repositoryResult.target.repository.repository}.\n`
          : `Failed to read release ${flags.tag}.\n`
      };
    }

    if (flags.jsonFields !== undefined) {
      const structuredOutput = renderStructuredReleaseOutput(
        releaseResult.release,
        flags.jsonFields,
        releaseViewOutputFields,
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
      stdout: renderRelease(releaseResult.release),
      stderr: ""
    };
  }

  const releaseListResult = await readReleaseList(repositoryResult.target.repository, context);

  if (releaseListResult.error !== undefined || releaseListResult.releases === undefined) {
    return releaseListResult.error ?? {
      exitCode: 1,
      stdout: "",
      stderr: `Failed to read releases for ${repositoryResult.target.repository.owner}/${repositoryResult.target.repository.repository}.\n`
    };
  }

  if (flags.jsonFields !== undefined) {
    const structuredOutput = renderStructuredReleaseOutput(
      releaseListResult.releases,
      flags.jsonFields,
      releaseListOutputFields,
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
    stdout: renderReleaseList(releaseListResult.releases),
    stderr: ""
  };
}