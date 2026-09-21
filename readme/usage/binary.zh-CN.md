# 使用方法 — 二进制版本

## 系统要求

- 无需安装 Node.js，二进制已内置运行时
- Windows / Linux / macOS x64

## 目录结构

```
proxy/
├── proxy-win.exe              # Windows 可执行文件
├── proxy-linux                # Linux 可执行文件
├── proxy-macos                # macOS 可执行文件
├── .env.example               # 环境变量模板（复制为 .env 后编辑）
├── README.zh-CN.md            # 项目说明（中文）
├── README.en.md               # 项目说明（English）
├── USAGE.zh-CN.md             # 本文件
├── USAGE.en.md                # 本文件（English）
├── cfg/
│   ├── users.json.example     # 账号表模板
│   ├── users.json             # 账号表（空，首次可直接运行）
│   ├── acl.json.example       # 访问控制模板
│   └── acl.json               # 访问控制（空，不拦截任何请求）
└── keys/
    ├── server.crt / server.key   # TLS 服务端证书
    ├── ca.crt / ca.key           # CA 证书
    └── client.crt / client.key   # 客户端证书（mTLS 用）
```

## 安装与运行

### Linux

```bash
# 解压
tar -xzf proxy-v5.0.2-linux-x64.zip
cd proxy

# 添加执行权限
chmod +x proxy-linux

# 启动（默认端口 3000）
./proxy-linux

# 指定端口和协议
./proxy-linux --port 8080 --proxy-protocol socks5
```

### macOS

```bash
tar -xzf proxy-v5.0.2-macos-x64.zip
cd proxy
chmod +x proxy-macos
./proxy-macos --port 3000
```

### Windows

```powershell
# 解压 proxy-v5.0.2-win-x64.zip 后进入目录
proxy-win.exe --port 3000
```

## 配置

### 基本配置

```bash
# 1. 复制环境变量模板
cp .env.example .env

# 2. 编辑 .env
PORT=3000
PROXY_PROTOCOL=http
LOG_LEVEL=info
```

### 启用鉴权

```bash
# 1. 编辑 cfg/users.json 添加账号
[
  { "username": "admin", "password": "your-secret" },
  { "username": "guest", "password": "guest123" }
]

# 2. 在 .env 中启用
AUTH_ENABLED=true
AUTH_TYPE=basic
```

### 配置上游代理

> **注意**：上游代理仅在 `PROXY_MODE=client` 时生效，默认 `server` 模式直连目标。

```bash
# 1. 启用客户端模式
PROXY_MODE=client

# 2. 方式一：标准 URL（推荐）
UPSTREAM_URL=http://user:pass@upstream-proxy:8080

# 2. 方式二：拆项配置
UPSTREAM_HOST=upstream-proxy
UPSTREAM_PORT=8080
UPSTREAM_PROTOCOL=socks5
UPSTREAM_USERNAME=user
UPSTREAM_PASSWORD=pass
```

### 配置 TLS

```bash
TLS_KEY=keys/server.key
TLS_CERT=keys/server.crt
PROXY_PROTOCOL=https
```

### 配置访问控制

编辑 `cfg/acl.json`：

```json
{
  "clientIp": {
    "whitelist": ["127.0.0.1", "10.0.0.0/8"],
    "blacklist": []
  },
  "target": {
    "whitelist": ["*.google.com", "*.github.com"],
    "blacklist": ["ads.example.net"]
  }
}
```

## 常用命令

```bash
# 基本启动
./proxy-linux --port 3000

# SOCKS5 代理
./proxy-linux --proxy-protocol socks5

# HTTPS 代理（需要 TLS 证书）
./proxy-linux --proxy-protocol https

# 客户端模式（转发到上游）
./proxy-linux --proxy-mode client --upstream-url http://up:8080

# 查看所有可用参数
./proxy-linux --help
```

## 注意事项

- `cfg/users.json` 和 `cfg/acl.json` 已预置空配置，首次可直接运行
- 如需鉴权，编辑 `cfg/users.json` 添加账号后重启
- TLS 证书在 `keys/` 目录，生产环境请替换为正式证书
- 修改 `cfg/users.json` 或 `cfg/acl.json` 后无需重启，最多 1 秒自动生效
- 日志默认只输出 error 级别到控制台，配置 `LOG_FILE` 可开启 JSONL 落盘
