# src/lib/ — 零 IO 的那一半（纯函数层）

本目录回答「一个值怎么变成屏上/请求里的一句话或一个坐标」：**排版**（`format` / `columns`）、**屏幕几何**
（`geometry`）、**行模型**（`log/`）、**输入串与插入符**（`input-line`）、**失败词汇与收窄组合子**
（`errors` / `decode` / `http`）、**失败 → 一行字**（`failures`）、**一条命令 → 若干行 + 副作用**
（`exec/`）。对外唯一出口 `@/lib/index.js`。

⚠️ `exec/` 有意**不在** `@/lib/index.js` 里转发：它依赖 `@/api`，而本目录其余部分不认识契约的字段语义。
调用方直接引 `@/lib/exec/index.js`。

## 层不变量

- ⚠️ **本目录零 IO、零 `process.*`、零 React、零 Ink**（`geometry.ts` 只读注入进来的宽高）：没有一处能触网、
  读时钟或读环境 —— 这是这些判据能被逐字断言的前提。
- ⚠️ **绘制与命中测试读同一个 `geometry()` 结果**：组件一行坐标都不许自己从 props 算，
  `Geometry.inputTextRows` 是唯一那份「字画在哪」的数组。⚠️ 矩形一律**半开区间** `[x, x+w)` × `[y, y+h)`，
  真重叠时**后来者赢**；非整数坐标 `hitTest` 返回 `-1`。
- ⚠️ **几何层只夹不推**：`sessionsTop` 越界由它夹一次，而「当前会话必须留在可见窗口里」是**状态层**的活
  （`@/AppState.js:revealSession`）—— 一并接管的话，滚轮翻看别的会话会在下一帧被拽回来。
- ⚠️ **下标一律是 UTF-16 code unit**：`input-line.ts` / `geometry.ts:caretFromWrappedPoint` /
  `@/commands/complete.js` / `CaretRow` 四处必须逐字一致，否则插入符偏一个字。
- ⚠️ **换算只许在这里做**（字节 → 人话、时间 → 相对、token → 掩码），组件只把它们摆出去，否则同一个值在两处
  被换算成两个样子。⚠️ **`truncated` 不许被调用方忽略**：`fitTo` 先判「裁不裁得下」再裁并如实带出那个标志。
- **列宽从右往左让**（右列先缩）；⚠️ **宁丢列不丢字**；声明了固定宽度的列**是一个承诺**，不许被悄悄改窄。
- ⚠️ **`flatten()` 不许跨宽度缓存**；**滚动位置恒以「行」为单位**且被 `clampTop` 夹住，改了视口高度要在
  **读的那一侧**再夹一次。⚠️ **`maskEcho` 是唯一的掩码出口**：固定长度、按**凭据类别**而不是真实长度。
- ⚠️ **文案绝不转述对面的数据**（响应的 body、带凭据的地址、任何一段 token），**也绝不重打 userinfo** ——
  只说「哪个路径期望什么」与「地址的哪一段不对」。
- ⚠️ **`TuiError` 三档分开的理由是处置动作不同**：服务端答了「不」⇒ 读文案；**根本没答上** ⇒ 查地址与网络；
  答了但形状不对 ⇒ 多半是对面版本新/旧。本地形状不对挂 `wire` 档 + `invalid` 码（`TuiError.local`），
  ⚠️ 代价是 `status` 恒 `null`（**没收到响应就没有状态码，不许拿 `0` 冒充**）。
- ⚠️ **失败文案绝不引用用户输入**：token 与密码经过 `failures.ts` / `exec/failures.ts` 落进**可滚动的结果区**。
- ⚠️ **收窄组合子（`decode.ts`）的调用点只有 `@/api/wire.js`**，而它走**深层路径** `@/lib/decode.js`：
  走 barrel 就是 `api/index → api/wire → lib/index → lib/failures → services/config → services → api/index`
  那条运行期环。⚠️ `obj` **放行未知键**；`opaque` 只给 `configKey.value` 那一个字段用。

## 相关

`@/api/index.js`（上游，契约）· `@/services/index.js`（下游，唯一拨号点）· `@/theme/index.js`（色档，本目录只读 `Tone` 做数据标注）
`tests/format.test.ts` · `tests/columns.test.ts` · `tests/geometry.test.ts` · `tests/log.test.ts` · `tests/decode.test.ts`