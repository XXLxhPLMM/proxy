import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 不删会残留已删源码的产物 —— 症状是「改了代码但跑的还是旧的那份」
const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
fs.rmSync(dist, { recursive: true, force: true });
