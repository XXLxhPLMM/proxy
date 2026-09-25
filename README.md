[English](readme/README.en.md) | [简体中文](readme/README.zh-CN.md)

# @b-hole/proxy

高性能多协议正向代理，支持 HTTP / HTTPS / SOCKS4 / SOCKS5 / SOCKSS4 / SOCKSS5 六种协议，双端异构串联、cluster 多进程与四种鉴权方式。

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.6-brightgreen.svg)](https://nodejs.org)

<p align="center">
  <img src="readme/screenshot.png" alt="SWAIN Banner" width="600">
</p>

---

## 为什么选择 SWAIN

### 六种协议，按实例选择

无论你需要 HTTP 透明代理、HTTPS CONNECT 隧道、还是 SOCKS4/SOCKS5 终端代理，SWAIN 都支持这些协议；每个实例按 `PROXY_PROTOCOL` 启动一种协议，也可以同时运行多个实例监听不同端口。TLS 版本（SOCKSS4/SOCKSS5）在标准 SOCKS 握手前增加 TLS 握手，为代理流量提供传输层加密。

### 双端异构串联

SWAIN 的独特之处在于上下游协议完全独立。你可以在前端用 HTTP 接收浏览器流量，在后端通过 SOCKS5 转发给上游代理。客户端模式（`PROXY_MODE=client`）让你把 SWAIN 当作前置代理，将流量透明转发到上游，实现多级串联。

```
浏览器 ──HTTP──▶ SWAIN ──SOCKS5──▶ 上游代理 ──▶ 目标网站
```

### 四种鉴权，按需选择

| 模式 | 适用场景 | 说明 |
|------|---------|------|
| `none` | 内网/开发 | 无需认证 |
| `basic` | 通用场景 | 用户名 + 密码，HTTP 标准 |
| `uid` | 轻量场景 | 仅用户名，适合 SOCKS4 |
| `jwt` | 高安全场景 | Bearer Token，支持密钥轮换 |

多账号表存放在 `cfg/users.json`，修改后最多 1 秒自动生效，无需重启。

### 访问控制

双层防护：客户端 IP 黑白名单 + 目标地址黑白名单。支持 IP/CIDR 和域名通配符（`*.example.com`），黑名单命中优先拒绝。

### TLS & mTLS

服务端支持 TLS 加密监听（`PROXY_PROTOCOL=https`）。开启 mTLS（设置 `TLS_CA`）后，客户端必须出示有效证书才能连接，适用于零信任内网环境。

### Cluster 多进程

`CLUSTER_WORKERS` 设置为 CPU 核数或固定数量，master 自动 fork worker 共享端口，worker 崩溃自动重启。

### 结构化日志

控制台输出人读文本，落盘为 JSONL 格式（按小时切分），可直接用 `jq` 查询：

```bash
# 查看某用户的请求
jq -r 'select(.user=="alice") | .msg, .target' log/*.jsonl

# 统计鉴权失败的客户端
jq -r 'select(.msg=="[auth] deny") | .client' log/*.jsonl | sort | uniq -c
```

---

## 快速开始

### 二进制版本（推荐）

无需安装任何依赖，下载即用：

| 平台 | 下载 |
|------|------|
| Windows x64 | `proxy-v5.0.2-win-x64.zip` |
| Linux x64 | `proxy-v5.0.2-linux-x64.zip` |
| macOS x64 | `proxy-v5.0.2-macos-x64.zip` |

```bash
# Linux / macOS
tar -xzf proxy-v5.0.2-linux-x64.zip
cd proxy
chmod +x proxy-linux
./proxy-linux --port 3000

# Windows
# 解压后进入目录
proxy-win.exe --port 3000
```

### Node.js 版本

适用于已有 Node.js 环境的用户：

| 版本 | 要求 | 说明 |
|------|------|------|
| Node.js | Node >= 22.6 | CLI 与库模式统一要求 |

```bash
tar -xzf proxy-v5.0.2-node22.zip
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

---

## 配置

### 优先级

```
CLI 参数  >  终端环境变量  >  .env 文件  >  默认值
```

终端已存在的变量不会被 `.env` 文件覆盖。

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

| 类型 | 改动后 | 字段 |
|------|-------|------|
| `startup` | 需重启 | `HOST` `PORT` `PROXY_PROTOCOL` `TLS_KEY` `TLS_CERT` `TLS_CA` `TLS_PASSPHRASE` `CLUSTER_WORKERS` `USE_HOME_CONFIG` |
| `runtime` | 立即生效 | 其余全部 |

---

## 鉴权

启用 `AUTH_ENABLED=true` 后，按 `AUTH_TYPE` 校验。账号表在 `cfg/users.json`：

```json
[
  { "username": "admin", "password": "secret" },
  { "username": "guest", "password": "" }
]
```

凭证来源随协议而异：

- **HTTP/HTTPS** — `Proxy-Authorization` 头，回退 `Authorization`
- **SOCKS4** — USERID 字段（仅匹配用户名）
- **SOCKS5** — USER_PASS 协商

---

## 访问控制

`cfg/acl.json` 配置双层黑白名单：

```json
{
  "clientIp": {
    "whitelist": ["127.0.0.1", "10.0.0.0/8"],
    "blacklist": ["203.0.113.7"]
  },
  "target": {
    "whitelist": ["*.google.com"],
    "blacklist": ["ads.example.net"]
  }
}
```

**判定逻辑**：黑名单命中 → 拒绝；白名单非空且未命中 → 拒绝；皆空 → 放行。

文件热加载，修改后最多 1 秒生效。

---

## 上游代理（客户端模式）

设置 `PROXY_MODE=client` 后，SWAIN 将本地流量透明转发到上游代理，实现多级串联：

```
浏览器 ──▶ SWAIN(:3000) ──▶ 上游代理(:8080) ──▶ 目标网站
```

```bash
# 启用客户端模式
PROXY_MODE=client

# 通过 URL 一次性指定上游（推荐）
UPSTREAM_URL=http://user:pass@proxy.example.com:8080

# 或拆项配置
UPSTREAM_HOST=proxy.example.com
UPSTREAM_PORT=8080
UPSTREAM_PROTOCOL=socks5
UPSTREAM_USERNAME=user
UPSTREAM_PASSWORD=pass
```

支持将任意入站协议转发到任意出站协议，上下游完全独立。例如入站 HTTP、出站 SOCKS5：

```
浏览器 ──HTTP──▶ SWAIN ──SOCKS5──▶ 上游代理 ──▶ 目标网站
```

**注意**：`PROXY_MODE=server`（默认）时，SWAIN 直连目标网站，上游配置不生效。

---

## Docker

```bash
docker build -t proxy .
docker run --env-file .env.production -p 3000:3000 proxy
```

配置全部通过环境变量传入，镜像内不含敏感文件。

---

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

---

## 开发

```bash
pnpm install
cp cfg/users.json.example cfg/users.json   # 必须：开发环境开了 uid 鉴权
pnpm dev             # build:dev + start:dev
pnpm dev:hot         # watch + 自动重启
pnpm test            # vitest run
pnpm lint            # eslint
pnpm typecheck       # tsc --noEmit
pnpm build:pkg       # 构建全平台二进制 + 压缩包
```

---

## 更多文档

- `readme/` — 多语言 README 和使用指南
- `AGENTS.md` — 架构、初始化流程、配置优先级、踩坑记录
- `.opencode/skills/` — 配置 / 鉴权 / 日志 / 测试专项说明

## 许可

[Apache-2.0](LICENSE)
