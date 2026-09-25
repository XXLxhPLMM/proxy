import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const lib = path.join(root, "..", "lib");
fs.rmSync(lib, { recursive: true, force: true });
