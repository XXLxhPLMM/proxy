# tests/unit/config/loader/ — `config/load` + `config/sources` 的判据

本目录只答一件事：外部输入（argv / env 文件 / 显式 env）**怎么变成配置**，以及**哪些环节不许
静默**。机制与层不变量归 `src/config/` 自己的 `AGENTS.md`。

⚠️ 本目录**没有**「`loadConfig` 是唯一入口」这句话的牙齿——那一条由
**「本目录没有一条用例绕开 `loadConfig` 直调 `parseRawArgv`」**这条纪律本身承担：
绕开加载器就等于给 argv 归一留了第二个真相源。

## 文件

- `sources.test.ts` — `config/sources` 的采集 + `config/schema` 的字段解析原语（10 `it`）：
  argv 三种写法、`KEY=VALUE` 含 `=`、非法/越界不静默回退、账号与名单路径字段、`UPSTREAM_URL`
  拆项与非法 URL、`assertAuthConfig` fail-closed 与驱动相关的报错文案、env 文件合并与默认文件名。
- `load.test.ts` — `config/load loadConfig` 本身（9 `it`）：原子装填与 `context` 的面、优先级链
  （CLI > 显式 env > env 文件 > defaults）、省略来源时**不读宿主**、成功与失败都不写 `process.env`。
- `runtime-config.test.ts` — `prepareRuntimeConfigStore`（3 `it`）：热改那一半的路径归一、URL 拆项
  与被覆盖键的 warning、`UPSTREAM_URL` 的**空串是合法值**。
- `import-boundary.test.ts` — import 零副作用护栏（1 `it`）：先放非法宿主 env 再动态 import，
  loader 若在 import 期初始化或偷读宿主环境，用例直接失败。
- `_config-loader.ts` — 三档真用到的入参（`withTmpConfigDir`）。**不带 `.test.ts` 后缀**，
  所以 vitest 收不到它，不会变成一份空跑的空档。

## 锁什么（十一条，逐条都配了锁点）

① **env 文件候选是固定三档**，不是「按 `NODE_ENV` 拼一个文件名」。`defaultEnvFileNames`
**只产名字**（去重保留最后一次），**不扫描目录、不读文件** —— 调用方（CLI）才决定读哪些。
锁点：`expect(defaultEnvFileNames("test")).toEqual([".env.production", ".env.development", ".env.test"])`
（`sources`）。改成「只拼一个」或少一档当场红。

② **`readEnvFiles` 里显式 `baseEnv` 的键恒优先于文件值**。显式 env 是调用方的**本次意图**，
文件是落盘残留；反过来会让「我明明传了 `env` 却读到了旧文件里的值」无法排查。锁点：
`expect(result.merged.PORT).toBe("18000")` + `expect([...result.fileOrigins]).toEqual([["LOG_LEVEL", first]])`
—— 显式 env 已有的 `PORT` 不归任何文件（`sources`）。

③ **相对 env 文件路径相对最终 `configDir`** 解析，绝对路径原样（`load`）。同一个 `envFiles`
列表在不同 cwd 下必须得到同一份配置。锁点：`expect(context.sources.envFiles).toEqual([first, second, absolute])`。

④ **`parseRawArgv` 归一 `--key value` / `--key=value` / `KEY=VALUE` 三种写法**（`sources`）。
`KEY=VALUE` 在**第一个 `=`** 切分。锁点：`loadArgv(["--port", "8080"])` 与
`loadArgv(["JWT_SECRET=Zm9v=="])`。

⑤ **`readEnvFiles` 缺失跳过、其它错误抛出**。缺失是合法的「没配」；读取/解析错误若吞掉，
配错的部署会带着半份 env 静默起来。锁点互为正反面：`expect(result).toEqual({})`（`sources`）
与「非法 env 文件读取错误 reject，且不触碰 store」（`load`，`envFiles` 指向一个目录）。

⑥ **`UPSTREAM_URL` 禁掉 path / query / hash 与越界端口**，非法即阻止启动（`sources` +
`runtime-config`）。拆项只有 host/port/protocol/secure/username/password **六项**，静默丢掉 path
就是「配了但没生效」。空串 = 未配置（**合法**）。锁点：`parseUpstreamUrl("http://h/path")` 是 `undefined`。

⑦ **`resolveFieldEntries` 把「未提供」与「解析失败」分成两路**（`{ resolved, bad }`，`sources`）。
解析失败即当未提供会让一条写错的 `PORT` 静默回落到 `defaults`。锁点：
`await expect(loadArgv(["--port", "not-a-number"], cwd)).rejects.toThrow(/配置校验失败/)`。

⑧ **`assertAuthConfig` fail-closed**（`sources`）。无账号的鉴权服务起起来就是一个永远 407 的进程。
锁点：`assertAuthConfig({ authEnabled: true, authType: "basic", accountCount: 0 })` 抛 `/账号表为空/`。
同档还有**报错文案点名实际生效的那个键**（sqlite 档点名 `AUTH_USERS_DB`）：把运维指到无关文件
比不报错更坏，故两条负向断言必须**各写一条**。

⑨ **`ConfigSourceMetadata` 只含 `envKeys` / `argvKeys` / 已绝对化的 `envFiles`**（`load`）。
否掉的是「把来源值带进诊断信息」——那会让密码 / JWT secret 被诊断来源复制一份。锁点用
`toEqual`（**逐键**比较），任何多出来的键当场红。

⑩ **`applyUpstreamUrlToConfig` 返回 warning 列表**而不是自己记日志（`load` +
`runtime-config`）。配置层零日志（core 零日志禁区同源纪律）。锁点：
`expect(context.warnings).toHaveLength(1)` 且两条 `toMatch(/UPSTREAM_URL/)` / `/UPSTREAM_HOST/`。

⑪ **先 parse 再触碰 target**，非法 URL 抛错且**不部分改写**（`runtime-config`）。半份拆项写进去
之后错误消失、配置看起来合法却指向错误的上游；宁可整个失败。锁点：
`expect(store.get("upstreamHost")).toBe("keep.example")`。

## 防假绿的位置

- **⑦ 的判据钉在 `rejects` 而不是返回值**：把「解析失败」改成「回落缺省」时这一行当场红，
  而 ① 与 ⑥ 那些正向格全绿。
- **⑧ 的两条负向断言必须成对**：`expect(sqlite).not.toMatch(/AUTH_USERS_FILE/)` 与
  `expect(json).not.toMatch(/AUTH_USERS_DB/)` 少一条就退化成单向检查（只查 sqlite 档或只查 json 档）。
  ⚠️ 这两条锚的是**今天仍然存在**的两个 env 名，不是已删符号 —— 换成已删符号会恒绿。
- **⑥ 的「空串合法」三格必须齐**（空串合法 / 空串与不写等价 / 真非法值仍拒）：只留第一格的话，
  「为了放过空串把整个校验放松」没人拦；第三格防的正是那个。
- **`runtime-config` 的空串那一条必须走 `loadConfig` + argv**：拿
  `new ConfigStore({ upstreamUrl: "" })` 去比会在**实现其实分叉着**的情况下照样绿（那个构造经
  `inferExplicitlyProvided` 把「显式给了空串」判成「没提供」）。argv 里那个 `UPSTREAM_URL=`
  才是模板复制到 `.env` / 命令行之后的真实形状。
- **`load` 的「省略来源」那一条要同时污染 `process.env` 与 `process.argv`**：只污染一个就漏掉
  「loader 偷读宿主来源」这一半。`finally` 里的 `restoreEnv` 是必要的 ——
  少了它后面几档会带着脏 env 跑。

## 相关路径

- `src/config/load.ts` — 唯一入口（「不从宿主进程猜测」是它的入参契约）。
- `src/config/sources/{index,env-files}.ts` — argv / env 文件采集。
- `src/config/schema/{index,upstream-url}.ts` — 字段解析原语与 URL 拆项。
- `src/config/normalize/` — `prepareRuntimeConfigStore`（热改那一半）。
- `../store/load-library.test.ts` — 同一个 `loadConfig` 的**库模式**（调用方自带 store）。
- `../unknown-keys/` — 未知键闸门（`loadConfig` 的另一半失败面）。
- `../../../helpers/source-scan.ts` — `REPO_ROOT` 等路径常量（**不许自己数 `..`**）。