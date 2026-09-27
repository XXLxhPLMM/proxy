# src/config/sources — 外部输入采集

## 路径说明

| 文件 | 装什么 | 判据 |
|---|---|---|
| `config-dir.ts` | `HOME_CONFIG_KEY` + `getConfigDir(useHome, cwd?)` | 必须在读 env 文件**之前**确定；**只解析路径、绝不创建目录** |
| `env-files.ts` | `defaultEnvFileNames(nodeEnv?)` / `readEnvFiles(files, baseEnv)` | 前者**只产名字**、不扫描不读取；后者按输入顺序读、后覆盖前 |
| `argv.ts` | `parseRawArgv(argv)` | 纯字符串处理，**不读 `process.argv`** |
| `index.ts` | 本层出口 | 跨目录只出 `defaultEnvFileNames` |

## 硬约定

- **全部函数要求显式入参**，没有任何一个去读 `process.env` / `process.argv` / `process.cwd()`。省略即空，绝不猜宿主来源。护栏 `tests/unit/config-loader-import.test.ts`。
- **绝不写宿主环境**（`readEnvFiles` 不碰 `process.env`）。
- **argv 归一只有 `parseRawArgv` 一处实现**，`loadConfig` 是唯一把它变成配置的入口；argv 的回归护栏一律经 `loadConfig` 断言，不要另写一条绕开加载器的测试。
- 本层对目录外只暴露 `defaultEnvFileNames`；`readEnvFiles` / `parseRawArgv` / `getConfigDir` 是 `load.ts` 的编排内部件。

## 决策清单

**每条：结论 — 否掉了什么 — 为什么。推导读代码与 git log，结论不可推导。**

**有断言锁住的裁决一律不写在这里**——它们的结论、否掉了什么、为什么、以及逐字锁点全在
`tests/unit/config-loader.test.ts` 的开头条注释里（那 11 条：env 文件候选三档 / `baseEnv` 优先 /
相对路径锚 `configDir` / argv 三种写法 / 缺失跳过其它抛错 / `UPSTREAM_URL` 禁 path 等 /
`resolveFieldEntries` 两路分 / `assertAuthConfig` fail-closed / 来源元数据只含三个键 /
拆项覆盖只进 warnings / 非法 URL 不半写 target）。要查「那条断言锁什么」，去那个文件。

1. **`getConfigDir` 在 `loadConfig` 里**先于** `readEnvFiles` 求值** — 否掉「读完再定」— 相对 env 文件路径和各 path 字段默认值都以 `configDir` 为锚，顺序反了就会拿旧目录去解析新目录的相对路径。`USE_HOME_CONFIG` 的取值优先级是 argv > 显式 env，home 模式固定 `~/.proxy`。**没有任何断言钉这条顺序**（把两步对调，测试里那批相对 `envFiles` 仍会按最终 `configDir` 解析通过），它靠上面那份「相对路径锚 `configDir`」的断言**间接**兜住结果面。
2. **`sources/` 对外只出 `defaultEnvFileNames`** — 否掉「三个函数都出去」— 另两个只有 `load.ts` 一个调用方，出口膨胀会让「删掉一个内部函数」变成破坏性变更。判据是根 [`../AGENTS.md`](../AGENTS.md) 决策 2。⚠️ **本条也没有断言**：`@/config/index.js` 与包入口的导出面都**没有**被逐项枚举过（`tests/library/entry.test.ts` 只钉「必须出的那批在」，不钉「多出来的没有」），所以「出口膨胀」在本仓是**无牙齿的纪律**，靠 review 守。
