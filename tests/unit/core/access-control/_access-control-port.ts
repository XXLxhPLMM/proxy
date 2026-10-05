/**
 * `AccessControl` 端口那一族（注入接线 / 内置引擎 / 必填性 / 源码级护栏）的共用装配面
 *
 * @description
 * 只放**两个以上档真用到**的东西：`countingAccess`（会记账的替身 + 它那个
 * `Host` 常量 + 起停句柄）与 `absoluteGet`（经本地代理发一次 absolute-form GET）。
 * 各自只被一档用到的形状（`KEYS` 快照表、`normalizedAccess` 工厂、源码扫描用的
 * `JUDGEMENT_FILE` / `PORT_TYPE_FILE` 常量）**刻意留在那个档里** —— 见 `./AGENTS.md`。
 *
 * ⚠️ **本目录不许有 `.test.ts` 后缀**：那一族共用面必须住在 `_*.ts` 里才不会被 vitest
 * 收集成一个空跑的空档；反过来，**共用面绝不许搬进 `tests/helpers/`**（零外网扫描的
 * `SCAN_DIRS` 排除那个目录，搬进去等于让其中的公网字面量从扫描里静默消失）。
 *
 * @module tests/unit/core/access-control/_access-control-port
 */
import http from "node:http";
import type {
  AccessClientInput,
  AccessControl,
  AccessDecision,
  AccessRouteDecision,
  AccessRouteInput,
  AccessTargetInput,
} from "@/core/types/proxy.js";
import type { ProxyRuntime } from "@/runtime/index.js";

/** 判定对象固定用这一个域名（名单按 host 字符串匹配，不做 DNS） */
export const HOST = "target.test";

/**
 * 会**记账**的访问控制替身：三个方法各自计数并逐条记录入参。
 *
 * @description 计数是必需的：只断言「`runtime.services.access` 是我给的那个对象」证明的
 * 仅仅是赋值发生 —— 一份没人调用的替身照样通过。真正要锁的是「**转发路径真的问过它**」。
 */
export function countingAccess(
  answers: {
    client?: AccessDecision;
    target?: AccessDecision;
    route?: AccessRouteDecision;
  } = {},
): AccessControl & {
  calls: { client: AccessClientInput[]; target: AccessTargetInput[]; route: AccessRouteInput[] };
} {
  const calls = { client: [], target: [], route: [] } as {
    client: AccessClientInput[];
    target: AccessTargetInput[];
    route: AccessRouteInput[];
  };
  return {
    calls,
    checkClient: (input) => {
      calls.client.push(input);
      return answers.client ?? { allowed: true };
    },
    checkTarget: (input) => {
      calls.target.push(input);
      return answers.target ?? { allowed: true };
    },
    checkRoute: (input) => {
      calls.route.push(input);
      return answers.route ?? { direct: false };
    },
  };
}

/**
 * 本族起过的真 runtime（`start()` 过的）—— 停机由**用它的档**自己挂 `afterEach` 排空。
 * @description 排空靠 `splice(0)`，所以第二次排空是**同一份实现**给出的空转（不另设
 * 「已释放」标志给自己发绿牌）。⚠️ 停机之所以必须发生：`runtime.start()` 无条件
 * `open()` 用量数据源，一个没停的 runtime 会一直占着账本文件。
 */
export const activeRuntimes: ProxyRuntime[] = [];

/** 经本地代理发一次 absolute-form GET，返回状态码（网络错误返回 0） */
export function absoluteGet(
  proxyPort: number,
  authority: string,
  headers: Record<string, string> = {},
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: proxyPort,
        method: "GET",
        path: `http://${authority}/`,
        headers: { ...headers, Connection: "close" },
      },
      (res) => {
        res.on("data", () => {});
        res.on("end", () => {
          resolve(res.statusCode ?? 0);
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(8000, () => {
      req.destroy(new Error("timeout"));
    });
    req.end();
  });
}