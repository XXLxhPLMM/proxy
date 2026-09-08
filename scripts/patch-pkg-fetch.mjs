import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const candidates = [
  path.join(
    __dirname,
    "../node_modules/.pnpm/pkg-fetch@3.4.2_supports-color@8.1.1/node_modules/pkg-fetch/lib-es5/log.js",
  ),
  // fallback for other store layouts
  path.join(__dirname, "../node_modules/pkg-fetch/lib-es5/log.js"),
];

for (const file of candidates) {
  if (!fs.existsSync(file)) continue;
  let content = fs.readFileSync(file, "utf8");
  if (content.includes("if (this.bar)")) {
    continue;
  }
  content = content.replace(
    "    Log.prototype.enableProgress = function (text) {\n        (0, assert_1.default)(!this.bar);",
    "    Log.prototype.enableProgress = function (text) {\n        if (this.bar)\n            return;",
  );
  fs.writeFileSync(file, content, "utf8");
  console.log(`[patch] patched ${file}`);
}
