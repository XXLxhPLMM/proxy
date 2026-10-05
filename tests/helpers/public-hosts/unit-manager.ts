import type { PublicHostEntry } from "../external-network-scan.js";

/**
 * 零外网白名单 —— `tests/unit/manager/` 主题片
 *
 * @description
 * 归**管 `tests/unit/manager/` 的 agent**维护。文件搬进子目录时 `file` 要逐条改成
 * 新路径 —— 旧路径留在原地会当场被判 stale（见 `../AGENTS.md`）。
 *
 * ⚠️ **搬迁时逐条重写 reason 里的「本档」代词**（三条都有）。
 *
 * 三条纪律见 `../AGENTS.md`：`reason` 答「为什么它不建链」、零公网字面量的文件不建条目、
 * 同一 `(file, host)` 对不许在表里出现两次。
 */
export const UNIT_MANAGER_HOST_REFS: readonly PublicHostEntry[] = [
  {
    file: "tests/unit/manager/http/acl-entry.test.ts",
    hosts: ["1.2.3.4", "cdn.io", "example.com"],
    reason: "名单条目字符集那一档里 `/api/acl` 的**名单条目字面量**（`DATA_LAYER_FORMS` 那份「数据层接受的形态」清单与 CIDR / 通配域名 / IPv6 的加-删往返用例）。它们只被 `parseHostRule` / `parseIpRule` 解析、被 `toEqual` 比较、或经 `POST /api/acl` 写进临时目录里的 `acl.json`；起监听的是本目录共用的 `./_manager-http.ts:serve()`（`createManagerServer` + `listen(0, \"127.0.0.1\")`），那一档经 `./_manager-http.ts:call()` 打回去的 `http.request` 的 host 恒为 `127.0.0.1`、port 取自 `server.address()`，从不公网拨号。",
  },
  {
    file: "tests/unit/manager/http/cors.test.ts",
    // 三枚都在 `parseCorsPolicy(...)` 的入参与那几条 origin 对照串里（`ALLOWED` / `STRANGER`
    // 两个常量用的是 `.example` 保留 TLD，扫描器不判它们公网，故不在这张表里）
    hosts: ["a.com", "a.example.evil.com", "b.com"],
    reason: "**跨源白名单的 origin 字面量**：它们是 `MANAGER_CORS_ORIGINS` 的配置值（`parseCorsPolicy` 的入参）与「白名单外 origin 拿不到放行」那几条 `Origin` **请求头**的值，被本档经 `./_manager-http.ts:serveCors()` 起在 `127.0.0.1` 随机端口上的控制面读来与一个数组做**整串相等**比较，随后原样回显进 `Access-Control-Allow-Origin`。本目录的全部建链点只有 `./_manager-http.ts:call()` 里那个 `http.request`（`cors.test.ts` 自己只 `import http` 取 `http.Server` 这个类型），其 host 恒为 `127.0.0.1`、port 取自 `server.address()` —— origin 字面量从不参与拨号。",
  },
  {
    file: "tests/unit/manager/config/cors.test.ts",
    hosts: ["a.com", "b.com", "ops.example.com"],
    reason: "**`MANAGER_CORS_ORIGINS` 的语法校验字面量**（合法形态的正向清单与非法形态的负向清单，如 `http://a.com/`、`http://u:pw@a.com`、`http://a.com:99999`）。判据是 `assertManagerConfig` 里那条正则与 `toThrow` 的报错匹配，那一档只经 `./_manager-config.ts:withTmpDir()` 读临时目录、构造纯函数入参，不起监听、不拨号。",
  },
];
