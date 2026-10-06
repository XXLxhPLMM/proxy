# src/commands/ — 命令层（表 + 分词 + 补全 + 面板）

**零终端、零 React、零 HTTP、零 `fs`** —— 于是它能在一台没有终端的机器上被逐字断言。对外唯一出口
`@/commands/index.js`。

| 文件 | 答什么 |
|---|---|
| `specs.ts` | 那张唯一的命令表（`COMMAND_SPECS`）、形参声明（`arg` / `opt`）、用法串、名字查表 |
| `values.ts` | 形参的**值语法**：流量单位、控制面名单、各 reader |
| `parse.ts` | 分词（`tokenize`）、命令名解析与元数检查、`parseLine` |
| `suggest.ts` | 拼错时的建议（编辑距离 + 公共前缀） |
| `complete.ts` | Tab 补全**形参的值** |
| `palette.ts` | 命令面板 —— 只管**命令名**，外加 `Enter` 那一档的结论（`enterOutcomeOf`） |
| `index.ts` | barrel，只转发 |

## 相关

`@/lib/exec/run.js`（唯一上游） · `@/lib/index.js`（`normalizeBaseUrl` 是基址形状的唯一判据，`values.ts` 引它不重打）
`tests/parse/` · `tests/palette/`（`Enter` 那一档的真值表在 `tests/palette/enter.test.ts`） · `tests/complete/`