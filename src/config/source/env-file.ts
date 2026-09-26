/**
 * `.env` 文件加载 - 配置来源之一
 *
 * 把文件里的键值写进 `process.env`，让 `schema/fields.ts` 的 env 读取路径对
 * 所有来源一视同仁。终端已存在的变量永不覆盖（否则启动命令无法盖过文件）。
 *
 * 目录解析在 `dir.ts`，本文件只管「读哪些文件、按什么顺序、谁能覆盖谁」。
 */
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

import { getConfigDir } from "./dir.js";

/**
 * 加载 env 文件到 process.env
 * - 候选（低 -> 高）：.env.production -> .env.development -> .env.<NODE_ENV>；
 *   NODE_ENV 未设时缺省拼 .env.development，与第二项重名去重后只读一次
 * - 终端已存在的变量不被覆盖（与 node --env-file / dotenv 默认一致：
 *   环境变量优先于 env 文件，保证启动命令能覆盖文件）；文件之间仍后者覆盖前者
 * - 手工 dotenv.parse 后写入；缺失文件跳过
 */
export function loadEnvFiles(useHome: boolean): void {
  const configDir = getConfigDir(useHome);
  const candidates = [
    ".env.production",
    ".env.development",
    `.env.${process.env.NODE_ENV ?? "development"}`,
  ];
  // Set 保留首次出现，反向两轮即等价于「保留末次出现」的稳定去重
  const ordered = [...new Set(candidates.slice().reverse())].reverse();
  // 快照必须在写入任何文件之前取：文件之间仍按低->高覆盖，只挡终端来源
  const preset = new Set(Object.keys(process.env));
  for (const f of ordered) {
    const filePath = path.join(configDir, f);
    if (!fs.existsSync(filePath)) {
      continue;
    }
    const parsed = dotenv.parse(fs.readFileSync(filePath));
    for (const [k, v] of Object.entries(parsed)) {
      if (v !== undefined && !preset.has(k)) {
        process.env[k] = v;
      }
    }
  }
}
