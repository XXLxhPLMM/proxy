# @b-hole/proxy

多功能代理服务器，支持 HTTP、HTTPS、SOCKS、TLS 多种代理协议，提供认证鉴权、IP 过滤、域名过滤、证书双向验证等安全能力，适用于内网穿透、流量转发、安全代理等场景。

## 功能特性

- **多协议代理** — HTTP、HTTPS、SOCKS、TLS 四种代理模式
- **四种运行模式** — Manager（管理器）、Server（代理服务器）、Client（客户端）、Intermediary（中继器）
- **认证鉴权** — 支持 JWT、账号密码（pwd）、Base64（basic）、字符串（string）四种认证方式
- **IP 过滤** — 基于白名单 / 黑名单的 IP 访问控制，支持通配符规则
- **域名过滤** — 客户端支持域名包含 / 排除规则，按需代理
- **TLS 双向认证** — 支持 mTLS 双向证书验证，保障链路安全
- **压缩处理** — 中继器自动处理 gzip / deflate / zip 压缩响应
- **动态配置** — 运行时通过进程事件动态更新配置（域名规则、鉴权开关、目标地址等）
- **Docker 部署** — 内置 Dockerfile，支持容器化部署

## 技术栈

| 类别 | 技术 |
| :--- | :--- |
| 运行时 | Node.js 14+ |
| 语言 | TypeScript |
| Web 框架 | Koa.js |
| 实时通信 | Socket.io |
| 代理 | http-proxy-agent、https-proxy-agent、socks |
| 缓存 | Redis（ioredis） |
| 认证 | jsonwebtoken |
| 日志 | log4js |
| HTTP 解析 | http-parser-js |
| 构建 | Webpack + ts-loader |
| 打包 | pkg（可执行文件） |

## 项目结构

```
proxy/
├── keys/                        # SSL/TLS 证书目录
│   ├── ca.crt                   # CA 证书
│   ├── ca.key                   # CA 私钥
│   ├── ca.srl                   # CA 序列号
│   ├── server.crt               # 服务器证书
│   ├── server.key               # 服务器私钥
│   ├── client.crt               # 客户端证书
│   └── client.key               # 客户端私钥
├── src/
│   ├── app.ts                   # 应用入口，根据 APP_MODE 启动对应模块
│   ├── config/
│   │   └── load.ts              # 配置加载，环境变量解析，动态配置监听
│   ├── manager/                 # Manager 管理器模块
│   │   ├── index.ts             # 管理器入口
│   │   ├── starter/
│   │   │   └── index.ts         # Koa 应用创建，集成 Socket.io
│   │   ├── router/
│   │   │   └── index.ts         # 路由注册，Socket 连接管理
│   │   ├── auth/
│   │   │   └── index.ts         # 认证工具（开发中）
│   │   └── utils/
│   │       └── cache.ts         # 缓存工具、代理服务器映射
│   ├── server/                  # Server 代理服务器模块
│   │   ├── index.ts             # 服务器入口，根据 SERVER_MODE 启动对应代理
│   │   ├── auth.ts              # 鉴权处理器，支持 JWT/pwd/basic/string
│   │   ├── http-proxy.ts        # HTTP/HTTPS 代理实现
│   │   ├── net-proxy.ts         # SOCKS 代理实现（基于 TCP）
│   │   └── tsl-proxy.ts         # TLS 代理实现（基于 mTLS）
│   ├── client/                  # Client 客户端模块
│   │   └── index.ts             # 客户端代理，域名过滤，鉴权注入
│   ├── intermediary/            # Intermediary 中继器模块
│   │   └── index.ts             # HTTP/HTTPS 中继代理，压缩处理
│   └── utils/                   # 通用工具
│       ├── file-util.ts         # 文件读取工具
│       ├── ip-util.ts           # IP 过滤、域名匹配工具
│       ├── log.ts               # log4js 日志配置
│       ├── reslover.ts          # HTTP 请求解析器
│       └── transform.ts         # Transform 流，鉴权注入
├── .env                         # 生产环境配置
├── .env.dev                     # 开发环境配置
├── Dockerfile                   # Docker 构建文件
├── webpack.config.js            # Webpack 构建配置
├── tsconfig.json                # TypeScript 配置
├── .eslintrc.js                 # ESLint 配置
└── package.json                 # 项目配置
```

## 快速开始

### 环境要求

- Node.js >= 14
- pnpm（推荐）或 npm
- OpenSSL（生成证书时需要）
- Redis（可选，用于缓存）

### 安装

```bash
# 克隆项目
git clone <repository-url>
cd proxy

# 安装依赖
pnpm install
```

### 生成证书

TLS / HTTPS 代理模式需要 SSL 证书。项目已内置默认证书（`keys/` 目录），生产环境请自行生成：

```bash
cd keys

# 1. 生成 CA 私钥（需设置密码）
openssl genpkey -algorithm RSA -out ca.key -aes256

# 2. 生成 CA 证书签名请求
openssl req -new -key ca.key -out ca.csr

# 3. 生成自签名 CA 证书
openssl req -x509 -days 365 -key ca.key -in ca.csr -out ca.crt

# 4. 生成服务器私钥（需设置密码，与 .env 中 S_SERVER_PASSWORD 一致）
openssl genpkey -algorithm RSA -out server.key -aes256

# 5. 生成服务器 CSR
openssl req -new -key server.key -out server.csr

# 6. 使用 CA 签名服务器证书
openssl x509 -req -days 365 -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out server.crt

# 7. 生成客户端私钥（需设置密码，与 .env 中 S_CLIENT_PASSWORD 一致）
openssl genpkey -algorithm RSA -out client.key -aes256

# 8. 生成客户端 CSR
openssl req -new -key client.key -out client.csr

# 9. 使用 CA 签名客户端证书
openssl x509 -req -days 365 -in client.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out client.crt
```

### 启动服务

```bash
# 构建 + 启动（默认 server 模式）
pnpm dev

# 构建 + 启动客户端模式
pnpm dev-client

# 构建 + 启动中继器模式
pnpm dev-IM

# 仅构建
pnpm build

# 仅启动（需先构建）
pnpm start

# 指定模式启动
pnpm start APP_MODE=server
pnpm start APP_MODE=client
pnpm start APP_MODE=intermediary
```

## 运行模式详解

### 1. Server — 代理服务器

代理服务的核心，接收客户端请求并转发到目标服务器。支持四种代理协议，由 `SERVER_MODE` 环境变量控制：

| SERVER_MODE | 协议 | 说明 | 默认端口 |
| :--- | :--- | :--- | :--- |
| `http` | HTTP | 处理 HTTP 请求 + HTTPS CONNECT 隧道 | 4455 |
| `https` | HTTPS | 基于 SSL 的 HTTP 代理，需服务器证书 | 4455 |
| `socks` | SOCKS | TCP 层代理，解析 HTTP 报文转发 | 4455 |
| `tls` | TLS | 基于 TLS 的代理，支持双向证书验证 | 4455 |

**工作流程**：

1. 客户端发起代理请求
2. 服务器验证身份（IP 过滤 + 鉴权）
3. 解析目标地址（HTTP 解析器）
4. 建立到目标服务器的连接
5. 双向数据转发（pipe）

### 2. Client — 客户端代理

部署在用户侧，拦截本地流量并转发到 Server。核心能力：

- **域名过滤** — 通过 `CLIENT_INCLUDE_DOMAIN` / `CLIENT_EXCLUDE_DOMAIN` 控制哪些域名走代理
- **鉴权注入** — 自动在请求头中注入 `Proxy-Authorization`，支持四种认证方式
- **协议适配** — 根据 `TARGET_TYPE` 选择连接方式（http / https / tls）

**工作流程**：

1. 本地应用发送请求到 Client 监听端口
2. Client 解析请求头中的 Host
3. 域名规则判断：命中排除规则 → 直连目标；命中包含规则或无规则 → 走代理
4. 走代理时，通过 `ClientConnectTransform` 注入鉴权信息
5. 建立到 Server 的连接并双向转发数据

### 3. Intermediary — 中继器

HTTP API 形式的代理中转服务，适用于无法直接使用代理协议的场景。接收 JSON 格式的代理请求，通过 http-proxy-agent / https-proxy-agent 转发。

**请求格式**：

```json
{
  "url": "https://example.com/api",
  "headers": { "Content-Type": "application/json" },
  "method": "GET",
  "data": "",
  "port": 443,
  "params": {},
  "proxy": {
    "auth": "dXNlcjpwYXNz",
    "auth_type": "pwd",
    "url": "http://proxy-server:4455"
  }
}
```

**响应格式**：

```json
{
  "headers": {},
  "message": "OK",
  "httpVersion": "1.1",
  "statusCode": 200,
  "data": "<response-body>"
}
```

**特性**：

- 自动处理 gzip / deflate / zip 压缩响应
- 自动检测字符编码
- 支持 HTTP / HTTPS 目标地址

### 4. Manager — 管理器

基于 Koa + Socket.io 的管理服务，用于集中管理代理集群。

- HTTP API 路由管理
- WebSocket 实时通信（Socket.io）
- 代理服务器状态监控
- 动态配置下发

> Manager 模块当前为基础框架，API 路由和 Socket 事件可按需扩展。

## 配置说明

### 环境变量

配置通过 `.env` 文件加载，支持多环境（`.env.dev`、`.env.prod`）。启动时可通过命令行参数覆盖：

```bash
pnpm start APP_MODE=server SERVER_MODE=tls PORT=8080
```

#### 核心配置

| 变量 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `APP_MODE` | `server` | 运行模式：`manager` / `server` / `client` / `intermediary` |
| `APP_VERSION` | `1.0.0` | 应用版本号 |
| `PORT` | `444` | Manager 监听端口 |
| `SERVER_PORT` | `4455` | Server 代理服务端口 |
| `CLIENT_PORT` | `4456` | Client 监听端口 |
| `INTERMEDIARY_PORT` | `3000` | Intermediary 中继端口 |
| `DIRECT_STARTING` | `true` | 是否直接启动（不作为库引用时设为 true） |

#### 代理配置

| 变量 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `SERVER_MODE` | `http` | 服务器代理协议：`http` / `https` / `socks` / `tls` |
| `TARGET_HOST` | `localhost` | Client 连接的目标 Server 地址 |
| `TARGET_PORT` | `4455` | Client 连接的目标 Server 端口 |
| `TARGET_TYPE` | `http` | Client 连接目标的方式：`http` / `https` / `tls` |
| `HANDLE_COMPRESS` | `true` | Intermediary 是否自动解压响应 |

#### 认证配置

| 变量 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `APP_USE_AUTH` | `false` | 是否启用代理鉴权 |
| `AUTH_TYPE` | `jwt` | 认证方式：`jwt` / `pwd` / `basic` / `string` |
| `PROXY_SECRET` | `9f7ff6cf...` | JWT 密钥 / 代理密钥 |
| `KEY` | `9f7ff6cf...` | 通用密钥 |
| `AUTH_USERNAME` | `xxlAdmin` | pwd 认证用户名 |
| `AUTH_PASSWORD` | `xxl123456` | pwd 认证密码 |

#### IP 过滤配置

| 变量 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `USE_IP_FILTER` | `true` | 是否启用 IP 过滤 |
| `WHITE_LIST` | （空） | IP 白名单，逗号分隔，支持通配符 `*` |
| `BLACK_LIST` | （空） | IP 黑名单，逗号分隔，支持通配符 `*` |

**白名单示例**：`WHITE_LIST=192.168.1.*,10.0.0.*`

**黑名单示例**：`BLACK_LIST=192.168.2.100`

> 白名单优先级高于黑名单。白名单为空时，仅黑名单生效；白名单非空时，不在白名单中的 IP 一律拒绝。

#### 域名过滤配置（Client 模式）

| 变量 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `CLIENT_INCLUDE_DOMAIN` | （空） | 域名白名单，逗号分隔，走代理 |
| `CLIENT_EXCLUDE_DOMAIN` | （空） | 域名黑名单，逗号分隔，直连 |

**白名单示例**：`CLIENT_INCLUDE_DOMAIN=*.google.com,*.github.com`

**黑名单示例**：`CLIENT_EXCLUDE_DOMAIN=*.baidu.com,*.local`

> 白名单优先级高于黑名单。设置了白名单后，仅白名单域名走代理，其余直连；未设白名单时，黑名单域名直连，其余走代理。

#### 证书配置

| 变量 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `S_CA_CERT` | `./keys/ca.crt` | CA 证书路径 |
| `S_SERVER_CERT` | `./keys/server.crt` | 服务器证书路径 |
| `S_SERVER_KEY` | `./keys/server.key` | 服务器私钥路径 |
| `S_SERVER_PASSWORD` | `123456` | 服务器私钥密码 |
| `S_CLIENT_CERT` | `./keys/client.crt` | 客户端证书路径 |
| `S_CLIENT_KEY` | `./keys/client.key` | 客户端私钥路径 |
| `S_CLIENT_PASSWORD` | `123456` | 客户端私钥密码 |
| `APP_BOTHWAY_AUTH` | `false` | 是否启用双向证书验证 |
| `APP_AUTH_CERT` | `true` | 是否验证对端证书合法性 |

#### 日志配置

| 变量 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `APP_LOGGER_LEVEL` | `debug` | 日志级别：`debug` / `info` / `warn` / `error` |

### 配置文件示例

**生产环境** `.env`：

```env
KEY=your-secret-key
PORT=444
SERVER_PORT=4455
CLIENT_PORT=4456
APP_LOGGER_LEVEL=info
APP_USE_AUTH=true
DIRECT_STARTING=true
AUTH_TYPE=pwd
SERVER_MODE=tls
TARGET_TYPE=tls
APP_AUTH_CERT=false
APP_BOTHWAY_AUTH=true
```

**开发环境** `.env.dev`：

```env
KEY=your-secret-key
PORT=444
SERVER_PORT=4455
CLIENT_PORT=4456
APP_LOGGER_LEVEL=debug
APP_USE_AUTH=false
DIRECT_STARTING=true
AUTH_TYPE=pwd
SERVER_MODE=http
TARGET_TYPE=tls
APP_AUTH_CERT=false
APP_BOTHWAY_AUTH=true
```

## 认证方式详解

### JWT 认证（`AUTH_TYPE=jwt`）

基于 JSON Web Token 的认证。客户端在 `Proxy-Authorization` 头中携带 JWT Token，服务器使用 `PROXY_SECRET` 验证签名。支持 Token 强制下线机制。

```
Proxy-Authorization: Bearer <jwt-token>
```

### 账号密码认证（`AUTH_TYPE=pwd`）

使用 Base64 编码的用户名密码对。

```
Proxy-Authorization: Basic base64(username:password)
```

### Base64 认证（`AUTH_TYPE=basic`）

使用 Base64 编码的密钥字符串。

```
Proxy-Authorization: Basic base64(secret_key)
```

### 字符串认证（`AUTH_TYPE=string`）

直接使用明文密钥字符串。

```
Proxy-Authorization: your-secret-key
```

## 典型部署架构

### 基础代理

```
浏览器 → Client(4456) → Server(4455) → 目标网站
```

适用于本地开发代理，Client 拦截浏览器请求并转发到远程 Server。

### TLS 安全代理

```
浏览器 → Client(4456) ─TLS─→ Server(4455) → 目标网站
```

Client 与 Server 之间通过 TLS 加密传输，支持双向证书验证，防止中间人攻击。

### 多级中继

```
应用 → Intermediary(3000) → Server(4455) → 目标网站
```

适用于无法设置系统代理的场景，通过 HTTP API 调用方式使用代理。

### 集群管理

```
Manager(3000)
  ├── Server-A(4455)
  ├── Server-B(4456)
  └── Server-C(4457)
```

Manager 通过 Socket.io 管理多个 Server 实例，统一配置下发和状态监控。

## Docker 部署

### 构建镜像

```bash
docker build -t proxy-server .
```

### 运行容器

```bash
# Server 模式
docker run -d \
  --name proxy-server \
  -p 4455:4455 \
  -e APP_MODE=server \
  -e SERVER_MODE=tls \
  -e APP_USE_AUTH=true \
  -e AUTH_TYPE=pwd \
  proxy-server

# Client 模式
docker run -d \
  --name proxy-client \
  -p 4456:4456 \
  -e APP_MODE=client \
  -e TARGET_HOST=your-server-host \
  -e TARGET_PORT=4455 \
  -e TARGET_TYPE=tls \
  proxy-server

# Intermediary 模式
docker run -d \
  --name proxy-intermediary \
  -p 3000:3000 \
  -e APP_MODE=intermediary \
  proxy-server
```

### Docker Compose 示例

```yaml
version: "3"
services:
  proxy-server:
    build: .
    ports:
      - "4455:4455"
    environment:
      - APP_MODE=server
      - SERVER_MODE=tls
      - APP_USE_AUTH=true
      - AUTH_TYPE=pwd
      - AUTH_USERNAME=admin
      - AUTH_PASSWORD=secure_password
    volumes:
      - ./keys:/app/keys

  proxy-client:
    build: .
    ports:
      - "4456:4456"
    environment:
      - APP_MODE=client
      - TARGET_HOST=proxy-server
      - TARGET_PORT=4455
      - TARGET_TYPE=tls
    depends_on:
      - proxy-server
```

## 开发指南

### 可用脚本

| 命令 | 说明 |
| :--- | :--- |
| `pnpm install` | 安装依赖 |
| `pnpm build` | Webpack 构建到 `dist/` |
| `pnpm build-lib` | TypeScript 编译到 `lib/`（库模式） |
| `pnpm start` | 运行 `dist/app.js` |
| `pnpm dev` | 构建 + 启动（默认 server 模式） |
| `pnpm dev-client` | 构建 + 启动 client 模式 |
| `pnpm dev-IM` | 构建 + 启动 intermediary 模式 |
| `pnpm lint` | ESLint 检查并自动修复 |
| `pnpm version:main` | 主版本号升级 |
| `pnpm version:update` | 次版本号升级 |
| `pnpm version:fix` | 修订号升级 |

### 作为库使用

项目支持作为 npm 包引入，不自动启动：

```typescript
import { run, runServer, runClient, runIntermediary, runManager } from "@b-hole/proxy";

// 手动调用需要的模式
runServer();
```

> 当 `DIRECT_STARTING` 不为 `true` 时，导入包不会自动启动，需手动调用 `run()` 或具体模式的函数。

### 动态配置

运行时可通过 Node.js 进程事件动态更新配置：

```typescript
import { ConfigMap } from "./config/load";

// 更新域名排除规则
process.emit("proxy_change:client_exclude_domain", ["*.local", "*.internal"]);

// 更新域名包含规则
process.emit("proxy_change:client_include_domain", ["*.google.com"]);

// 更新鉴权开关
process.emit("proxy_change:use_auth", true);

// 更新目标地址
process.emit("proxy_change:target_host", "new-server.example.com");
process.emit("proxy_change:target_port", 8080);

// 更新代理密钥
process.emit("proxy_change:proxy_secret", "new-secret-key");
```

### 打包为可执行文件

```bash
# 先构建
pnpm build

# 使用 pkg 打包
npx pkg . --targets node14-win-x64 --output proxy-server.exe
```

## 故障排除

| 问题 | 原因 | 解决方案 |
| :--- | :--- | :--- |
| 端口启动失败 | 端口被占用 | 修改 `SERVER_PORT` / `CLIENT_PORT` / `PORT` 配置 |
| TLS 连接失败 | 证书缺失或密码不匹配 | 检查 `keys/` 目录，确认私钥密码与配置一致 |
| 鉴权失败 | 认证方式或密钥不匹配 | 检查 `AUTH_TYPE` 和对应的密钥配置 |
| IP 被拒绝 | IP 过滤规则命中 | 检查 `WHITE_LIST` / `BLACK_LIST` 配置 |
| 域名未走代理 | 域名过滤规则不匹配 | 检查 `CLIENT_INCLUDE_DOMAIN` / `CLIENT_EXCLUDE_DOMAIN` |
| 证书验证失败 | 双向认证配置不一致 | 确认 `APP_BOTHWAY_AUTH` 和 `APP_AUTH_CERT` 配置 |

## 许可证

Apache License 2.0
