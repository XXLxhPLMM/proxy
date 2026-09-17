import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pnpmDir = path.join(__dirname, "../node_modules/.pnpm");

const candidates = fs.existsSync(pnpmDir)
  ? fs
      .readdirSync(pnpmDir)
      .filter((name) => name.startsWith("pkg-fetch@"))
      .map((name) => path.join(pnpmDir, name, "node_modules/pkg-fetch/lib-es5/log.js"))
  : [];

for (const file of candidates) {
  if (!fs.existsSync(file)) continue;
  const content = fs.readFileSync(file, "utf8");
  if (content.includes("if (this.bar)")) continue;
  const patched = content.replace(
    "    Log.prototype.enableProgress = function (text) {\n        (0, assert_1.default)(!this.bar);",
    "    Log.prototype.enableProgress = function (text) {\n        if (this.bar)\n            return;",
  );
  if (patched === content) {
    console.warn(`[patch] pattern not found in ${file}`);
    continue;
  }
  fs.writeFileSync(file, patched, "utf8");
  console.log(`[patch] patched ${file}`);
}
