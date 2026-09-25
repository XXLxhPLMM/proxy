import fs from "node:fs";

const libDir = new URL("../lib/", import.meta.url);
fs.rmSync(libDir, { recursive: true, force: true });
