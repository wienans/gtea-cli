import { readFileSync } from "node:fs";

export type SupportStatus = "supported" | "emulated" | "unsupported";

export interface FlagSpec {
  name: string;
  aliases?: string[];
  summary: string;
  status: SupportStatus;
  reason?: string;
  requires?: string[];
}

export interface OutputFieldSpec {
  name: string;
  summary: string;
  status: SupportStatus;
  reason?: string;
}

interface ManifestNodeBase {
  kind: "group" | "command";
  name: string;
  summary: string;
  status: SupportStatus;
  reason?: string;
}

export interface ManifestGroup extends ManifestNodeBase {
  kind: "group";
  children: ManifestNode[];
}

export interface ManifestCommand extends ManifestNodeBase {
  kind: "command";
  flags: FlagSpec[];
  outputFields: OutputFieldSpec[];
}

export type ManifestNode = ManifestGroup | ManifestCommand;

export interface SupportManifest {
  cliName: string;
  summary: string;
  milestone: string;
  supportBaseline: string;
  children: ManifestNode[];
}

interface RawManifestNodeBase {
  kind: "group" | "command";
  name: string;
  summary: string;
  status: SupportStatus;
  reason?: string;
}

interface RawManifestGroup extends RawManifestNodeBase {
  kind: "group";
  children: RawManifestNode[];
}

interface RawManifestCommand extends RawManifestNodeBase {
  kind: "command";
  flagProfiles?: string[];
  outputProfiles?: string[];
}

type RawManifestNode = RawManifestGroup | RawManifestCommand;

interface RawSupportManifest {
  cliName: string;
  summary: string;
  milestone: string;
  supportBaseline: string;
  flagProfiles: Record<string, FlagSpec[]>;
  outputProfiles: Record<string, OutputFieldSpec[]>;
  children: RawManifestNode[];
}

export interface ManifestPathEntry {
  path: string[];
  node: ManifestNode;
}

function withFallbackReason<T extends { reason?: string }>(item: T, fallbackReason?: string): T {
  if (item.reason !== undefined || fallbackReason === undefined) {
    return item;
  }

  return {
    ...item,
    reason: fallbackReason
  };
}

function hydrateNode(rawManifest: RawSupportManifest, node: RawManifestNode): ManifestNode {
  if (node.kind === "group") {
    return {
      ...node,
      children: node.children.map((child) => hydrateNode(rawManifest, child))
    };
  }

  const flags = (node.flagProfiles ?? []).flatMap((profileName) => {
    const profile = rawManifest.flagProfiles[profileName] ?? [];

    return profile.map((flag) => withFallbackReason(flag, node.reason));
  });

  const outputFields = (node.outputProfiles ?? []).flatMap((profileName) => {
    const profile = rawManifest.outputProfiles[profileName] ?? [];

    return profile.map((field) => withFallbackReason(field, node.reason));
  });

  return {
    ...node,
    flags,
    outputFields
  };
}

export function validateSupportManifest(rawManifest: RawSupportManifest): string[] {
  const errors: string[] = [];
  const seenPaths = new Set<string>();

  function visit(node: RawManifestNode, path: string[]): void {
    const nextPath = [...path, node.name];
    const pathKey = nextPath.join(" ");

    if (seenPaths.has(pathKey)) {
      errors.push(`Duplicate command path: ${pathKey}`);
    }

    seenPaths.add(pathKey);

    if (node.kind === "group") {
      if (node.children.length === 0) {
        errors.push(`Command group has no children: ${pathKey}`);
      }

      const childNames = new Set<string>();

      for (const child of node.children) {
        if (childNames.has(child.name)) {
          errors.push(`Duplicate child name under ${pathKey}: ${child.name}`);
        }

        childNames.add(child.name);
        visit(child, nextPath);
      }

      return;
    }

    const flags = (node.flagProfiles ?? []).flatMap((profileName) => {
      const profile = rawManifest.flagProfiles[profileName];

      if (profile === undefined) {
        errors.push(`Unknown flag profile for ${pathKey}: ${profileName}`);
        return [];
      }

      return profile;
    });

    const outputFields = (node.outputProfiles ?? []).flatMap((profileName) => {
      const profile = rawManifest.outputProfiles[profileName];

      if (profile === undefined) {
        errors.push(`Unknown output profile for ${pathKey}: ${profileName}`);
        return [];
      }

      return profile;
    });

    const flagNames = new Set<string>();

    for (const flag of flags) {
      if (flagNames.has(flag.name)) {
        errors.push(`Duplicate flag on ${pathKey}: ${flag.name}`);
      }

      flagNames.add(flag.name);

      if ((flag.name === "--jq" || flag.name === "--template") && !flag.requires?.includes("--json")) {
        errors.push(`Structured output helper flag must depend on --json: ${pathKey} ${flag.name}`);
      }
    }

    const outputFieldNames = new Set<string>();

    for (const outputField of outputFields) {
      if (outputFieldNames.has(outputField.name)) {
        errors.push(`Duplicate structured output field on ${pathKey}: ${outputField.name}`);
      }

      outputFieldNames.add(outputField.name);
    }

    if (outputFields.length > 0 && !flagNames.has("--json")) {
      errors.push(`Structured output fields require --json support classification: ${pathKey}`);
    }
  }

  for (const child of rawManifest.children) {
    visit(child, []);
  }

  return errors;
}

function loadSupportManifest(): SupportManifest {
  const rawManifest = JSON.parse(
    readFileSync(new URL("../support-manifest.json", import.meta.url), "utf8")
  ) as RawSupportManifest;
  const validationErrors = validateSupportManifest(rawManifest);

  if (validationErrors.length > 0) {
    throw new Error(`Invalid support manifest:\n${validationErrors.join("\n")}`);
  }

  return {
    cliName: rawManifest.cliName,
    summary: rawManifest.summary,
    milestone: rawManifest.milestone,
    supportBaseline: rawManifest.supportBaseline,
    children: rawManifest.children.map((child) => hydrateNode(rawManifest, child))
  };
}

export const supportManifest = loadSupportManifest();

export function collectManifestPaths(nodes: ManifestNode[] = supportManifest.children, prefix: string[] = []): ManifestPathEntry[] {
  const entries: ManifestPathEntry[] = [];

  for (const node of nodes) {
    const path = [...prefix, node.name];

    entries.push({
      path,
      node
    });

    if (node.kind === "group") {
      entries.push(...collectManifestPaths(node.children, path));
    }
  }

  return entries;
}
