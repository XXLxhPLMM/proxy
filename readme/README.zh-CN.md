[English](README.en.md) | 简体中文

# @b-hole/proxy

多协议正向代理服务 — HTTP / HTTPS / SOCKS4 / SOCKS5 / SOCKSS4 / SOCKSS5，支持双端异构串联、cluster 多进程与四种鉴权方式。

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.6-brightgreen.svg)](https://nodejs.org)

---

## 特性

- **六种协议** — HTTP / HTTPS / SOCKS4 / SOCKS5 / SOCKSS4（TLS + SOCKS4）/ SOCKSS5（TLS + SOCKS5）；每个实例按 `PROXY_PROTOCOL` 启动一种协议，可同时运行多个实例监听不同端口
- **双端异构串联** — 服务端监听任一协议，客户端可将流量转发给任一协议的上游代理，上下游协议完全独立
- **四种鉴权** — Basic / JWT / UID / None，支持多账号表，账号文件最多 1 秒热生效
- **访问控制** — 客户端 IP 黑白名单 + 目标地址黑白名单 + client 模式上游/直连路由名单，域名通配符匹配
- **TLS & mTLS** — 服务端 TLS 加密，可选客户端证书双向认证（mTLS）
- **Cluster 多进程** — 按 CPU 核数或指定数量 fork worker，崩溃自动重启
- **结构化日志** — 控制台人读文本 + JSONL 落盘，支持 `jq` 查询
- **配置热加载** — 账号表与 ACL 文件内容/路径最多 1 秒生效；鉴权类型等其它配置按 phase 生效

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
CLI 参数  >  终端/显式环境变量  >  .env 文件  >  默认值
```

`.env` 文件按低 → 高依次加载，后者覆盖前者。原始候选的优先级是
`.env.production` < `.env.development` < `.env.<NODE_ENV>`；候选去重后，
`NODE_ENV=production` 的实际读取顺序是 `.env.development` → `.env.production`。

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
| `UPSTREAM_URL` | 上游代理 URL，格式 `scheme://[user:pass@]host[:port]`，覆盖下面 6 个拆项；与拆项共用校验/拆项入口 | 空 | 启动 |
| `UPSTREAM_HOST` | 上游主机 | `127.0.0.1` | 启动 |
| `UPSTREAM_PORT` | 上游端口 | `3000` | 启动 |
| `UPSTREAM_PROTOCOL` | 上游协议（与入站协议独立） | `http` | 启动 |
| `UPSTREAM_USERNAME` | 上游用户名 | 空 | 启动 |
| `UPSTREAM_PASSWORD` | 上游密码 | 空 | 启动 |
| `UPSTREAM_SECURE` | 上游连接是否 TLS | `false` | 启动 |
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
| `startup` | 启动时一次性读取，改动需重建 runtime / 重启 | `HOST` `PORT` `PROXY_PROTOCOL` `UPSTREAM_URL` `TLS_KEY` `TLS_CERT` `TLS_CA` `TLS_PASSPHRASE` `CLUSTER_WORKERS` `USE_HOME_CONFIG` |
| `runtime` | 每次请求重新读取 | 其余全部 |

`UPSTREAM_URL` 与 host/port/protocol/secure/username/password 六个 endpoint 拆项都是 **startup** 相位：`loadConfig()` 与纯内存 runtime 共用同一套 URL 校验/拆项入口；修改任一项都需重建 runtime（或重启进程）。若 URL 覆盖显式拆项仍保留 warning。

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
- 两个文件均热加载，改动最多 1 秒生效，无需重启；仅 `ENOENT`、`ENOTDIR` 和非普通文件算 missing，其它 stat/read 错误（如 `EACCES`）保留上一份有效文件并发 error，不会静默全放行；相对路径在缓存前先绝对化。

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

最短可运行示例（**纯内存模式**：`config` 全部由你给出，不读任何 env / argv / 文件）：

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

库入口 `@b-hole/proxy` 的 root import 本身零配置副作用：它不读 `process.env` / `process.argv` / 任何 `.env` 或配置文件，不注册 `process` 事件监听，不建 server、不写日志文件，也**不导出任何隐式全局配置**（没有 `get` / `getAll` / `set` / `globalConfigAccessor` 这类单例 API）。import CLI 模块同样不会加载配置；只有 CLI 进程入口自己显式采集宿主来源（env 快照、argv、`.env` 候选名）并交给 `loadConfig()`。

`createProxyRuntime()` 只使用显式传入的内存配置和依赖注入。除调用方显式调用 `start()` 监听端口外，它不会：

- 读取 `.env.production`、`.env.development` 或其它 `.env` 文件；
- 读取 `process.env`、`process.argv`，也不会写入或污染 `process.env`；
- 安装信号处理器、调用 `process.exit`，或接管宿主进程生命周期；
- 使用 cluster、创建日志文件，或自动选择 CLI 的 logger 策略（默认是 `createNoopLogger()`）；
- 读取任何进程级配置单例。纯内存 runtime 创建自己的 `ConfigStore`；context 模式只与显式传入该 context 的调用方共享。

如果确实需要从 env、文件或命令行显式加载配置，请调用下面的 `loadConfig()`；这是调用方主动选择的文件读取行为，不代表 `createProxyRuntime()` 会隐式读取环境。

> 例外：选择 `https`/`sockss4`/`sockss5` 并显式配置证书路径时，协议会在 `start()` 阶段惰性读取对应 TLS 文件；这属于显式协议配置，不会隐式扫描其它配置。

纯内存模式可以传 `configDir` 作为路径锚点。runtime 构造时会把所有路径字段（包括 `authUsersFile`、`aclFile`、`logFile`、TLS 证书/CA 与 `upstreamCa`）绝对化；省略时仅以构造瞬间的 `process.cwd()` 作为便利默认，之后 `process.chdir()` 不会让已构造 runtime 的路径漂移。这个选项不会触发隐式文件读取。

手工创建 `ConfigContext` 只能使用对象工厂 `createConfigContext({ store, configDir, sources?, warnings? })`：`configDir` 必填，工厂会按它绝对化 store 中的 path 字段，并始终从 FIELDS 表取得完整 startup 集合，调用方不能删减。

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

`runtime.events` 是该 runtime 私有的强类型事件总线。事件名会推导 payload 类型，下面的 `event.data` 可直接按 `auth.decided` 的字段访问。`config.loaded` 的 `sourceName` 按 `argv` > `environment` > `env-files` > `memory` 首次命中分类；混合来源只报告最高优先级类别。

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

`loadConfig()` 是**异步**的：它把数据源和落点都交给调用方，解析结果原子地写进你指定的 `ConfigStore`，并返回一个 `ConfigContext`：

```ts
import { ConfigStore, createProxyRuntime, loadConfig } from "@b-hole/proxy";

const store = new ConfigStore();
const context = await loadConfig({
  env: { PORT: "8787" },
  envFiles: ["./config/app.env"],
  argv: [],
  cwd: process.cwd(),
  store,
  skipFileValidation: false,
});

const runtime = createProxyRuntime({ context });
try {
  await runtime.start();
} finally {
  await runtime.stop();
}
```

规则：

- **省略即禁用**：不传 `env` / `envFiles` / `argv` 就等于关掉该来源，绝不会回退去读 `process.env` / `process.argv`，也不会自行扫描任何 `.env` 候选文件。
- **优先级**：`argv` > 显式 `env` > `envFiles`（数组顺序**从低到高**覆盖）> `defaults`。显式 `env` 里的键永远赢过文件里的同名键。
- **URL 解析共用入口**：`loadConfig()` 与纯内存 runtime 都用同一套 `UPSTREAM_URL` 校验/拆项逻辑；URL 与六个 endpoint 拆项都是 startup 键，修改任一项都需重建 runtime，拆项覆盖 warning 仍保留。
- **路径归一化**：`loadConfig()` 与 `createConfigContext` 都会把显式相对 path 字段按最终 `configDir` 绝对化；纯内存 runtime 的 `configDir` 在构造时固定。
- **绝不读写宿主环境**：`loadConfig()` 既不读也不写 `process.env`；env 文件的值只参与本次解析。
- **失败不留半份配置**：所有读取、值域、交叉字段以及 `users.json` / `acl.json` 校验全部通过后，才执行一次原子 `merge()`；任何一步失败都直接抛错（如 `配置校验失败: PORT=70000 越界`），`store` 保持调用前的原样。
- **`skipFileValidation`**：缺省 `false`（fail-fast 强校验两个 JSON）；传 `true` 时完全不碰这两个文件，并连带跳过依赖账号数的 `assertAuthConfig`。
- **context 里有什么**：`store`（live store）、`accessor`（只读访问器）、`config`（加载完成那一瞬的初始快照，冻结）、`configDir`、`sources`（`envKeys` / `envFiles` / `argvKeys` 来源元数据，只记键名不记值）、`warnings`（如 `UPSTREAM_URL` 覆盖拆项的提示）、`startupKeys`。

### 两种配置模式

`createProxyRuntime({ context, config, preset, configDir })` 里，`context` 与 `config` / `preset` **二选一**；`configDir` 只用于纯内存模式：

| 模式 | 写法 | 配置落点 | 适合 |
|------|------|---------|------|
| 纯内存 | `{ config: {...}, configDir: "..." }` / `{ preset: "...", configDir: "..." }` | runtime 内部新建私有 `ConfigStore` | 测试、脚本、固定单配置 |
| context | `{ context }` | 与调用方**共享同一个 live `store`** | 需要热改、需要读 env / 文件 |

- 纯内存模式不读取任何外部来源，也不与其它 runtime 共享状态。
- context 模式共享 live store：之后 `context.store.set("logLevel", "debug")` 会被运行中的 runtime 立即读到；而 `context.config` 只是加载完成时的快照，不会跟着变。
- **`startupKeys` 字段需重建 runtime**：`HOST` / `PORT` / `PROXY_PROTOCOL` / `UPSTREAM_URL` / `TLS_*` / `CLUSTER_WORKERS` 等在 runtime 构造时被冻结，改完必须重新 `createProxyRuntime()` 才生效；其余 `runtime` 字段每次读取都打到 store，热改即生效。
- `runtime.options`、`runtime.services` 与派生 accessor 是只读冻结视图；配置写入统一走 `runtime.context.store`，startup 键变更只发布 `config.restart-required`，重建 runtime 后才采用新值。
- `start()` / `stop()` 保持幂等。每次 `start()` 都会重新建立 bridge、store 与 ACL 文件订阅，因此 `start→stop→start` 以及先 `stop()` 再 `start()` 都能恢复完整链路；外部 `EventHub` 及其订阅始终归宿主所有。

### CLI 模式与库模式对照

| 关注点 | CLI 模式（`dist/app.js` / `ProxyServer`） | 库模式（`ConfigStore` + `createProxyRuntime`） |
|--------|--------------------------------------------|--------------------------------------------|
| 环境变量、`.env`、argv | CLI 进程入口显式快照宿主 env/argv 并交给 `loadConfig()` | runtime 不读；仅显式 `loadConfig()` 时按传入参数读 |
| `process.env` | CLI 只做只读快照，解析过程不回写 | 不读也不写，天然无污染 |
| 信号与退出 | CLI/server 负责信号、优雅退出和错误退出码 | 不安装处理器、不调用 `process.exit`；由宿主决定 |
| cluster | `runServer()` 可按配置 fork worker | 不使用 cluster；需要时由宿主自行编排多个 runtime |
| 日志 | CLI 创建绑定 `context.accessor` 的 `LoggerImpl`，可落盘 JSONL | 默认 noop；显式注入 `Logger` 或 `createConsoleLogger()` 才输出 |
| 生命周期 | `runServer()` / `ProxyServer` 面向进程 | `runtime.start()` / `runtime.stop()` 幂等且由调用方管理 |

进程级导出仍然保留，但它们面向 CLI 使用：

```ts
import { ProxyServer, runServer } from "@b-hole/proxy";
```

> `runServer(context, logger?, noColor?)` 与 `ProxyServer` 是进程级 API：它们安装信号 / 进程守卫、可能 fork cluster，并独占宿主生命周期。库模式请用 `ConfigStore` / `loadConfig()` + `createProxyRuntime()`，以保持实例隔离且不接管宿主进程。包入口**不再导出** `get` / `getAll` / `set` / `globalConfigAccessor`：不存在隐式全局配置，配置只存在于你创建或加载的 `ConfigStore` 里。

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

> `pnpm start:dev` / `pnpm start:prod` **只设置 `NODE_ENV`**（`development` / `production`），不再用 `node --env-file` 预注入变量。CLI 生成的原始候选优先级为 `.env.production` < `.env.development` < `.env.<NODE_ENV>`，后者胜出；重复名去重后，`NODE_ENV=production` 实际读取 `.env.development` 再 `.env.production`。终端里已存在的变量永远不会被文件覆盖。

## 许可

[Apache-2.0](LICENSE)
