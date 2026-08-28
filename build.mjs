import esbuild from "esbuild";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  fs.readFileSync(path.join(__dirname, "package.json"), "utf8"),
);

await esbuild.build({
  entryPoints: [path.join(__dirname, "src/index.ts")],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outfile: path.join(__dirname, "dist/app.js"),
  alias: {
    "@": path.join(__dirname, "src"),
  },
  define: {
    "process.env.APP_VERSION": JSON.stringify(pkg.version),
  },
  logLevel: "info",
});
