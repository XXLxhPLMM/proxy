[English](README.en.md) | 简体中文

# @b-hole/proxy

多协议正向代理服务 — HTTP / HTTPS / SOCKS4 / SOCKS5 / SOCKSS4 / SOCKSS5，支持双端异构串联、cluster 多进程与四种鉴权方式。

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.6-brightgreen.svg)](https://nodejs.org)

---

## 特性

- **六种协议** — HTTP / HTTPS / SOCKS4 / SOCKS5 / SOCKSS4（TLS + SOCKS4）/ SOCKSS5（TLS + SOCKS5）
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

需要本地安装 Node.js >= 22.6（与 `package.json` 的 engines 一致）：

```bash
# 解压 node.js 版本压缩包
tar -xzf proxy-v*-node22.zip
cd proxy
node app.js --port 3000
```

Node.js 版本要求为 **22.6 或更高**。开发命令使用 `NODE_ENV=development` 选择环境文件，配置文件由应用 loader 读取；普通 `pnpm start` 保留调用者已有的 `NODE_ENV`（未设置时按 development 处理）。

### 从源码构建

```bash
git clone https://github.com/b-hole/proxy.git
cd proxy
pnpm install
pnpm build          # esbuild -> dist/app.js + dist/app-v22.js
pnpm start          # node dist/app.js
```

## 配置

### 优先级

```
CLI 参数  >  终端环境变量  >  .env 文件  >  PRESET  >  默认值
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
| `PRESET` | 命名配置预设 | 空 | 启动 |

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
| `startup` | 启动时一次性读取，改动需重启 | `HOST` `PORT` `PROXY_PROTOCOL` `TLS_KEY` `TLS_CERT` `TLS_CA` `TLS_PASSPHRASE` `CLUSTER_WORKERS` `USE_HOME_CONFIG` `PRESET` |
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

```ts
import { initializeConfig, runServer, set } from "@b-hole/proxy";

// 导入库不会读取环境或启动服务；先显式初始化，再做程序化修改。
initializeConfig();
set("port", 8080);
const server = await runServer();
// master 分支返回 null；单进程/worker 才会拿到可编程式停机句柄。
if (server) {
  // 由宿主决定何时优雅停止；库默认 allowProcessExit=false，不会调用 process.exit。
  await server.stop();
}
```

`initializeConfig()` 是库入口提供的显式配置入口。`runServer()` 对未初始化调用
仍会执行一次幂等初始化，但为避免初始化覆盖程序化 `set()`，请始终按
`initializeConfig() → set() → runServer()` 的顺序使用。库默认 `allowProcessExit=false`；
只有 CLI 或明确拥有进程退出权的宿主才传 `{ allowProcessExit: true }`。

### runtime 不属于库

公共库只暴露 `src/index.ts` 的闭包，**不包含 Cordis runtime**。`ConfigService`、
`PresetService`、`LoggerService`、`ErrorService`、`RuntimeHandle`、`startupFacts` 和
`eventObserver` 都是 CLI 内部实现：库不承诺 runtime 事件，也不承诺 runtime reload，
也不提供 `@b-hole/proxy/runtime` 之类的子路径入口。原因是 cordis 只提供 ESM 且是构建期
依赖，而公共库是 CommonJS、基线为 Node **>=22.6**（`require(esm)` 需要 >=22.12）。
`scripts/assert-library-boundary.mjs` 会机器守卫这条边界：`build:lib` 与 `build:pkg` 在
`lib/` 登记进 manifest 之前都会校验没有 `lib/runtime`、`cli.*` 和任何 cordis 引用。

替代路径：需要 runtime 事件、事务式配置 reload 或启动审计时，把 CLI 当子进程跑（`proxy`
bin 或 `dist/app.js`），用环境变量和 `cfg/*.json` 驱动；需要程序化控制时用 `runServer()` +
`ProxyServer` 句柄 + `get`/`getAll`/`set`，`stop()` 公开视图超时后用
`ProxyServer.waitForStopSettled()` 等真实 full stop。库侧的 `set()` 是进程化写入，不经过
runtime 的 candidate 校验。

## 开发

```bash
pnpm install
cp cfg/users.json.example cfg/users.json   # 必须：.env.development 开了 uid 鉴权
pnpm dev             # build:dev + start:dev
pnpm dev:hot         # watch + 自动重启
pnpm test:server     # 本地 HTTP 测试源站
pnpm lint            # eslint: src (*.ts) + tests (*.mjs) + build.mjs + scripts (*.mjs)
pnpm typecheck       # tsc --noEmit
pnpm build:pkg       # 受控构建全平台二进制 + 压缩包；缺失产物会失败
```

发布构建要求 Node **>=22.6**。受控的 `build:pkg` wrapper 会依次执行 build、library、pkg 和归档阶段。Windows esbuild 已知退出码 `3221226505` 只有在 `app.js`、`app-v22.js`、manifest 及库产物完整并通过 SHA-256 校验后才会被接受；其它非零错误会原样传播。`package-dist` 只接受同一批次登记且通过 SHA-256 校验的产物，并使用 `codesign` 或 `ldid` 验证 macOS x64 binary；无法验证签名的主机（包括没有验证工具的 Windows）会 fail-closed。
发布树、pkg staging、`pkg.assets` 和所有 zip 都用 lstat 扫描并拒绝 symlink/junction。
环境 basename 按大小写不敏感匹配，唯一允许的是大小写精确的根级 `.env.example`。任何
basename 以 `.env` 开头的文件或目录（包括 `keys/` 下的嵌套项）都会被拒绝或剔除，
普通证书仍会保留在发布包中；`.env.example` symlink 不会被解引用。清理阶段会独立尝试
删除 binary、zip、manifest 和临时 manifest；任一删除失败都会返回非零，不会让旧归档
继续被误收集。固定发布目录使用非递归、创建后 lstat 复验的目录 helper；pkg 与归档的
私有 staging 目录使用独占创建。所有可变文件读取统一走 lstat → open（可用时 `O_NOFOLLOW`）
→ fstat → fd read → fstat/lstat 身份与长度/哈希闭环；pkg 只写私有 output 目录，再复制到
独占 regular-file staging，只有验证通过的 bytes 才会物化回 `dist/` 供归档读取；macOS x64
验签与最终归档复用同一份已验签 fd/bytes。归档源先与
manifest 指纹双向对账，yazl 只接收快照 Buffer；临时 zip 通过预先独占打开的 fd 写入，并在
关闭/rename 前后复验身份。manifest 的 `files`/`library.files`/`binaries` 一律是 null 原型
记录并用 `Object.hasOwn` 查找，`toString`、`constructor`、`__proto__` 等名字不能绕过未登记
文件检查。

## 许可

[Apache-2.0](LICENSE)
