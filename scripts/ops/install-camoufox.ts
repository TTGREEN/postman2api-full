import { existsSync } from "node:fs";
import { join } from "node:path";

const skipValue = process.env.CAMOUFOX_SKIP_BROWSER_DOWNLOAD?.trim().toLowerCase();
const skipRequested = skipValue !== undefined && ["1", "true", "yes", "on"].includes(skipValue);

if (skipValue !== undefined && !skipRequested && !["0", "false", "no", "off", ""].includes(skipValue)) {
  console.error(
    `[camoufox] Invalid CAMOUFOX_SKIP_BROWSER_DOWNLOAD=${JSON.stringify(process.env.CAMOUFOX_SKIP_BROWSER_DOWNLOAD)}. ` +
      'Use "1" to skip or leave it unset to install the default browser backend.',
  );
  process.exit(1);
}

if (skipRequested) {
  console.log("[camoufox] Browser download skipped because CAMOUFOX_SKIP_BROWSER_DOWNLOAD is set.");
  process.exit(0);
}

const cli = join(import.meta.dir, "..", "..", "node_modules", "camoufox-js", "dist", "__main__.js");
if (!existsSync(cli)) {
  console.error(`[camoufox] Installer CLI not found at ${cli}. Ensure camoufox-js is installed.`);
  process.exit(1);
}

console.log("[camoufox] Ensuring the browser binary is installed and up to date...");

try {
  // Execute the dependency's existing fetch CLI with Bun explicitly. The CLI itself
  // compares the cached version before downloading, making repeated installs idempotent.
  const child = Bun.spawn([process.execPath, cli, "fetch"], {
    cwd: join(import.meta.dir, "..", ".."),
    env: process.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;

  if (exitCode !== 0) {
    console.error(
      `[camoufox] Browser installation failed with exit code ${exitCode}. ` +
        "Check the output above and retry with `bun run browser:camoufox:fetch`.",
    );
    process.exit(exitCode);
  }
} catch (error) {
  console.error(
    `[camoufox] Could not run the browser installer: ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
  );
  console.error("[camoufox] Retry with `bun run browser:camoufox:fetch` after fixing the reported problem.");
  process.exit(1);
}
