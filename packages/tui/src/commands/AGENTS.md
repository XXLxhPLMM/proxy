# src/commands/ — 命令层（表 + 分词 + 补全 + 面板）

**零终端、零 React、零 HTTP、零 `fs`** —— 于是它能在一台没有终端的机器上被逐字断言。对外唯一出口
`@/commands/index.js`。

| 文件 | 答什么 |
|---|---|
| `specs.ts` | 那张唯一的命令表（`COMMAND_SPECS`）、形参声明（`arg` / `opt`）、用法串、名字查表 |
| `values.ts` | 形参的**值语法**：各 reader、域常量与 `USER_FIELDS` |
| `parse.ts` | 分词（`tokenize`）、命令名解析与元数检查、`parseLine` |
| `suggest.ts` | 拼错时的建议（编辑距离 + 公共前缀） |
| `complete.ts` | Tab 补全**形参的值** |
| `palette.ts` | 命令面板 —— 只管**命令名** |
| `index.ts` | barrel，只转发 |

## 层不变量

- ⚠️ **每行命令都以 `/` 开头**（`COMMAND_PREFIX`），给人看的命令名只有 `CommandSpec.path` 一个出口 —— ⚠️ **不许「宽容地」接受不带前缀的写法**，否则这条形状不变量一句牙齿都没有；牙齿在 `tests/parse/command-table.test.ts` 末尾那组断言。⚠️ 而**输入行上不以 `/` 开头的那一行**不是解析失败 —— 它是**一句普通聊天消息**（走模型，`packages/tui/AGENTS.md`「模型」一节），判据是那**一个字符**。
- ⚠️ **`ArgSpec.rest` 那一格吃下**剩下的原文**（今天只有 `/batch <控制面> <命令>`）：分词再拼回去会毁掉引号
  （`/user pass bob "a b"` 变成三个词，而内层命令的形参于是错位）。⚠️ 「多给了几个参数」那道个数判据
  **必须**在 `rest` 之前分岔，否则 `/batch all /user pass bob "a b"` 会被判成「多给了 3 个参数」。
- ⚠️ **`/batch` 的 `build` 交出 `BatchDraft` 而 `parseLine` 递归解析内层那一条**（`resolveDraft`）：
  解析层是**唯一**认识 `parseLine` 的地方，而这张表是它的**下游** —— 两处各解一次就多了一条判据会漂的缝。
- ⚠️ **失败文案绝不引用用户输入**：`ValueError` 只说「哪个形参期望什么形状」，因为它会落进**可滚动的结果区**，而 token 与密码经过这里。
- ⚠️ **「命令名那一段」必须跨空白**（`palette.ts:commandPathOf`）：`/user add ` 的命令名是 `user add`，判据是「表里有没有一条命令名以这一段开头」。
- **面板开不开只看「输入行里有没有 `/`」**（`palette.ts:paletteOpen`），高亮是**输入行的纯函数**，`↑`/`↓` 走完之后把那一行**写进输入行** —— 于是「输入行上敲的是 A、面板高亮的是 B」在类型上不可能。
- ⚠️ **补全只重写光标所在的那一个词**，光标之后的字节逐字不变（`complete.ts`），候选只来自命令表声明的 `choices` —— **不许读台账**。

## 相关

`@/lib/exec/run.js`（唯一上游） · `@/lib/index.js`（`normalizeBaseUrl` 是基址形状的唯一判据，`values.ts` 引它不重打）
`tests/parse/` · `tests/palette/` · `tests/complete/`
