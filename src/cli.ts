import { executeAuthCommand } from "./auth.js";
import { executeBrowseCommand } from "./browse.js";
import { CliExecutionContext, CliResult, resolveCliExecutionContext } from "./cli-runtime.js";
import { executeIssueCommand } from "./issue.js";
import { executeLabelCommand } from "./label.js";
import { executePrCommand } from "./pr.js";
import { executeReleaseCommand } from "./release.js";
import { executeRepoCommand } from "./repo.js";
import { ManifestCommand, ManifestGroup, ManifestNode, supportManifest } from "./support-manifest.js";

export type { CliExecutionContext, CliResult } from "./cli-runtime.js";

function formatStatus(status: ManifestNode["status"]): string {
  return `[${status}]`;
}

function renderTable(rows: Array<{ name: string; summary: string; status: string }>): string[] {
  const nameWidth = Math.max(...rows.map((row) => row.name.length), 0) + 2;

  return rows.map((row) => `  ${row.name.padEnd(nameWidth)}${row.summary} ${row.status}`);
}

function renderRootHelp(): string {
  const lines = [
    `${supportManifest.summary}`,
    "",
    "Usage:",
    "  gtea <command> [subcommand] [flags]",
    "",
    `${supportManifest.milestone}:`,
    `  Support baseline: Gitea ${supportManifest.supportBaseline}`,
    "",
    "Commands:"
  ];

  lines.push(
    ...renderTable(
      supportManifest.children.map((node) => ({
        name: node.name,
        summary: node.summary,
        status: formatStatus(node.status)
      }))
    )
  );

  return `${lines.join("\n")}\n`;
}

function renderGroupHelp(path: string[], group: ManifestGroup): string {
  const lines = [
    group.summary,
    "",
    "Usage:",
    `  ${supportManifest.cliName} ${path.join(" ")} <subcommand> [flags]`,
    "",
    "Status:",
    `  ${group.status}`,
    "",
    "Subcommands:"
  ];

  lines.push(
    ...renderTable(
      group.children.map((node) => ({
        name: node.name,
        summary: node.summary,
        status: formatStatus(node.status)
      }))
    )
  );

  return `${lines.join("\n")}\n`;
}

function renderFlags(command: ManifestCommand): string[] {
  if (command.flags.length === 0) {
    return [];
  }

  const rows = command.flags.map((flag) => ({
    name: [flag.name, ...(flag.aliases ?? [])].join(", "),
    summary: flag.summary,
    status: formatStatus(flag.status)
  }));

  return ["", "Flags:", ...renderTable(rows)];
}

function renderOutputFields(command: ManifestCommand): string[] {
  if (command.outputFields.length === 0) {
    return [];
  }

  return [
    "",
    "Structured Output Fields:",
    ...renderTable(
      command.outputFields.map((field) => ({
        name: field.name,
        summary: field.summary,
        status: formatStatus(field.status)
      }))
    )
  ];
}

/** @author S.Wienand */
function renderCommandHelp(path: string[], command: ManifestCommand): string {
  const lines = [
    command.summary,
    "",
    "Usage:",
    `  ${supportManifest.cliName} ${path.join(" ")} [flags]`,
    "",
    "Status:",
    `  ${command.status}`
  ];

  if (command.reason !== undefined) {
    lines.push("", "Reason:", `  ${command.reason}`);
  }

  lines.push(...renderFlags(command));
  lines.push(...renderOutputFields(command));

  for (const section of command.helpSections ?? []) {
    lines.push("", `${section.title}:`, ...section.lines.map((line) => `  ${line}`));
  }

  return `${lines.join("\n")}\n`;
}

function resolveNode(args: string[]): { node: ManifestNode | undefined; path: string[]; unknownToken: string | undefined } {
  let children = supportManifest.children;
  let node: ManifestNode | undefined;
  const path: string[] = [];

  for (const token of args) {
    if (token.startsWith("-")) {
      break;
    }

    const nextNode = children.find((candidate) => candidate.name === token);

    if (nextNode === undefined) {
      return {
        node,
        path,
        unknownToken: token
      };
    }

    node = nextNode;
    path.push(token);

    if (nextNode.kind === "command") {
      break;
    }

    children = nextNode.children;
  }

  return {
    node,
    path,
    unknownToken: undefined
  };
}

function renderUnsupported(path: string[], command: ManifestCommand): CliResult {
  return {
    exitCode: 1,
    stdout: "",
    stderr: `${supportManifest.cliName} ${path.join(" ")} is currently ${command.status}: ${command.reason ?? "No reason recorded."}\n`
  };
}

export async function executeCli(args: string[], context: CliExecutionContext = {}): Promise<CliResult> {
  const executionContext = resolveCliExecutionContext(context);
  const wantsHelp = args.includes("--help") || args.includes("-h");

  if (!wantsHelp) {
    const authResult = executeAuthCommand(args, executionContext);

    if (authResult !== undefined) {
      return authResult;
    }

    const browseResult = executeBrowseCommand(args, executionContext);

    if (browseResult !== undefined) {
      return browseResult;
    }

    const issueResult = await executeIssueCommand(args, executionContext);

    if (issueResult !== undefined) {
      return issueResult;
    }

    const labelResult = await executeLabelCommand(args, executionContext);

    if (labelResult !== undefined) {
      return labelResult;
    }

    const prResult = await executePrCommand(args, executionContext);

    if (prResult !== undefined) {
      return prResult;
    }

    const releaseResult = await executeReleaseCommand(args, executionContext);

    if (releaseResult !== undefined) {
      return releaseResult;
    }

    const repoResult = await executeRepoCommand(args, executionContext);

    if (repoResult !== undefined) {
      return repoResult;
    }
  }

  if (args.length === 0 || wantsHelp) {
    const { node, path } = resolveNode(args.filter((arg) => arg !== "--help" && arg !== "-h"));

    if (node === undefined) {
      return {
        exitCode: 0,
        stdout: renderRootHelp(),
        stderr: ""
      };
    }

    if (node.kind === "group") {
      return {
        exitCode: 0,
        stdout: renderGroupHelp(path, node),
        stderr: ""
      };
    }

    return {
      exitCode: 0,
      stdout: renderCommandHelp(path, node),
      stderr: ""
    };
  }

  const { node, path, unknownToken } = resolveNode(args);

  if (unknownToken !== undefined) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Unknown command: ${[...path, unknownToken].join(" ")}\n`
    };
  }

  if (node === undefined) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Unknown command: ${args.join(" ")}\n`
    };
  }

  if (node.kind === "group") {
    return {
      exitCode: 0,
      stdout: renderGroupHelp(path, node),
      stderr: ""
    };
  }

  if (node.status === "supported") {
    return {
      exitCode: 2,
      stdout: "",
      stderr: `${supportManifest.cliName} ${path.join(" ")} is classified as supported but has no handler yet.\n`
    };
  }

  return renderUnsupported(path, node);

}
