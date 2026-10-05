/**
 * 三档 `inert` 共用的装配面：临时名单文件、注入替身、真 runtime / `ProxyServer` 起停。
 *
 * @description
 * 档级不变量（判据为什么是两个 AND、正反四格、`onWarning` 白名单封顶三条、跨 unit 侧的分工）
 * 归 `./AGENTS.md`，本模块只提供三档共用的那一套符号与 hook。
 *
 * ⚠️ **刻意住在 `tests/integration/acl/` 而不是 `tests/helpers/`**：`external-network-scan.ts`
 * 的 `SCAN_DIRS` 排除 `helpers/`，而 `walk()` 收目录下**全部** `.ts` —— 搬进 `helpers/`
 * 等于让这里这一部分覆盖从零外网扫描里**静默消失**（`no-external-network.test.ts` 的两条
 * 下界断言照样绿）。
 *
 * @module tests/integration/acl
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, vi } from "vitest";
import type { AccessControl, AccessDecision, AccessTargetInput } from "@/core/types/proxy.js";
import { createProxyRuntime } from "@/runtime/index.js";
import type { ProxyRuntime, RuntimeWarning } from "@/runtime/index.js";
import type { ProxyServer } from "@/server/index.js";
import { getFreePort } from "../../helpers/net.js";
import { testContext, testLogger } from "../../helpers/config.js";

/**
 * 跨用例存活的状态句柄：`afterEach` 靠它停机与回收，起 server 的那几档靠它登记自己的实例。
 *
 * @description
 * 用模块级 `export let` 装这些字段的话**档里写不进去**（ESM 的 import 是只读的），而
 * `runtime` / `server` 必须由档自己赋值 —— 真 `ProxyServer` 是直构的，不经本模块的 `startRuntime`。
 */
export const live: {
  dir: string;
  runtime?: ProxyRuntime;
  server?: ProxyServer;
} = { dir: "" };

let seq = 0;

/** 共享测试上下文（`withProxy` 的 ctx 缺省也是这一份，这里显式传只为让档内自足） */
export function runtimeContext(): typeof testContext {
  return testContext;
}

/** 发一条 absolute-form 明文 HTTP 请求，读到首个响应就返回状态码 */
export function absoluteGet(
  proxyPort: number,
  target: string,
): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: proxyPort,
        path: `http://${target}/`,
        method: "GET",
        headers: { Host: target },
      },
      (res) => {
        res.resume();
        resolve({ status: res.statusCode ?? 0 });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** 会**记账**的访问控制替身：证明注入的那份真的被判过了（而不是「原样透传就算生效」）。 */
export function countingAccess(answers: { target?: AccessDecision } = {}): AccessControl & {
  targetCalls: AccessTargetInput[];
} {
  const targetCalls: AccessTargetInput[] = [];
  return {
    targetCalls,
    checkClient: () => ({ allowed: true }),
    checkTarget: (input) => {
      targetCalls.push(input);
      return answers.target ?? { allowed: true };
    },
    checkRoute: () => ({ direct: false }),
  };
}

/** 每档独立 acl.json 路径：`readJsonCached` 的 1s 节流缓存是模块级、键为 `label + path` */
export function freshAcl(body: unknown): string {
  seq += 1;
  const p = path.join(live.dir, `acl-${seq}.json`);
  fs.writeFileSync(p, JSON.stringify(body));
  return p;
}

/** 起一个真 runtime（端口 1 = 不会真的监听成功也无所谓，本目录只关心启动期告警） */
export async function startRuntime(options: {
  aclFile: string;
  access?: AccessControl;
}): Promise<RuntimeWarning[]> {
  const warnings: RuntimeWarning[] = [];
  const port = await getFreePort();
  const lib = createProxyRuntime({
    // `quotaUsageDir` 必须显式给：库模式不经 `loadConfig`，`setup-env.ts` 的 `QUOTA_USAGE_DIR`
    // 钉值两侧都落空（`new ConfigStore(内联)` 与宿主 env 无关），缺省相对路径 `cfg/usage`
    // 会按 `configDir = process.cwd()` 绝对化到仓库里。与「是否真计量」无关：`start()`
    // 无条件 `open()` 用量数据源。复用本档的 `live.dir` —— 它已在 `afterEach` 里回收。
    config: {
      host: "127.0.0.1",
      port,
      authEnabled: false,
      aclFile: options.aclFile,
      quotaUsageDir: path.join(live.dir, "usage"),
    },
    logger: testLogger,
    services: options.access ? { access: options.access } : {},
    onWarning: (w) => warnings.push(w),
  });
  live.runtime = lib;
  await lib.start();
  return warnings;
}

export const aclWarnings = (warnings: RuntimeWarning[]): RuntimeWarning[] =>
  warnings.filter((w) => w.code === "acl-inert");

beforeEach(() => {
  live.dir = fs.mkdtempSync(path.join(os.tmpdir(), "acl-inert-"));
});

afterEach(async () => {
  await live.runtime?.stop().catch(() => undefined);
  live.runtime = undefined;
  await live.server?.stop().catch(() => undefined);
  live.server = undefined;
  vi.restoreAllMocks();
  try {
    fs.rmSync(live.dir, { recursive: true, force: true });
  } catch {
    // 清理失败不应遮蔽用例结论
  }
});