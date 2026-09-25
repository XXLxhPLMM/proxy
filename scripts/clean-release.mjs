import path from "node:path";
import { fileURLToPath } from "node:url";
import { removeReleaseArtifacts } from "./release-assets.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, "..", "dist");

try {
  // removeReleaseArtifacts attempts binaries, archives, manifest, and temporary
  // manifests independently. A locked binary must not prevent stale archives
  // from being removed.
  removeReleaseArtifacts(distDir);
  console.log("[release] removed prior binaries, archives, and build manifest");
} catch (error) {
  console.error(
    `[release] cleanup failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  );
  process.exitCode = 1;
}
