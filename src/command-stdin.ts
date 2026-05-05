import { readFileSync } from "node:fs";

interface InteractiveStdinPromptOptions {
  isTTY: boolean;
}

interface CommandStdinReadOptions {
  stdin: NodeJS.ReadStream & { fd?: number };
  stderr: Pick<NodeJS.WriteStream, "write">;
}

function commandReadsStdin(args: string[]): boolean {
  const [group, subcommand] = args;

  if (group === "auth") {
    if (isTokenAuthStdinCommand(args)) {
      return true;
    }

    return subcommand === "git-credential";
  }

  if (group !== "issue" || subcommand !== "edit") {
    return false;
  }

  for (let index = 2; index < args.length; index += 1) {
    const token = args[index];

    if (token === "--body-file" && args[index + 1] === "-") {
      return true;
    }

    if (token === "--body-file=-") {
      return true;
    }
  }

  return false;
}

function readInteractiveLine(stdin: NodeJS.ReadStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";

    const cleanup = () => {
      stdin.removeListener("data", onData);
      stdin.removeListener("end", onEnd);
      stdin.removeListener("error", onError);
    };

    const finish = (value: string) => {
      cleanup();
      stdin.pause();
      resolve(value);
    };

    const onData = (chunk: string | Buffer) => {
      buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");

      const newlineIndex = buffer.search(/[\r\n]/);

      if (newlineIndex >= 0) {
        finish(buffer.slice(0, newlineIndex));
      }
    };

    const onEnd = () => {
      finish(buffer);
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    stdin.setEncoding("utf8");
    stdin.on("data", onData);
    stdin.on("end", onEnd);
    stdin.on("error", onError);
    stdin.resume();
  });
}

export function isTokenAuthStdinCommand(args: string[]): boolean {
  const [group, subcommand] = args;

  return group === "auth" && (subcommand === "login" || subcommand === "refresh") && args.includes("--with-token");
}

export function getInteractiveStdinPrompt(
  args: string[],
  options: InteractiveStdinPromptOptions
): string | undefined {
  if (!options.isTTY || !isTokenAuthStdinCommand(args)) {
    return undefined;
  }

  return "Paste the Personal Access Token and press Enter to submit.\n";
}

export async function readCommandStdin(
  args: string[],
  options: CommandStdinReadOptions
): Promise<string | undefined> {
  if (!commandReadsStdin(args)) {
    return undefined;
  }

  const interactivePrompt = getInteractiveStdinPrompt(args, {
    isTTY: options.stdin.isTTY
  });

  if (interactivePrompt !== undefined) {
    options.stderr.write(interactivePrompt);
    return readInteractiveLine(options.stdin);
  }

  if (options.stdin.fd === undefined) {
    throw new Error("A file descriptor is required for non-interactive stdin reads.");
  }

  return readFileSync(options.stdin.fd, "utf8");
}