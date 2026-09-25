[English](README.en.md) | 简体中文

# @b-hole/proxy

多协议正向代理服务 — HTTP / HTTPS / SOCKS4 / SOCKS5 / SOCKSS4 / SOCKSS5，支持双端异构串联、cluster 多进程与四种鉴权方式。

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.6-brightgreen.svg)](https://nodejs.org)

---

## 特性

- **六种协议** — HTTP / HTTPS / SOCKS4 / SOCKS5 / SOCKSS4（TLS + SOCKS4）/ SOCKSS5（TLS + SOCKS5）；每个实例按 `PROXY_PROTOCOL` 启动一种协议，可同时运行多个实例监听不同端口
- **双端异构串联** — 服务端监听任一协议，客户端可将流量转发给任一协议的上游代理，上下游协议完全独立
- **四种鉴权** — Basic / JWT / UID / None，支持多账号表，热加载无需重启
- **访问控制** — 客户端 IP 黑白名单 + 目标地址黑白名单 + client 模式上游/直连路由名单，域名通配符匹配
- **TLS & mTLS** — 服务端 TLS 加密，可选客户端证书双向认证（mTLS）
- **Cluster 多进程** — 按 CPU 核数或指定数量 fork worker，崩溃自动重启
- **结构化日志** — 控制台人读文本 + JSONL 落盘，支持 `jq` 查询
- **配置热加载** — 账号表与 ACL 文件改动最多 1 秒生效，无需重启

## 快速开始

### 二进制版本（推荐）

下载对应平台的压缩包，解压后直接运行：

```bash
# Linux / macOS
tar -xzf proxy-v*-linux-x64.zip
cd proxy
./proxy-linux --port 3000

# Windows
# 解压 proxy-v*-win-x64.zip，进入目录
proxy-win.exe --port 3000
```

### Node.js 版本

需要本地安装 Node.js **>= 22.6**（CLI 与库模式统一要求）：

```bash
# 解压 node.js 版本压缩包
tar -xzf proxy-v*-node22.zip
cd proxy
node app.js --port 3000
```

### 从源码构建

```bash
git clone https://github.com/b-hole/proxy.git
cd proxy
pnpm install
pnpm build          # esbuild -> dist/app.js
pnpm start          # node dist/app.js
```

## 配置

### 优先级

```
CLI 参数  >  终端环境变量  >  .env 文件  >  默认值
```

`.env` 文件按低 → 高依次加载，后者覆盖前者：

1. `.env.production`
2. `.env.development`
3. `.env.<NODE_ENV>`（未设时缺省 `.env.development`）

**终端已存在的变量不会被文件覆盖**，因此 `PORT=9000 pnpm start` 一定生效。

### 全部环境变量

#### 基础

| 变量 | 说明 | 默认值 | 生效 |
|------|------|--------|------|
| `HOST` | 监听地址 | `0.0.0.0` | 启动 |
| `PORT` | 监听端口 | `3000` | 启动 |
| `PROXY_PROTOCOL` | 代理协议：`http`/`https`/`socks4`/`socks5`/`sockss4`/`sockss5` | `http` | 启动 |
| `PROXY_MODE` | 运行模式：`server`=服务端直连 / `client`=客户端链上游 | `server` | 运行时 |
| `CLUSTER_WORKERS` | Worker 数（`0`=CPU 核数，`1`=单进程） | `1` | 启动 |
| `USE_HOME_CONFIG` | `true` 从 `~/.proxy/` 读配置 | `false` | 启动 |

#### 上游代理（`PROXY_MODE=client` 时生效）

| 变量 | 说明 | 默认值 | 生效 |
|------|------|--------|------|
| `UPSTREAM_URL` | 上游代理 URL，格式 `scheme://[user:pass@]host[:port]`，覆盖下面 6 个拆项 | 空 | 运行时 |
| `UPSTREAM_HOST` | 上游主机 | `127.0.0.1` | 运行时 |
| `UPSTREAM_PORT` | 上游端口 | `3000` | 运行时 |
| `UPSTREAM_PROTOCOL` | 上游协议（与入站协议独立） | `http` | 运行时 |
| `UPSTREAM_USERNAME` | 上游用户名 | 空 | 运行时 |
| `UPSTREAM_PASSWORD` | 上游密码 | 空 | 运行时 |
| `UPSTREAM_SECURE` | 上游连接是否 TLS | `false` | 运行时 |
| `UPSTREAM_CA` | 上游 CA 证书路径（空=系统信任库） | 空 | 运行时 |
| `UPSTREAM_INSECURE` | 跳过上游证书验证 | `false` | 运行时 |
| `UPSTREAM_TIMEOUT` | 上游超时（ms） | `10000` | 运行时 |

#### 鉴权

| 变量 | 说明 | 默认值 | 生效 |
|------|------|--------|------|
| `AUTH_ENABLED` | 启用鉴权 | `false` | 运行时 |
| `AUTH_TYPE` | 鉴权类型：`none`/`basic`/`jwt`/`uid` | `none` | 运行时 |
| `AUTH_USERS_FILE` | 账号表路径 | `cfg/users.json` | 运行时 |
| `JWT_SECRET` | JWT 密钥 | 空 | 运行时 |
| `AUTH_LOGGING` | 输出鉴权审计日志 | `true` | 运行时 |

#### 访问控制

| 变量 | 说明 | 默认值 | 生效 |
|------|------|--------|------|
| `ACL_FILE` | 访问控制名单路径 | `cfg/acl.json` | 运行时 |

#### TLS / mTLS

| 变量 | 说明 | 默认值 | 生效 |
|------|------|--------|------|
| `TLS_KEY` | TLS 私钥路径 | `keys/server.key` | 启动 |
| `TLS_CERT` | TLS 证书路径 | `keys/server.crt` | 启动 |
| `TLS_CA` | mTLS 开关（非空=要求客户端证书） | 空 | 启动 |
| `TLS_PASSPHRASE` | TLS 私钥口令 | 空 | 启动 |

#### 日志

| 变量 | 说明 | 默认值 | 生效 |
|------|------|--------|------|
| `LOG_LEVEL` | 控制台日志等级：`debug`/`info`/`warn`/`error`/`silent` | `error` | 运行时 |
| `LOG_FILE_LEVEL` | 落盘日志等级（与 `LOG_LEVEL` 独立） | `info` | 运行时 |
| `LOG_FILE` | 日志目录或文件路径（空=不落盘），按小时切分 JSONL | `log` | 运行时 |

#### 缓存

| 变量 | 说明 | 默认值 | 生效 |
|------|------|--------|------|
| `CACHE_TYPE` | 缓存后端：`memory`/`redis` | `memory` | 运行时 |

### 生效时机

| phase | 含义 | 字段 |
|-------|------|------|
| `startup` | 启动时一次性读取，改动需重启 | `HOST` `PORT` `PROXY_PROTOCOL` `TLS_KEY` `TLS_CERT` `TLS_CA` `TLS_PASSPHRASE` `CLUSTER_WORKERS` `USE_HOME_CONFIG` |
| `runtime` | 每次请求重新读取 | 其余全部 |

## 鉴权

启用 `AUTH_ENABLED=true` 后按 `AUTH_TYPE` 生效，账号表在 `cfg/users.json`：

```json
[
  { "username": "admin", "password": "secret" },
  { "username": "guest", "password": "guest123" }
]
```

| 类型 | 校验方式 |
|------|---------|
| `none` | 放行 |
| `basic` | 命中账号表中任一账号的用户名 + 密码 |
| `jwt` | 校验 Bearer token（需 `JWT_SECRET`） |
| `uid` | 命中账号表中任一用户名（socks4 由 USERID 承载） |

凭证来源：HTTP/HTTPS 取 `Proxy-Authorization`，回退 `Authorization`；socks4 取 USERID；socks5 取 USER_PASS 协商。

## 访问控制

配置文件 `cfg/acl.json`：

```json
{
  "clientIp": {
    "whitelist": ["127.0.0.1", "10.0.0.0/8"],
    "blacklist": ["203.0.113.7"]
  },
  "target": {
    "whitelist": ["*.example.com"],
    "blacklist": ["ads.example.net", "198.51.100.0/24"]
  },
  "upstream": {
    "whitelist": ["*.example.com"],
    "blacklist": ["secret.example.com"]
  }
}
```

- 三组职责：`clientIp` 谁能用（来源判定）｜`target` 能不能访问（目标判定）｜`upstream` 怎么路由（client 模式上游 / 直连）
- **`clientIp` / `target`：黑名单命中 → 拒绝（优先）；白名单非空且未命中 → 拒绝；皆空 → 放行**
- **`upstream`（动作 = 直连，不交上游）：黑名单命中 → 直连（黑 > 白，无条件盖章）；白名单非空且未命中 → 直连；皆空（含整组 / 文件缺失）→ 走上游（默认，与旧版行为一字不差）**。一句话公式：**走上游 ⇔ 命中 whitelist ∧ 未命中 blacklist，其余 → 直连** —— whitelist = 「走上游的资格圈」（圈外默认直连）；blacklist = 圈内一票否决（点名踢出即直连，谁罩着都没用）
- **仅 `PROXY_MODE=client` 生效**；`server` 模式完全忽略（配了也无副作用、零开销）
- 判定顺序：`clientIp`（谁能用）→ 鉴权 → `target` 黑白名单（能不能访问，拒 = `403` / 握手断开）→ `upstream` 组（怎么路由）→ 拨号。**路由名单绝不豁免 `target` 拒绝**

配置级速查（`upstream` 组）：

| `upstream` 配置 | 效果 |
|------|------|
| 皆空（含整组 / 文件缺失） | 全部走上游（默认，与旧版一致） |
| 只 blacklist | 点名条目直连，其余走上游 |
| 只 whitelist | 圈内走上游，圈外直连 |
| whitelist + blacklist | 白圈资格 + 黑一票否决（黑 > 白） |

- `clientIp` **只收 IP / CIDR**（对端永远是 IP，写域名属非法配置 → 启动中止）；IP **不支持 `*` 通配**，范围一律用 CIDR（`10.0.0.0/8`、`2001:db8::/32`）
- `target` 收 **IP / CIDR / 域名 / `*.通配域名`**；条目**不支持端口**、**不做 DNS 解析**；IDN 须写 punycode（`xn--...`）
- `upstream` 条目语法与 `target` 完全一致（**IP / CIDR / 域名 / `*.通配域名`**，不支持端口、不做 DNS 解析、IDN 须写 punycode、IP 无 `*` 通配一律用 CIDR）
- `clientIp` 只认 TCP 对端地址（刻意不看 `X-Forwarded-For` / `X-Real-IP`，那两个头可伪造）
- `target` 按客户端请求的 host 字符串匹配；**域名条目拦不住「客户端直写 IP」**——要两头堵就把域名与解析 IP/CIDR 都写上；**`upstream` 组同样存在该绕过边界**：域名条目管不到「客户端直写 IP」，要管就写 IP / CIDR 条目
- `*.a.com` 只匹配 `a.com` 的子域，**不含 `a.com` 本身**（裸域要单独写一条）
- 拒绝行为：HTTP / CONNECT / WebSocket 回 **403**（名单拒绝与凭证无关，刻意不回 407；`clientIp` 拒绝早于鉴权，`target` 拒绝在鉴权之后、拨号之前）；SOCKS 的 `clientIp` 拒绝在握手前直接断开（不回任何字节）、`target` 拒绝回失败应答；`[ip-denied]` / `[target-denied]` 各记一条 warn
- **白名单不豁免认证** —— 命中白名单只是通过第一道门，仍需按 `AUTH_*` 提供凭证（鉴权拒绝回 `407`）
- client 串联模式下，上游地址（`UPSTREAM_*`）**永不进入名单**——名单判定的永远是客户端请求的目标（`upstream` 组判的也是这个目标，只是动作改为选路由）
- **`[route]` 路由日志**：client 模式下每个放行请求打一条，字段 `target`、`route=direct|upstream`（命中直连时带 `reason=blacklist|whitelist`），可 `jq 'select(.msg=="[route]")'` 过滤；`server` 模式不打
- 文件缺失 = 三组全空：不拦截任何请求、client 模式全部走上游；启动时内容非法（未知键、非法条目如 `192.168.*.*` / `example.com:8080`）= **直接中止启动**（fail-closed）；运行期改坏 = 保留上一份有效配置 + 告警
- 两个文件均热加载，改动最多 1 秒生效，无需重启

## 日志

控制台是人读文本，落盘是 JSONL（`LOG_FILE` 按小时切分 `log/YYYY-MM-DD-HH.jsonl`）：

```bash
jq -r 'select(.user=="alice") | .msg, .target' log/*.jsonl
jq -r 'select(.msg=="[auth] deny") | .client' log/*.jsonl | sort | uniq -c
```

## Docker

```bash
docker build -t proxy .
docker run --env-file .env.production -p 3000:3000 proxy
```

## 作为库使用

> 本包的 CLI 与库模式统一要求 **Node.js >= 22.6**。库入口只导出 API，不会自动启动服务；请从包根入口 `@b-hole/proxy` 导入，不要绕过 `exports` 深路径导入内部文件。

最短可运行示例：

```ts
import { createProxyRuntime } from "@b-hole/proxy";

async function main(): Promise<void> {
  const runtime = createProxyRuntime({
    config: {
      host: "127.0.0.1",
      port: 8787,
      proxyProtocol: "http",
    },
  });

  try {
    await runtime.start();
    console.log(`proxy listening on ${runtime.getStats().host}:${runtime.getStats().port}`);
  } finally {
    await runtime.stop();
  }
}

void main();
```

### 库模式的零副作用保证

`createProxyRuntime()` 只使用显式传入的内存配置和依赖注入。除调用方显式调用 `start()` 监听端口外，它不会：

- 读取 `.env.production`、`.env.development` 或其它 `.env` 文件；
- 读取 `process.env`、`process.argv`，也不会写入或污染 `process.env`；
- 安装信号处理器、调用 `process.exit`，或接管宿主进程生命周期；
- 使用 cluster、创建日志文件，或自动选择 CLI 的全局 logger（默认是 `createNoopLogger()`）；
- 读写 CLI 全局 `get`/`set` 配置单例。每个 runtime 都有自己的 `ConfigStore`。

如果确实需要从文件或命令行显式加载配置，请调用下面的 `loadConfig()`；这是调用方主动选择的文件读取行为，不代表 `createProxyRuntime()` 会隐式读取环境。

> 例外：选择 `https`/`sockss4`/`sockss5` 并显式配置证书路径时，协议会在 `start()` 阶段惰性读取对应 TLS 文件；这属于显式协议配置，不会隐式扫描其它配置。

### 注入自定义鉴权

通过 `services.auth` 注入实现 `AuthProvider` 的服务即可替换默认鉴权。示例接受一个固定 token；生产代码可在这里接入自己的会话、RBAC 或远程鉴权服务：

```ts
import { createProxyRuntime, type AuthProvider } from "@b-hole/proxy";

const auth: AuthProvider = {
  isEnabled: true,
  authType: "custom",
  async authenticate(ctx) {
    const raw = ctx.req.headers["proxy-authorization"];
    const token = Array.isArray(raw) ? raw[0] : raw;
    return {
      passed: token === "Bearer app-token",
      username: "app-user",
    };
  },
};

const runtime = createProxyRuntime({
  config: { host: "127.0.0.1", port: 8788, authEnabled: true },
  services: { auth },
});

try {
  await runtime.start();
} finally {
  await runtime.stop();
}
```

### 订阅强类型事件

`runtime.events` 是该 runtime 私有的强类型事件总线。事件名会推导 payload 类型，下面的 `event.data` 可直接按 `auth.decided` 的字段访问：

```ts
const runtime = createProxyRuntime({
  config: { host: "127.0.0.1", port: 8789 },
});
const subscription = runtime.events.subscribe("auth.decided", (event) => {
  const decision = event.data;
  console.log("auth:", decision.passed, decision.user ?? "-", decision.reason ?? "-");
});

try {
  await runtime.start();
} finally {
  subscription.dispose();
  await runtime.stop();
}
```

### 按请求串联事件（requestId）

每个请求的事件都带 `event.context.requestId`（以及 `connectionId`、`protocol`、`client`），可以把一次请求的鉴权、路由与终态串成完整链路：

```ts
import { createProxyRuntime } from "@b-hole/proxy";

const runtime = createProxyRuntime({ config: { port: 8793 } });

// 按 requestId 归并，还原一个请求的完整轨迹
const byRequest = new Map<string, string[]>();
const track = (e: { context: { requestId?: string }; name: string }): void => {
  const id = e.context.requestId;
  if (id) byRequest.set(id, [...(byRequest.get(id) ?? []), e.name]);
};

for (const name of ["auth.decided", "route.selected", "request.completed", "request.rejected", "request.failed"] as const) {
  runtime.events.subscribe(name, (e) => track({ context: e.context, name: e.name }));
}

await runtime.start();
// 一次被拒的请求会留下：auth.decided → request.rejected
// 一次成功请求会留下：route.selected → request.completed（同一 requestId）
```

同一请求的事件共享同一个 `requestId`；HTTP 同一 TCP 连接（keep-alive）下的多个请求共享 `connectionId`、但 `requestId` 各不相同。

### 使用配置预设（Preset）

不想手写整套配置时，可以用内置预设作为起点，再用显式 `config` 覆盖个别键：

```ts
import { createProxyRuntime, listPresets } from "@b-hole/proxy";

console.log(listPresets()); // ["development", "socks5-basic", "secure-http-auth", "https-tls"]

const runtime = createProxyRuntime({
  preset: "socks5-basic",              // 预设作为底
  config: { port: 8794 },              // 显式配置覆盖预设
});
```

也可以用 `applyPreset()` 自己合并，或用 `registerPreset()` / `definePreset()` 注册自定义预设：

```ts
import { applyPreset, definePreset, registerPreset } from "@b-hole/proxy";

// 手动合并：base → preset → overrides
const config = applyPreset("secure-http-auth", { host: "127.0.0.1" }, { port: 8795 });

// 注册自定义预设
registerPreset(definePreset({
  name: "team-socks",
  description: "团队内网 SOCKS5",
  config: { proxyProtocol: "socks5", host: "0.0.0.0", upstreamTimeout: 20000 },
}));
```

### 多实例隔离

不同端口、协议和配置可以同时运行；每个实例的配置、事件总线、logger 与服务互不共享：

```ts
import { createProxyRuntime } from "@b-hole/proxy";

const httpRuntime = createProxyRuntime({
  config: { host: "127.0.0.1", port: 8790, proxyProtocol: "http" },
});
const socksRuntime = createProxyRuntime({
  config: { host: "127.0.0.1", port: 8791, proxyProtocol: "socks5" },
});

await Promise.all([httpRuntime.start(), socksRuntime.start()]);
try {
  // 两个实例同时服务；这里可以继续接入应用自己的生命周期管理。
  console.log(httpRuntime.runtimeId, socksRuntime.runtimeId);
} finally {
  await Promise.all([httpRuntime.stop(), socksRuntime.stop()]);
}
```

### 显式加载配置

`loadConfig()` 把数据源和落点都交给调用方。库调用方应传入自己的 `env`/`argv`，并设置 `writeProcessEnv: false`，避免 `.env` 文件值污染宿主进程；解析结果落在独立的 `ConfigStore`：

```ts
import { createProxyRuntime, loadConfig } from "@b-hole/proxy";

const { store } = loadConfig({
  env: { PROXY_PROTOCOL: "http", PORT: "8792" },
  argv: [],
  writeProcessEnv: false,
});

const runtime = createProxyRuntime({ config: store.getAll() });
try {
  await runtime.start();
} finally {
  await runtime.stop();
}
```

### CLI 模式与库模式对照

| 关注点 | CLI 模式（`dist/app.js` / `ProxyServer`） | 库模式（`ConfigStore` + `createProxyRuntime`） |
|--------|--------------------------------------------|--------------------------------------------|
| 环境变量、`.env`、argv | `initConfig()` 负责读取并校验 | runtime 不读取；仅显式 `loadConfig()` 时按参数读取 |
| `process.env` | CLI loader 按既有规则处理 | 默认不读、不写；`loadConfig({ writeProcessEnv: false })` 保证不污染宿主 |
| 信号与退出 | CLI/server 负责信号、优雅退出和错误退出码 | 不安装处理器、不调用 `process.exit`；由宿主决定 |
| cluster | `runServer()` 可按配置 fork worker | 不使用 cluster；需要时由宿主自行编排多个 runtime |
| 日志 | CLI 使用全局 logger，可落盘 JSONL | 默认 noop；显式注入 `Logger` 或 `createConsoleLogger()` 才输出 |
| 生命周期 | `runServer()` / `ProxyServer` 面向进程 | `runtime.start()` / `runtime.stop()` 幂等且由调用方管理 |

CLI 兼容导出仍然保留，但它们面向进程级使用：

```ts
import { ProxyServer, runServer, get, getAll, set } from "@b-hole/proxy";
```

> `get`、`set`、`ProxyServer`、`runServer` 是 CLI 兼容或进程级 API。库模式请优先使用 `ConfigStore` + `createProxyRuntime()`，这样才能保持实例隔离并避免接管宿主进程。

## 开发

```bash
pnpm install
cp cfg/users.json.example cfg/users.json   # 必须：.env.development 开了 uid 鉴权
pnpm dev             # build:dev + start:dev
pnpm dev:hot         # watch + 自动重启
pnpm test            # vitest run
pnpm lint            # eslint
pnpm typecheck       # tsc --noEmit
```

## 许可

[Apache-2.0](LICENSE)
