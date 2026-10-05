# `@b-hole/proxy-mcp`

MCP（Model Context Protocol）服务器，用 **stdio** 把 `@b-hole/proxy` 的控制面交给模型驱动。

⚠️ **它驱动的是别的机器上的那个控制面**，而控制面能读全量配置、增删账号与访问名单 ——
等价于那些机器上的 root shell。故「能动哪几台」不是一个可以随便猜的默认值（见下面「环境」一节）。

## 装与跑

```bash
pnpm install          # ⚠️ 本包**不在** pnpm workspace 里，用 --ignore-workspace 装
pnpm build            # tsc → dist/（产物是 ESM）
node dist/cli.js      # 走 stdio，别直接看终端输出
```

MCP 客户端配置（stdio 型）：

```json
{
  "mcpServers": {
    "swain-proxy": {
      "command": "node",
      "args": ["/绝对路径/packages/mcp/dist/cli.js"]
    }
  }
}
```

⚠️ 对面要先开着控制面：`MANAGER_ENABLED=true MANAGER_PORT=<port> MANAGER_TOKEN=<token>`，
并且那个进程的 `MANAGER_TOKEN` 就是这里的 `key`。

## 两个文件

都在 `~/.swain-proxy/` 下（⚠️ 固定位置，**不读**任何环境变量）：

| 文件 | 内容 |
|---|---|
| `managers.json` | `{ "managers": [ { "id", "name", "baseUrl", "key", "timeoutMs" } ] }` |
| `envs.json` | `{ "environments": [ { "name", "managers": [<id>…] } ] }` |

⚠️ **`key` 明文存在 `managers.json` 里**：没有可加密它的密钥，OS keychain 要原生依赖。
防线是**目录 `0700` + 文件 `0600` + 位置约定**，加上 `manager_list` / `manager_add` 的返回值里
**永远是掩码 `***`** —— 本工具面任何地方都拿不到 key 的明文。

⚠️ **内容坏了就是拒，不是当成空台账**。降级成空台账是最坏的一种「体贴」：重新登记一遍就会
拿那份空台账覆盖掉存着 key 的那一份，而凭据蒸发没有任何症状。

## 环境：决定「默认动哪几台」

**「显式指定」是替换，「不给」是走环境。** 十二个操作类工具每一个都有一个可选的 `managers` 形参：

| 情况 | 动哪几台 |
|---|---|
| 给了 `managers: ["a", "b"]` | **只**动这两台 —— 不与当前环境合并 |
| 没给，且有激活的环境 | 只动那个环境里的那些 |
| 没给，且**没有**激活 | ⚠️ **报错给模型**（不静默变成「动全部」） |

显式指定是**替换**而不是叠加，因为并集会让「我只动这两台」变成「我动这两台**加上**当前环境里的
全部」—— 而那是一次**写**操作打在计划外的机器上。

⚠️ **激活只活在当前进程内存里，重启后归零。** 这是有意的：一个驱动别人机器的工具不该继承
「上次打过哪儿」。每个新会话都要重新 `env_activate`。

## 工具（22 个）

**台账（10 个，一个请求都不发）**

`manager_list` · `manager_add` · `manager_update` · `manager_remove` ·
`env_list` · `env_create` · `env_update` · `env_remove` · `env_activate` · `env_deactivate`

**操作（12 个，每个都带可选 `managers`）**

| 工具 | 端点 |
|---|---|
| `status` | `GET /api/status` |
| `config` | `GET /api/config`（⚠️ **只有读**，服务端没有写端点） |
| `account_list` / `account_get` | `GET /api/users` / `GET /api/users/:username` |
| `account_create` / `account_update` / `account_delete` | `POST` / `PUT` / `DELETE /api/users` |
| `acl_get` / `acl_add` / `acl_remove` | `GET` / `POST` / `DELETE /api/acl` |
| `usage_list` / `usage_get` | `GET /api/usage` / `GET /api/usage/:username` |

⚠️ **改了 startup 相位的配置不会生效** —— 控制面与数据面在同一进程里，而进程归宿主所有。
「哪些键属于这一类」由 `config` 的 `restartRequired` 逐键给出。

⚠️ `usage_*` 回的是**账本此刻记着的数**，运行中的代理读自己的进程内镜像，最多落后一个落盘周期；
且**不能清账**（从第二个进程删账本里的行对运行中的代理无效）。

## 几个不容许被猜反的语义

- **多台是一台一个结果的聚合体**：串行跑，一台失败**不停**整批（3 台成功 2 台失败是一个成功的结果，
  模型要看到哪两台没成以及为什么），失败排在前面，逐台点名名字与 id。
- **`changed: false` 是成功的 no-op**，不是错误 —— 名单的写是幂等的。
- **「没给字段」与「清空」是两种操作**：账号写面上没给的字段保持原样，`clear` / 空数组才是清空。
- **没激活时报错，文案带出路**（`env_activate` 或 `managers` 参数），因为模型只会重试同一个调用。

## 验

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

⚠️ `tests/tools/wiring.test.ts` 起真进程跑真 stdio，故它依赖 `dist/`；没构建过就**整档跳过**。
