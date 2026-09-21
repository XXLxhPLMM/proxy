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
- **访问控制** — 客户端 IP 黑白名单 + 目标地址黑白名单，域名通配符匹配
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

需要本地安装 Node.js（>= 16 即可运行 node16 版本，>= 22 推荐 node22 版本）：

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
  }
}
```

- **黑名单命中 → 拒绝（优先）；白名单非空且未命中 → 拒绝；皆空 → 放行**
- `clientIp` 只认 TCP 对端地址（不看 `X-Forwarded-For`）
- `target` 按客户端请求的 host 字符串匹配，不做 DNS 解析
- `*.a.com` 只匹配 `a.com` 的子域，不含 `a.com` 本身
- 两个文件均热加载，改动最多 1 秒生效

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
import { ProxyServer, runServer, get, getAll, set } from "@b-hole/proxy";
```

导入即完成配置初始化；未直接执行时不会启动服务。

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
