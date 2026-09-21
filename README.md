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
| node16 | Node >= 16 | 兼容性好 |
| node22 | Node >= 22 | 性能更优 |

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

### 核心变量

```bash
PORT=3000                          # 监听端口
PROXY_PROTOCOL=http                # 代理协议
AUTH_ENABLED=false                 # 是否启用鉴权
AUTH_TYPE=none                     # 鉴权类型
UPSTREAM_URL=http://up:8080        # 上游代理
CLUSTER_WORKERS=1                  # Worker 数量（0=CPU 核数）
LOG_LEVEL=error                    # 控制台日志等级
LOG_FILE=                          # 日志目录（空=不落盘）
```

完整变量列表见 `.env.example`。

### 生效时机

| 类型 | 改动后 | 字段 |
|------|-------|------|
| `startup` | 需重启 | `host` `port` `proxyProtocol` `tls*` `clusterWorkers` |
| `runtime` | 立即生效 | 鉴权、日志、上游、ACL 等 |

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

```bash
# 通过 URL 一次性指定
UPSTREAM_URL=http://user:pass@proxy.example.com:8080

# 或拆项配置
UPSTREAM_HOST=proxy.example.com
UPSTREAM_PORT=8080
UPSTREAM_PROTOCOL=socks5
UPSTREAM_USERNAME=user
UPSTREAM_PASSWORD=pass
```

支持将任意入站协议转发到任意出站协议，上下游完全独立。

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
import { ProxyServer, runServer, get, getAll, set } from "@b-hole/proxy";

// 导入即完成配置初始化
// set("port", 8080) 可在启动前修改配置
// runServer() 启动服务
```

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
