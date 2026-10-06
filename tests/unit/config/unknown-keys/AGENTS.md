# tests/unit/config/unknown-keys/ — 未知配置键闸门的判据

本目录只答一件事：**拼错的键还有没有机会静默生效**。

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
