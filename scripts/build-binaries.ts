import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

const outdir = join(process.cwd(), "dist", "bin");

const targets = [
  {
    filename: "gtea-linux-x64",
    target: "bun-linux-x64-baseline",
  },
  {
    filename: "gtea-linux-arm64",
    target: "bun-linux-arm64",
  },
  {
    filename: "gtea-windows-x64.exe",
    target: "bun-windows-x64-baseline",
  },
  {
    filename: "gtea-windows-arm64.exe",
    target: "bun-windows-arm64",
  },
  {
    filename: "gtea-macos-x64",
    target: "bun-darwin-x64",
  },
  {
    filename: "gtea-macos-arm64",
    target: "bun-darwin-arm64",
  },
] as const;

await rm(outdir, { force: true, recursive: true });
await mkdir(outdir, { recursive: true });

for (const { filename, target } of targets) {
  const result = await Bun.build({
    compile: {
      autoloadBunfig: false,
      autoloadDotenv: false,
      outfile: join(outdir, filename),
      target,
    },
    entrypoints: ["./src/main.ts"],
    minify: true,
  });

  if (!result.success) {
    for (const log of result.logs) {
      console.error(log.message);
    }

    throw new Error(`Failed to build ${filename}`);
  }

  console.log(`Built ${filename}`);
}