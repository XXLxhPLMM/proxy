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

### 六种协议，一个服务

无论你需要 HTTP 透明代理、HTTPS CONNECT 隧道、还是 SOCKS4/SOCKS5 终端代理，SWAIN 都能在一个进程里同时监听所有协议。TLS 版本（SOCKSS4/SOCKSS5）在标准 SOCKS 握手前增加 TLS 握手，为代理流量提供传输层加密。

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
| Windows x64 | `proxy-v6.0.0-win-x64.zip` |
| Linux x64 | `proxy-v6.0.0-linux-x64.zip` |
| macOS x64 | `proxy-v6.0.0-macos-x64.zip` |

```bash
# Linux / macOS
tar -xzf proxy-v6.0.0-linux-x64.zip
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
| node22 | Node >= 22.6 | 与 `package.json` engines 一致 |

```bash
tar -xzf proxy-v6.0.0-node22.zip
cd proxy
node app.js --port 3000
```

Node.js 版本要求为 **22.6 或更高**。开发命令通过 `NODE_ENV=development` 选择环境文件，配置文件由应用 loader 读取；普通 `pnpm start` 保留调用者已有的 `NODE_ENV`（未设置时默认按 development 处理）。

### 从源码构建

```bash
git clone https://github.com/b-hole/proxy.git
cd proxy
pnpm install
pnpm build          # esbuild -> dist/app.js + dist/app-v22.js
pnpm start          # node dist/app.js
```

---

## 配置

### 优先级

```
CLI 参数  >  终端环境变量  >  .env 文件  >  PRESET  >  默认值
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
| `PRESET` | 命名配置预设：`http-server-basic` / `http-client-chain` / `socks5-server` / `sockss5-mtls` / `strict-acl` | 空 | 启动 |

#### 上游代理（`PROXY_MODE=client` 时生效）

| 变量 | 说明 | 默认值 | 生效 |
|------|------|--------|------|
| `UPSTREAM_URL` | 上游代理 URL，格式 `scheme://[user:pass@]host[:port]`，覆盖下面 6 个拆项 | 空 | 运行时 |
| `UPSTREAM_HOST` | 上游主机 | `127.0.0.1` | 运行时 |
| `UPSTREAM_PORT` | 上游端口 | `3000` | 运行时 |
| `UPSTREAM_PROTOCOL` | 上游协议（与入站协议独立） | `http` | 运行时 |
| `UPSTREAM_USERNAME` | 上游用户名 | 空 | 运行时 |
| `UPSTREAM_PASSWORD` | 上游密码 | 空 | 运行时 |
| `UPSTREAM_SECURE` | 强制上游走 TLS（与 `UPSTREAM_PROTOCOL` 推导取并集；`sockss4`/`sockss5` 恒 TLS） | `false` | 运行时 |
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
| `startup` | 需重启 | `HOST` `PORT` `PROXY_PROTOCOL` `TLS_KEY` `TLS_CERT` `TLS_CA` `TLS_PASSPHRASE` `CLUSTER_WORKERS` `USE_HOME_CONFIG` `PRESET` |
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

```ts
import { createProxyInstance } from "@b-hole/proxy";

// 导入库不会读环境、不会起服务：配置即代码。
const instance = createProxyInstance({
  name: "edge",
  config: { port: 8080, proxyProtocol: "socks5", authType: "basic" },
});
await instance.start();

// 配置只经本实例的 scope 读；同进程第二个实例改自己的配置不会影响它。
console.log(instance.config.scope.get("port"));

// 由宿主决定何时优雅停止。
await instance.stop();
```

`createProxyInstance()` **不读 env/CLI**（配置以对象给出，缺省字段回退 `defaults`）；
要走 env 文件 / 终端 env / CLI argv / preset 的完整加载链用
`createProxyInstanceFromEnv({ argv: [] })` —— **必须传 `argv: []`**，否则宿主进程
（例如某个 web 服务器）的 argv 会被当作代理配置解析。

**同进程可以创建任意多个实例，状态完全隔离**（配置、日志、鉴权、ACL、路由、连接集合各一份）：

```ts
const a = createProxyInstance({ name: "edge-a", config: { port: 8080 } });
const b = createProxyInstance({ name: "edge-b", config: { port: 9090, authType: "jwt" } });
await Promise.all([a.start(), b.start()]);

await a.reload({ authEnabled: false }); // 只影响 a
await b.stop();
```

### 换成自己的实现（插件契约）

每个能力域一个 Provider 接口，「同类插件、不同实现、相同 API」；组合根的 `plugins?` 是覆盖点：

```ts
import { createPluginRegistry, createProxyInstance, NoneAuthProvider } from "@b-hole/proxy";

const instance = createProxyInstance({
  config: { port: 8080, authEnabled: true, authType: "basic" },
  plugins: {
    auths: createPluginRegistry([["none", () => new NoneAuthProvider()]]),
  },
});
```

新增能力 = 实现接口 + 往注册表加一项，**不改任何既有代码**。未注册的能力在**装配期**就
抛错（`require()` fail-fast），不会静默回落默认值。

### 进程生命周期归宿主

- **库默认 `allowProcessExit=false`**：代理的 rollback / stop / signal 路径**不会**
  `process.exit`，宿主进程不会被它杀掉。需要退出兜底的宿主显式传
  `{ allowProcessExit: true }`（CLI 就是这么做的）。
- **信号是显式 opt-in**：`start()` 不绑任何进程信号。要让 Ctrl+C 优雅停机，在 `start()`
  **之前**调 `instance.attachSignals()`（SIGINT/SIGTERM，win32 另加 SIGBREAK；cluster
  worker 另监听 master 的 shutdown IPC）。
- `stop()` 的公开视图超时后用 `instance.waitForStopSettled()` 等真实 full stop 兑现，
  不要靠重复 `stop()` 改写 grace。停机在途时 `start()` 会以
  `ERR_PROXY_STOP_IN_PROGRESS` 拒绝，须等 full stop settle 后显式重试。
- **配置热改**：`instance.reload(patch)` 是事务式的 —— startup 字段整批拒绝、字段范围与
  auth 跨字段守卫都走与启动同一套校验、失败保留旧值并抛出。`users.json` / `acl.json` 的
  热加载由 reader 的 1s 节流自动生效，不需要 reload。

### 库边界

公共库只暴露 `src/index.ts` 的闭包：多实例 API（`createProxyInstance` /
`createProxyInstanceFromEnv`）、配置（`createConfigScope` / `initializeConfig` /
`prepareRuntimeConfig`）、插件契约与注册表（`createPluginRegistry` 与全部 `*Provider`）、
默认装配工厂与类型。**没有** `ProxyServer`（它是实例内部编排器，构造需要一整张已接线的
插件图）、**没有** `runServer`、**没有**进程级配置 `get`/`getAll`/`set`，也不提供任何子路径
入口——`package.json` 只有 `"."` 一个 export，配置只能经 `instance.config.scope` 读。

公共库是**零 ESM 依赖的 CommonJS**，基线 Node **>=22.6**（`require(esm)` 需要 >=22.12）。
曾经那层 Cordis 运行时（`src/runtime/`，含 `ConfigService`/`PresetService`/`ErrorService`/
`RuntimeHandle`/`startupFacts`/`eventObserver`）**已整体删除**：不是「CLI 内部所以不导出」，
而是根本不存在。它的职责由 `ConfigScope` 的事务式 `commit`（`prepareRuntimeConfig` +
`instance.reload`）与 `ProxyInstance` 句柄接管，配置资源热加载走零框架依赖的进程内事件总线
（notice 呈现按实例显式订阅）。

`scripts/assert-library-boundary.mjs` 机器守卫这条边界：`build:lib` 与 `build:pkg` 都会在
`lib/` 登记进 manifest 之前校验没有 `lib/runtime`、`cli.*`、任何 cordis 引用，也没有已删除的
全局配置单例 `config/store.*`。其中 cordis 与 `runtime` 断言是**防复活守卫**——拦住「谁又把
ESM-only 依赖或一个新 runtime 层塞回库产物」。

需要进程级托管（cluster fork、Ctrl+C 优雅停机、退出码语义）时，把 CLI 当子进程跑
（`proxy` bin 或 `dist/app.js`），用环境变量和 `cfg/*.json` 驱动，从日志与 stdout 观察。
决策与门禁细节见 `docs/cordis-v6-refactor-plan.md` §14。

---

## 开发

```bash
pnpm install
cp cfg/users.json.example cfg/users.json   # 必须：开发环境开了 uid 鉴权
pnpm dev             # build:dev + start:dev
pnpm dev:hot         # watch + 自动重启
pnpm test:server     # 本地 HTTP 测试源站
pnpm lint            # eslint: src (*.ts) + tests (*.mjs) + build.mjs + scripts (*.mjs)
pnpm typecheck       # tsc --noEmit
pnpm build:pkg       # 受控构建全平台二进制 + 压缩包；任一预期产物缺失都会失败
```

发布构建要求 Node **>=22.6**。`build:pkg` 由受控 wrapper 编排 build、library、pkg
和归档步骤：Windows esbuild 已知退出码 `3221226505` 只有在 `app.js`、`app-v22.js`、
manifest 及库产物完整且 SHA-256 校验通过后才会被接受，其它非零错误不会被吞掉。
`package-dist` 只接受同一批次中已登记并通过 SHA-256 校验的产物，不能把残留文件当成
新包；macOS x64 binary 还必须通过 `codesign` 或 `ldid` 的签名验证，Windows 无法验证
时会明确失败。

发布树、pkg staging、`pkg.assets` 和所有 zip 都用 lstat 递归拒绝 symlink/junction，
并按大小写不敏感规则检查环境文件名：唯一允许的是大小写精确的根级 `.env.example`。
任何 basename 以 `.env` 开头的文件/目录（包括 `keys/` 下的嵌套项）都会被拒绝或剔除，
普通证书仍会打包；`.env.example` 链接不会被解引用。标准清理会独立删除旧二进制、zip、
manifest 及临时 manifest，任一删除失败都会返回非零。

固定发布目录一律用 `ensureRealDirectory` 创建；pkg/archive 私有 staging 目录使用等价的
非递归独占创建，并在创建前后用 lstat 复验。拒绝 `recursive` 的 `mkdir -p`，因为它会跟随
已存在的 junction 并把产物写到树外。归档不会把可变源路径直接交给 yazl：每个源文件先
以 lstat regular 读取到本次归档专用 staging，校验长度/SHA-256 后才以 Buffer 加入 zip。
归档临时 zip 在写入前先 lstat 拒绝已植入的 link，再用独占标志（`O_CREAT|O_EXCL`）创建
——Windows 的 `CreateFile(CREATE_NEW)` 会跟随 reparse point，光靠 `O_EXCL` 挡不住，所以
lstat 前置检查是必需的；写入使用预先独占打开的 fd，关闭前后复验身份/长度，rename 前后都会
复验 dist 仍是真实目录，任何失败都会清理临时文件。归档源与 manifest 校验都走同一份
lstat → open（可用时 `O_NOFOLLOW`）→ fstat → fd read → fstat/lstat 的 regular-file 快照；
pkg 只写私有 output 目录，再复制到独占 staging；只有验证通过的 bytes 才会物化回
`dist/` 供归档读取，macOS x64 验签和最终归档复用验签前后的同一 fd/bytes，任何未登记或
指纹不匹配的 staging 文件都会 fail-closed。yazl 只接收快照
Buffer，不会在异步写入时重新读取可变路径。manifest 的 `files`/`library.files`/`binaries` 一律
规范化为 null 原型 map 并用 `Object.hasOwn` 查找，因此名为 `toString`、`constructor`、
`__proto__` 的文件永远不会被当成「已登记」而绕过未登记文件检查。

---

## 更多文档

- `readme/` — 多语言 README 和使用指南
- `AGENTS.md` — 架构、初始化流程、配置优先级、踩坑记录
- `.opencode/skills/` — 配置 / 鉴权 / 日志 / 测试专项说明

## 许可

[Apache-2.0](LICENSE)
