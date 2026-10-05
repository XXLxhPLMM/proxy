# tests/unit/config/unknown-keys/ — 未知配置键闸门的判据

本目录只答一件事：**拼错的键还有没有机会静默生效**。机制与层不变量归 `src/config/` 自己的
`AGENTS.md`。

静默回落不是小毛病：命令行里敲一个已删除的旧键名照样起服务，实际跑的是缺省档，
操作者没有任何信号。

## 文件

- `rejection.test.ts` — **拒绝面**（12 `it`）：argv 与 env 文件里的未知键一律让启动失败，
  且报错逐字点名键与来源。含闸门在唯一一次 merge 之前（失败不留半份配置）。
- `tolerance.test.ts` — **容忍面**（11 `it`）：恰好两个容忍键、`FIELDS` ↔ `.env.example`
  集合相等、合法键一个都不误伤。
- `_config-unknown-keys.ts` — 两档真用到的入参（`withTmpConfigDir` / `loadOptions` / `loadArgv` /
  `rejectionMessage`）。**不带 `.test.ts` 后缀**，所以 vitest 收不到它。

⚠️ **两档必须成对**：`rejection` 单独存在时，把判据改成「拒绝一切键」也能全绿。
`ENV_EXAMPLE` / `EXPLICIT_VALUES` / `legalValueOf` / `loadEnvFile` 只被 `tolerance` 用 ⇒ 留在那一档。

## 锁什么（九条不变量，每条都配了变异锁点）

① **判据是键名在不在 `FIELDS` + 容忍名单里**，与「这个键的值有没有被用上」无关
否掉的是「只对生效的键校验」。落选的键走的是「`resolveFieldEntries` 拿不到值 → 回落
def/defaults」这条现成通路，正是它让拼错无声。锁点：
`const message = await rejectionMessage(loadArgv(["--quota-ledger-driver", "sqlite"], cwd))`
后紧跟 `expect(message).toContain("QUOTA_LEDGER_DRIVER")` —— 错误文本**逐字含那个键名**，
所以「探测器根本没看见这个键」不会伪装成通过。

② **报错必须可操作**：点名键 + 指名来源 + 近邻时给最接近的合法键。否掉的是「未知配置项」这种
没头没尾的文案。锁点：`expect(message).toContain("来源：CLI 参数")` 与
`expect(message).toContain("最接近的合法键是 QUOTA_USAGE_DIR")` —— `QUOTA_USAGE_DI` 少一个字符；
`CACHE_TYPE` 这种离所有合法键都很远的键**不给**建议（给错建议会让运维去改一个本来正确的键）。

③ **env 文件来源要报到具体文件路径**，不是「某个 env 文件」。锁点：
`expect(message).toContain(envFile)`，`envFile` 是临时目录下的绝对路径。两个 env 文件各写一个
不同的坏键时逐个点名；同一个坏键写在两个文件里时点名**后写入**的那个（与合并优先级一致）。

④ **显式 `env` 入参里的未知键不报错**（宿主环境成千上万个无关变量）。否掉的是「对所有键
fail-fast」。锁点：`env: { PORT: "18123", TOTALLY_UNRELATED: "1" }` 加载成功且 `port === 18123`。
这条与 ① 互为正反面：把 ① 的判据改成「查所有键」就红，把 ① 整条删掉也红。

⑤ **容忍名单恰好两个键**（`NODE_ENV` / `NO_COLOR`），且逐个证明它在 argv / env 文件两个来源
都不报错。名单不扩大是纪律不是偏好：多收一个键 = 多放行一类拼错。锁点两重：正向的
「两个键两个来源都加载成功」，加上源码级断言
`expect(keys.sort()).toEqual([...TOLERATED].sort())`（多一个就红）。

⑥ ⚠️ **全部 `FIELDS` 的 env 名在 argv 与 env 文件里都不报错** —— 这是 ① 的反向面。
锁点：`for (const f of FIELDS)` 逐个加载成功。全部键逐个过一遍，任一被误判当场红。

⑦ **失败不留半份配置**（与「所有成功后才一次 merge」同一条不变量）。锁点：预置
`new ConfigStore({ port: 18100 })`，未知键加载失败后 `expect(store.get("port")).toBe(18100)` ——
闸门若落在 merge 之后，已被写进去的字段就留在 store 里了。

⑧ **显式 env 已有的键不归文件**：同名的坏键在 `env` 里就不算文件来源。`readEnvFiles` 的
`explicitKeys` 决定归属：显式 env 压过文件，生效值由 env 给。锁点：`env` 给 `CACHE_TYPE`、
env 文件里也写 `CACHE_TYPE` ⇒ 加载成功。

⑨ **`FIELDS` 与 `.env.example` 集合相等**（两者互为对方的「全量清单」）。少一个键 = 用户永远
发现不了那个选项；多一个键 = 照着改的文件起不来。故钉**集合相等**而不钉「共 N 项」——
N 是会腐烂的数字。

⚠️ **容忍名单与 `FIELDS` 必须零交集**（有专门一档）：`USE_HOME_CONFIG` 虽被 `loadConfig`
早于字段解析地单独读取，但它是 `FIELDS` 字段，键名早已合法。把它收进名单看起来是「多一份保险」，
实际是**把一次字段删除掩盖成「这键本来就合法」** —— 闸门再也报不出那个拼错了。

## 防假绿的位置

- **⑤ 的源码级断言必须锚在「今天仍存在的读取点」上**
  （`env-files.ts` 的 `nodeEnv` 形参、`cli.ts` 的 `env.NO_COLOR`），**不是锚一个已删符号** ——
  锚已删符号的负向断言恒真：那个符号被重新引入时它也不会红。
- **② 的「不给建议」那条必须同时断言点名了键**（`toContain("CACHE_TYPE")`）：只断言
  `not.toContain("最接近的合法键")` 的话，「探测器什么都没看见」也能过。
- **⑦ 的两条（argv 侧与 env 文件侧）都要有**：闸门在两条路径上的位置不同，只写一条就漏一半。
- **⑥ 依赖 `legalValueOf` 从字段自己的契约取合法值**（`def(configDir)` / `defaults`），
  不另写一张值表 —— 那张表本身会与 `FIELDS` 漂移，于是「键被接受」这件事悄悄少测几个字段。
- **⑨ 的「零重复键」与「文案里不再写共 N 项」两条**：前者防「同一个键写两遍 = 后一行静默覆盖
  前一行，模板读者看不出谁赢」，后者防计数文案重新长出来（锚在**今天仍存在的形状**上：全仓任何
  地方都不该再出现 `共 N 项`）。

## 相关路径

- `src/config/load.ts` — `NON_CONFIG_ENV_KEYS`（容忍名单的**唯一**真相源）与闸门落点。
- `src/config/sources/env-files.ts` / `src/config/schema/index.ts` — `FIELDS`（合法键名空间的真相源）。
- `../../../../.env.example`（仓根）— 用户看得见的那份清单，路径从 `../../../helpers/source-scan.js`
  的 `REPO_ROOT` 派生（**不许自己数 `..`**：多一个会枚举到别的文件集）。
- `../loader/` — `loadConfig` 的成功面（本目录是它的失败面）。
- `../quota-fields.test.ts` — `CONFIG_ENV_KEYS` 与 `FIELDS` 同步那道牙在那边（`tests/setup-env.ts` 侧）。