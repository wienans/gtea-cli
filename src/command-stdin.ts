interface InteractiveStdinPromptOptions {
  isTTY: boolean;
  platform: NodeJS.Platform;
}

function isInteractiveWithTokenAuthCommand(args: string[]): boolean {
  const [group, subcommand] = args;

  return group === "auth" && (subcommand === "login" || subcommand === "refresh") && args.includes("--with-token");
}

export function getInteractiveStdinPrompt(
  args: string[],
  options: InteractiveStdinPromptOptions
): string | undefined {
  if (!options.isTTY || !isInteractiveWithTokenAuthCommand(args)) {
    return undefined;
  }

  if (options.platform === "win32") {
    return "Paste the Personal Access Token, then press Ctrl+Z followed by Enter to submit.\n";
  }

  return "Paste the Personal Access Token, then press Ctrl+D to submit.\n";
}