# @b-hole/proxy

多协议正向代理服务，支持 HTTP/HTTPS/SOCKS 双端异构串联、cluster 多进程与四种鉴权方式。

- 服务端：可监听 `http` / `https` / `socks4` / `socks5` / `sockss4` / `sockss5`
- 客户端：可把流量再转发给上述任一协议的上游代理，下游协议与上游协议相互独立
- 配置：单一表驱动（`src/config/loader.ts:FIELDS`），CLI / 终端环境变量 / `.env.*` / 默认值四级覆盖

## 环境要求

- Node `>= 22.6`（开发用 `pnpm@11.24`，`pnpm-lock.yaml` 为唯一锁文件）

## 快速开始

```bash
pnpm install
pnpm build          # esbuild -> dist/app.js
pnpm start          # node dist/app.js
```

换端口 / 换协议：

```bash
pnpm start -- --port 8080
pnpm start -- --proxy-protocol socks5
pnpm start:socks     # 等价于 PROXY_PROTOCOL=socks5
```

开发期：

```bash
cp cfg/users.json.example cfg/users.json   # 必须先做：.env.development 开了 uid 鉴权，账号表为空会启动 abort
pnpm dev             # build:dev + start:dev（读 .env.development）
pnpm dev:hot         # build:watch + dev-server 自动重启
```

> `cfg/users.json` / `cfg/acl.json` 含密码与名单，已在 `.gitignore` 中忽略，仓库只提交 `cfg/*.example`。

## 配置

### 优先级

```
CLI 参数  >  终端环境变量  >  .env 文件  >  默认值
```

`.env` 文件按 **低 → 高** 依次加载，后者覆盖前者：

1. `.env.production`
2. `.env.development`
3. `.env.<NODE_ENV>`（`NODE_ENV` 未设时缺省为 `.env.development`）

**终端已存在的变量不会被文件覆盖**，因此 `PORT=9000 pnpm start` 一定生效。

配置文件里**没有**裸 `.env` —— 请勿创建，它不会被读取。

### 生效时机

每个字段在字段表里声明了 `phase`，决定改动是否需要重启：

| phase     | 含义                         | 字段                                                                   |
| --------- | ---------------------------- | ---------------------------------------------------------------------- |
| `startup` | 启动时一次性读取，改动需重启 | `host` `port` `proxyProtocol` `tls*` `clusterWorkers`                  |
| `runtime` | 每次请求/每次日志重新读取    | 其余全部（鉴权、日志等级、上游拆项、`proxyMode`、`upstreamTimeout` …） |

启动日志会打印 `startup` 字段清单；库调用方可用 `keysByPhase()` 取到分组结果。

### 字段名

**一个字段只有一个环境变量名，没有别名。** 完整清单见 `.env.example`，它就是权威列表；已废弃的历史名称（`REMOTE_*`、`LOGLEVEL`、`PROXY_TYPE`、`MODE` …）不再被识别。

### 非法值

显式给出的值解析失败（CLI 或环境变量都一样）会**直接阻止启动**并报出字段名，不会静默回退到默认值。布尔拼写错误同样报错 —— `AUTH_ENABLED=treu` 不会悄悄变成 `false`。

整数范围在字段表内声明并在启动时校验（`PORT` / `UPSTREAM_PORT` 1-65535，`UPSTREAM_TIMEOUT` ≥1，`CLUSTER_WORKERS` 0-1024）。

### 上游标准 URL

`UPSTREAM_URL=scheme://[user:pass@]host[:port]` 可一次性替代上游拆项配置：

```bash
UPSTREAM_URL=https://user:pass@proxy.example.com:8443
```

- `scheme` ∈ `http` / `https` / `socks4` / `socks5` / `sockss4` / `sockss5`
- 缺省端口按 scheme 补齐（`http:80`、`https,sockss4,sockss5:443`、`socks4,socks5:1080`）
- 配置后覆盖 `UPSTREAM_PROTOCOL` / `UPSTREAM_SECURE` / `UPSTREAM_HOST` / `UPSTREAM_PORT` / `UPSTREAM_USERNAME` / `UPSTREAM_PASSWORD`；`UPSTREAM_CA` 与 `UPSTREAM_INSECURE` 仍独立生效
- 拒绝携带 path / query / hash

### 用户级配置

`USE_HOME_CONFIG=true` 时从 `~/.proxy/` 读取 `.env`、`keys/`、`log/`，否则使用当前工作目录。

## 鉴权

`AUTH_ENABLED=true` 后按 `AUTH_TYPE` 生效，对六种协议统一生效。账号来自 `AUTH_USERS_FILE`（`cfg/users.json`，默认 `<配置目录>/cfg/users.json`），**多账号即多项**：

```json
[
  { "username": "admin", "password": "secret" },
  { "username": "guest", "password": "guest123" }
]
```

| 类型    | 校验方式                                                      |
| ------- | ------------------------------------------------------------- |
| `none`  | 放行                                                          |
| `basic` | 命中账号表中**任一**账号的用户名 + 密码                       |
| `jwt`   | 校验 Bearer token（需 `JWT_SECRET`，为空时全部拒绝）          |
| `uid`   | 命中账号表中**任一**用户名（socks4 由 USERID 承载，密码可留空）|

`username` 非空且不含 `:`；`password` 明文、允许空串（`uid` 只用用户名）；不允许未知字段与重名。文件缺失 = 无账号；**开启 `basic`/`uid` 却账号表为空会在启动时直接 abort（fail-closed）**，所以按 `.env.development` 开发前务必先 `cp cfg/users.json.example cfg/users.json`。

凭证来源随协议而异：HTTP/HTTPS 取 `Proxy-Authorization`，缺失时回退 `Authorization`（RFC 7235）；socks4 取 USERID；socks5 取 USER_PASS 协商。审计日志由 `AUTH_LOGGING` 控制；鉴权通过的日志行会带命中账号的 `user` 字段。

## 访问控制

`ACL_FILE`（`cfg/acl.json`，默认 `<配置目录>/cfg/acl.json`）配置两组黑白名单：

```json
{
  "clientIp": { "whitelist": ["127.0.0.1", "10.0.0.0/8"], "blacklist": ["203.0.113.7"] },
  "target":   { "whitelist": ["*.example.com"], "blacklist": ["ads.example.net", "198.51.100.0/24"] }
}
```

| 组         | 条目类型                    | 判定对象                                      |
| ---------- | --------------------------- | --------------------------------------------- |
| `clientIp` | IP / CIDR                   | **TCP 对端地址**（刻意不看 `X-Forwarded-For`）|
| `target`   | IP / CIDR / 域名 / `*.域名` | 客户端请求的 **host 字符串**（不做 DNS 解析） |

- 语义两组一致：**黑名单命中 → 拒绝（优先）；白名单非空且未命中 → 拒绝；皆空 → 放行**。
- 条目示例各一：`127.0.0.1`（IP）、`10.0.0.0/8`（CIDR）、`example.com`（域名）、`*.example.com`（通配域名，只匹配子域、不含 `example.com` 本身）、`2001:db8::/32`（IPv6）。条目不支持端口。
- 已知边界：域名条目按请求 host 字符串匹配、不做 DNS 解析，拦不住「客户端直写 IP」；要两头都堵就两类条目都写。
- 被拒：HTTP/CONNECT/upgrade 回 **403**；SOCKS 握手前直接断开。两组均可缺省；未知键/非法条目 → 启动 abort；文件缺失 = 不拦任何请求。
- `cfg/acl.json.example` 默认全部留空数组（复制后不会误拦），需要时把条目填进对应数组。

两个 JSON 文件（`cfg/users.json` / `cfg/acl.json`）均**热加载**：每文件最多 1s 一次的 stat 节流，改动最多 1s 生效、**无需重启**；内容变坏时保留上一份有效配置并告警。

## 日志

控制台是人读文本，落盘是 **JSONL**：`LOG_FILE` 按小时切分 `log/YYYY-MM-DD-HH.jsonl`，每行一个 JSON 对象，可直接 `jq` 查询。

```json
{"ts":"2026-09-20T14:03:11.201Z","level":"info","pid":1234,"prefix":"[proxy]","msg":"[forward]","client":"1.2.3.4","target":"example.com:80","method":"GET","user":"alice"}
```

结构化字段约定：`logger.info("msg", { ...fields })` —— **最后一个参数若是 plain object 即视为字段**，文件里并入记录顶层、控制台渲染成 `k=v`；保留键 `ts/level/pid/prefix/msg` 优先，同名字段被忽略。控制台与落盘等级由 `LOG_LEVEL` / `LOG_FILE_LEVEL` **独立门控**，`LOG_FILE` 为空则不落盘。

```bash
jq -r 'select(.user=="alice") | .msg, .target' log/*.jsonl
jq -r 'select(.msg=="[auth] deny") | .client' log/*.jsonl | sort | uniq -c
jq 'select(.level=="warn")' log/*.jsonl
```

## 多进程

`CLUSTER_WORKERS`：

- `1`：单进程（默认）
- `>1`：master fork 指定数量 worker 共享监听端口，崩溃自动重启
- `0`：按 CPU 核数

## 部署

### Docker

```bash
docker build -t proxy .
docker run --env-file .env.production -p 3000:3000 proxy
```

镜像内不含配置文件，配置全部通过环境变量传入（`--env-file` 或 `-e`）。日志目录 `log/` 与证书目录 `keys/` 建议挂载出来。

### 打包为单文件可执行

```bash
pnpm build:pkg       # pkg -> node22-win / linux / darwin
```

> 构建产物里的 `cfg/` 只含 `*.example` 模板（`pnpm build` 拷到 `dist/cfg/`，`pkg` 打进可执行文件）；真实的 `users.json`/`acl.json` 含密码与名单，不要放进产物。

### 作为库使用

```ts
import { ProxyServer, runServer, get, getAll, set } from "@b-hole/proxy";
```

导入即完成配置初始化；未直接执行时不会启动服务。

## 开发命令

```bash
pnpm typecheck        # tsc --noEmit
pnpm lint             # eslint
pnpm test             # vitest run
pnpm build            # esbuild -> dist/app.js
pnpm build:all        # build + build:lib（tsc 声明文件）
pnpm test:server      # 本地吞吐测试源站（:4000）
pnpm test:pressure    # socks4 压力测试
```

## 更多文档

- `AGENTS.md`：架构、初始化流程、配置优先级、字段表约定与踩坑记录
- `.opencode/skills/`：配置 / 鉴权 / 日志 / 测试的专项说明

## 许可

Apache-2.0
