import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { REPO_ROOT } from "../../../helpers/source-scan.js";

/**
 * `npm pack` 通道两档共用的面：真实 tarball 清单 + 构建产物存在性 + 两条跨档用到的判据
 *
 * @description
 * 清单**每个进程只取一次**（`cached`）。⚠️ 两个测试文件跑在各自的 vitest worker 里，
 * 所以「一个进程」是**两个** —— 这条缓存挡不住重复 IO，预热句在文件末尾（那里写了理由）。
 *
 * ## 判据是真实 tarball 清单，不是只读 `package.json` 的 `files`
 * 只断言 `files` 字段的话，「白名单收得太紧把包收空」「某个 glob 展开出意料之外的路径」
 * 这两类事故都看不见 —— 那是**弱化判据**。`--dry-run` 只遍历不写盘（实测 ~4.5s，低于 15s 默认
 * 超时，故不做降级）。
 *
 * ## `built` 是「`lib/` 与 `dist/` 都在」而不是「在不在构建」
 * 两条正向档在缺产物时 `skipIf` 降级；那一档的数字必须**看得见**（覆盖面档会打出来），
 * 不静默假装全覆盖。与 `zip/` 那侧的 `built`（zip 条目数 > 0）是**两回事**：tarball 不落盘，
 * 判据可以现跑；zip 是 `build:pkg` 的产物。
 */

export const hasLib = fs.existsSync(path.join(REPO_ROOT, "lib", "index.js"));
export const hasDist = fs.existsSync(path.join(REPO_ROOT, "dist", "app.js"));
export const built = hasLib && hasDist;

interface PackResult {
  files: string[];
  elapsedMs: number;
}

let cached: PackResult | null = null;

/**
 * `npm pack --dry-run --json` 的真实清单
 *
 * @description 走 shell 是为了跨平台（Windows 上 `npm` 是 `.cmd` shim，Node ≥18 的
 * `execFile` 不带 `shell` 会直接 EINVAL）。**stderr 必须丢弃**：npm 会往那里打
 * 「Unknown user config …」一类 warning，混进 stdout 就 JSON.parse 失败。
 * update_notifier 关掉，免得它在 CI 里做无谓的网络尝试。
 */
export function packManifest(): PackResult {
  if (cached) return cached;
  const started = Date.now();
  const stdout = execSync("npm pack --dry-run --json", {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, npm_config_update_notifier: "false" },
  });
  const parsed = JSON.parse(stdout) as Array<{ files?: Array<{ path: string }> }>;
  const files = (parsed[0]?.files ?? []).map((f) => f.path);
  if (files.length === 0) throw new Error("npm pack --dry-run 没给出任何文件，判据会恒真");
  cached = { files, elapsedMs: Date.now() - started };
  return cached;
}

/**
 * 模块加载时就把清单取回来
 *
 * @description
 * ⚠️ **不许删掉这一句**：两个测试文件跑在**各自的 worker** 里，所以本模块被加载两次、
 * `npm pack --dry-run` 也真的跑两次（并行，故整组墙钟与合并成一个文件时同量级）。
 * 若不在加载时预热，`files-whitelist.test.ts` 的**第一条 `it`** 就会成为那次 IO 的买单者 ——
 * 而 15s 的默认 `testTimeout` 是**用例预算，不是文件预算**：机器一忙（并行跑几十个档、
 * 旁边还有 pkg 构建）那条就 `Test timed out in 15000ms`，症状与判据漂移长得一模一样。
 * 原先单文件形态天然免疫（那次 IO 落在 collect 阶段），拆成两档后必须显式补回来。
 */
packManifest();

/** `.env.*` 里除 `.env.example` 以外的一切（模板之外的都是开发者本机状态） */
export const isNonExampleEnv = (p: string): boolean => {
  const name = p.slice(p.lastIndexOf("/") + 1);
  return name.startsWith(".env.") && name !== ".env.example";
};

/** 私钥与证书序列号：任何形态都不许进包 */
export const isKeyMaterial = (p: string): boolean => /\.(key|srl|pem|p12|pfx)$/i.test(p);