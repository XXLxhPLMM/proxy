# 使用方法 — Node.js 版本

## 环境要求

- **Node.js 版本**：Node.js >= 22.6（与 package.json 的 engines 字段一致）
- 压缩包内的 `app.js` 使用同一 Node.js >=22.6 基线构建。应用 loader 会自行读取 `.env.production`、`.env.development` 和 `.env.<NODE_ENV>`，不依赖更新版本 Node.js 的命令行 env-file 参数。

## 目录结构

```
proxy/
├── app.js                    # 主程序
├── package.json              # 版本信息
├── .env.example              # 环境变量模板（复制为 .env 后编辑）
├── README.zh-CN.md           # 项目说明（中文）
├── README.en.md              # 项目说明（English）
├── USAGE.zh-CN.md            # 本文件
├── USAGE.en.md               # 本文件（English）
├── cfg/
│   ├── users.json.example    # 账号表模板
│   ├── users.json            # 账号表（空，首次可直接运行）
│   ├── acl.json.example      # 访问控制模板
│   └── acl.json              # 访问控制（空，不拦截任何请求）
└── keys/
    ├── server.crt / server.key   # TLS 服务端证书
    ├── ca.crt / ca.key           # CA 证书
    └── client.crt / client.key   # 客户端证书（mTLS 用）
```

## 安装与运行

```bash
# 解压
tar -xzf proxy-v6.0.0-node22.zip
cd proxy

# 启动（默认端口 3000）
node app.js

# 指定端口和协议
node app.js --port 8080 --proxy-protocol socks5
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

编辑 `cfg/acl.json`，三组名单职责不同：

- **`clientIp`** — 谁能用这个代理（来源判定），**只收 IP / CIDR**
- **`target`** — 代理允许连去哪（目标判定），收 **IP / CIDR / 域名 / `*.通配域名`**，拒绝 = `403` / 握手断开
- **`upstream`** — client 模式怎么路由（路由判定），条目语法同 `target`；**动作 = 直连（不交上游）**，仅 `PROXY_MODE=client` 生效，`server` 模式忽略

`clientIp` / `target` 语义：**黑名单命中 → 拒绝（优先）；白名单非空且未命中 → 拒绝；皆空 → 放行**。
`upstream` 语义（动作 = 路由，不决定放行 / 拒绝）：**黑名单命中 → 直连（黑 > 白）；白名单非空且未命中 → 直连；皆空（含整组 / 文件缺失）→ 走上游（默认，同旧版）**——**走上游 ⇔ 命中 whitelist ∧ 未命中 blacklist，其余 → 直连**。
判定顺序：`clientIp`（谁能用）→ 鉴权 → `target`（能不能访问）→ `upstream`（怎么路由）→ 拨号；**路由名单绝不豁免 `target` 拒绝**。
修改最多 1 秒生效，无需重启。

#### 场景示例

**① 屏蔽指定目标域名（含子域）**

```json
{
  "clientIp": { "whitelist": [], "blacklist": [] },
  "target": { "blacklist": ["openrouter.ai", "*.openrouter.ai"] }
}
```

效果：请求 `openrouter.ai` 及其子域时，HTTP / CONNECT 在**拨号前**回 `403`（目标站点收不到任何连接），SOCKS 返回失败应答。`*.a.com` 不含裸域 `a.com` 本身，所以裸域与通配要**两条都写**。

**② 屏蔽一批广告 / 恶意站点**

```json
{
  "clientIp": { "whitelist": [], "blacklist": [] },
  "target": { "blacklist": ["ads.example.net", "tracker.example.org", "*.malware.test"] }
}
```

**③ 只允许访问指定目标（白名单模式）**

```json
{
  "clientIp": { "whitelist": [], "blacklist": [] },
  "target": { "whitelist": ["*.google.com", "*.github.com"] }
}
```

效果：白名单一旦非空就是**默认拒绝**——名单外的所有目标一律 `403`。

**④ 封禁来源 IP / IP 段**

```json
{
  "clientIp": { "whitelist": [], "blacklist": ["203.0.113.7", "198.51.100.0/24"] },
  "target": { "whitelist": [], "blacklist": [] }
}
```

效果：这些地址连代理就被拒，且发生在**消耗鉴权之前**——HTTP / CONNECT / WebSocket 回 `403`；SOCKS 在**握手前直接断开**（不回任何字节）。命中记 warn 日志 `[ip-denied]`。IP 范围用 CIDR，**没有 `*` 通配**（`198.51.*.*` 会启动中止）。

**⑤ 仅限本机与内网使用**

```json
{
  "clientIp": { "whitelist": ["127.0.0.1", "::1", "10.0.0.0/8", "192.168.0.0/16"] },
  "target": { "whitelist": [], "blacklist": [] }
}
```

效果：只有名单内的来源能连，其他来源（含解析不出的地址）同上被拒——fail-closed。

**⑥ 域名 + IP 两头堵（防绕过）**

```json
{
  "clientIp": { "whitelist": [], "blacklist": [] },
  "target": { "blacklist": ["openrouter.ai", "*.openrouter.ai", "x.x.x.x/24"] }
}
```

效果：`target` 域名条目按请求 host 字符串匹配、**不做 DNS 解析**——客户端不写域名、直接写 IP 就能绕开域名条目。把该域名的解析 IP/CIDR 一并写入，两头才都堵死（占位 `x.x.x.x/24` 请换成实际地址段）。

**⑦ 组合：内网专用 + 目标黑白名单**

```json
{
  "clientIp": { "whitelist": ["127.0.0.1", "10.0.0.0/8"] },
  "target": { "whitelist": ["*.example.com"], "blacklist": ["secret.example.com"] }
}
```

效果：`clientIp` 白名单挡住外部来源；`target` 黑名单**优先于白名单**——`secret.example.com` 即使被 `*.example.com` 覆盖也照样拒。注意**白名单不豁免认证**：命中后仍要按 `AUTH_*` 提供凭证（鉴权拒绝回 `407`，与 ACL 的 `403` 区分）。

**⑧ 不拦截任何请求（默认）**

```json
{
  "clientIp": { "whitelist": [], "blacklist": [] },
  "target": { "whitelist": [], "blacklist": [] }
}
```

文件缺失与空名单等效：不拦截任何请求。

> **⑨–⑫ 仅在 `PROXY_MODE=client` 下生效**：`upstream` 组的动作 = **直连**（不交上游，**黑 > 白**），只决定路由、不决定放行 / 拒绝；`server` 模式完全忽略该组（配了也无副作用、零开销）。路由判定在 `target` **之后**——被 `target` 拒绝的请求轮不到路由，**路由名单绝不豁免 `target` 拒绝**。

**⑨ 内网目标直连（`10.0.0.0/8` 等不交上游）**

```json
{
  "clientIp": { "whitelist": [], "blacklist": [] },
  "target": { "whitelist": [], "blacklist": [] },
  "upstream": { "whitelist": [], "blacklist": ["10.0.0.0/8", "192.168.0.0/16", "*.internal.example.com"] }
}
```

效果：命中黑名单的内网 IP / 域名由代理**直连**（不经过上游），其余目标走上游；`[route]` 日志可见 `route=direct reason=blacklist`（`jq 'select(.msg=="[route]")'`）。

**⑩ 白名单圈定向上游（圈外直连）**

```json
{
  "clientIp": { "whitelist": [], "blacklist": [] },
  "target": { "whitelist": [], "blacklist": [] },
  "upstream": { "whitelist": ["*.example.com"], "blacklist": [] }
}
```

效果：只有「走上游资格圈」内的 `*.example.com` 交给上游，圈外目标一律直连；`[route]` 日志可见圈内 `route=upstream`、圈外 `route=direct reason=whitelist`。

**⑪ 黑名单点名直连（其余走上游）**

```json
{
  "clientIp": { "whitelist": [], "blacklist": [] },
  "target": { "whitelist": [], "blacklist": [] },
  "upstream": { "whitelist": [], "blacklist": ["secret.example.com"] }
}
```

效果：`secret.example.com` 被点名直连（不交上游），其余目标全部走上游；`[route]` 日志可见 `route=direct reason=blacklist`。

**⑫ 黑白都配：白圈资格 + 黑一票否决**

```json
{
  "clientIp": { "whitelist": [], "blacklist": [] },
  "target": { "whitelist": [], "blacklist": [] },
  "upstream": { "whitelist": ["*.example.com"], "blacklist": ["secret.example.com"] }
}
```

效果：圈内 `*.example.com` 走上游，但 `secret.example.com` 被黑名单一票否决 → 直连（**黑 > 白**），圈外目标直连；`[route]` 日志分别可见 `route=upstream`、`route=direct reason=blacklist`、`route=direct reason=whitelist`。

#### 语法约束（写错 → 启动中止）

以下都是**非法配置**，启动时直接报错退出（fail-closed），不会带病运行：

```json
{
  "clientIp": { "blacklist": ["openrouter.ai"] },
  "target": { "blacklist": ["192.168.*.*", "example.com:8080"] }
}
```

| 错误写法 | 为什么不行 |
|---------|-----------|
| `clientIp` 写域名 | 对端永远是 IP，域名属非法条目 → 中止 |
| `192.168.*.*` | IP 不支持 `*` 通配 → 用 CIDR（`192.168.0.0/16`） |
| `example.com:8080` | 条目不支持端口 → 只写主机名 |
| 中文域名原文 | IDN 须写 punycode（`xn--...`） |

`upstream` 组条目语法与 `target` 完全一致（IP / CIDR / 域名 / `*.通配域名`，不支持端口、IDN 须写 punycode、IP 无 `*` 通配一律用 CIDR）——上表规则对其同样适用。

> 运行期改坏 `cfg/acl.json` 不会中止服务：保留上一份有效配置 + 告警；最多 1 秒后按新（有效）内容生效。

## 常用命令

```bash
# 基本启动
node app.js --port 3000

# SOCKS5 代理
node app.js --proxy-protocol socks5

# HTTPS 代理（需要 TLS 证书）
node app.js --proxy-protocol https

# 客户端模式（转发到上游）
node app.js --proxy-mode client --upstream-url http://up:8080

# 通过环境变量启动
PORT=8080 PROXY_PROTOCOL=socks5 node app.js

# 后台运行（Linux/macOS）
nohup node app.js --port 3000 > /dev/null 2>&1 &
```

## Node.js 压缩包

| 版本 | 适用 Node | 特点 |
|------|----------|------|
| node22 | Node 22.6+ | 与 package.json 的 engines 字段一致 |

## 注意事项

- `cfg/users.json` 和 `cfg/acl.json` 已预置空配置，首次可直接运行
- 如需鉴权，编辑 `cfg/users.json` 添加账号后重启
- TLS 证书在 `keys/` 目录，生产环境请替换为正式证书
- 修改 `cfg/users.json` 或 `cfg/acl.json` 后无需重启，最多 1 秒自动生效
- 日志默认只输出 error 级别到控制台，配置 `LOG_FILE` 可开启 JSONL 落盘
