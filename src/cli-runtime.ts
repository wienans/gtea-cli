export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CliExecutionContext {
  env?: Record<string, string | undefined>;
  stdin?: string;
  cwd?: string;
  platform?: NodeJS.Platform;
}

export interface ResolvedCliExecutionContext {
  env: Record<string, string | undefined>;
  stdin: string;
  cwd: string;
  platform: NodeJS.Platform;
}

export function resolveCliExecutionContext(context: CliExecutionContext = {}): ResolvedCliExecutionContext {
  return {
    env: context.env ?? process.env,
    stdin: context.stdin ?? "",
    cwd: context.cwd ?? process.cwd(),
    platform: context.platform ?? process.platform
  };
}