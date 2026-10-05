# tests/format/ — `@/lib/format` 的纯函数断言

这一层回答「一个值怎么变成屏上那一句话」：**人读形态**，零 IO、零渲染。模块自己的三条纪律是
**非法输入抛不装**、**两种事实不许同形**、**显示层不做换算**；五档断言各钉其中一条。分档：
`magnitude.test.ts`（体量与占比）· `duration.test.ts`（时长）· `day-group.test.ts`（**按天数分组**）·
`width.test.ts`（显示宽度下的截断与对齐）· `placeholder.test.ts`（空 / 未知 / 凭据 / 开关的固定形态）。

**锁什么**：人读形态的**边界值**与**它们的理由**。这一层的数字一旦漂了，界面不会崩、不会报错，
只会**说错话**：把 `0` 字节配额显示成 `NaN%`、把没监听的进程显示成「已运行 0 秒」、把 token
的长度印在屏幕上。所以它是本目录最需要被逐字钉住的一块。

## 为什么拆掉哪一处会红

- `bytes` 的 `RangeError` → 有人改成原样回显坏数据，「非法输入必须炸」这条不变量就没牙齿了。
- `percent(_, 0)` → 有人把 `0` 当分母算，**唯一确定的事实**（不限流）在界面上变成 `NaN`。
- `maskToken` 那条「两个不同长度的 token 渲染结果逐字相同」 → 有人改成按长度打码，
  长度就重新变成一个可二分的信号（与 `src/manager/http/auth.ts` 同源纪律）。
- `ellipsis` 的中文 / emoji 用例 → 有人把 `widthOf` 换成 `String.length`，表格在真终端里歪掉，
  而**任何单测都还在绿**（ASCII 用例对两种度量都成立）。
- ⚠️ `dayGroupLabel` 那几条**只有喂了构造出来的日历日才承重**：拿 `Date.now()` 减 `N × 86400000`
  当样本时，2 月与夏令时那几档会整组差一天（实测把实现换成 24 小时算，「只差一个钟点而跨了
  午夜」那一条当场转红，而同一批的「今天 / 昨天 / N 天前」三条**照样绿**）。

## 相关

`@/lib/format.js` · `src/manager/http/auth.ts`（打码不透露长度的同源纪律）
`tests/format/magnitude.test.ts` · `tests/format/duration.test.ts` · `tests/format/day-group.test.ts`
`tests/format/width.test.ts` · `tests/format/placeholder.test.ts`
