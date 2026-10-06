# src/lib/ — 零 IO 的那一半（纯函数层）

本目录回答「一个值怎么变成屏上/请求里的一句话或一个坐标」：**排版**（`format` / `columns`）、**屏幕几何**
（`geometry`）、**输入编辑的纯算术**（`editor`：选区 / 换行 / 按显示列上下移 / 命令历史）、**行模型**（`log/`）、
**输入串与插入符**（`input-line`）、**失败词汇与地址变换**（`errors` / `http`）、
**失败 → 一行字**（`failures`）、**一条命令 → 若干行 + 副作用**（`exec/`）、**对话那一圈**（`agent.ts`）。
对外唯一出口 `@/lib/index.js`。

⚠️ `exec/` 与 `agent.ts` 有意**不在** `@/lib/index.js` 里转发：前者依赖 `@/api`，而本目录其余部分不认识契约的
字段语义；后者要引 `exec/` 与 `@/services/model/`，转发进来就是运行期环。调用方分别直接引
`@/lib/exec/index.js` 与 `@/lib/agent.js`（成环理由与逐条清单见 `src/AGENTS.md` 那张表）。

## 相关

`@/api/index.js`（上游，契约）· `@/services/index.js`（下游，唯一拨号点）· `@/store/index.js`（跨帧状态的形状，
⚠️ **只取那两个纯常量** `INPUT_HISTORY` / `LOG_KEEP` 一类的数 —— 本目录其余文件不认识会话）
· `@/theme/index.js`（色档，本目录只读 `Tone` 做数据标注）
`tests/format/`（数量那一族）· `tests/columns/`（量宽度 / 砍宽度）· `tests/geometry/`（屏幕几何）·
`tests/editor/`（输入编辑的纯算术：选区 / 换行 / 上下移 / 历史）· `tests/log/`（行模型与对话模型）·
`tests/agent/`（对话那一圈 + `/batch` 扇出）· `tests/wire/`（逐字段判据，判据面在 `@/api` 那侧）