# tests/unit/ops/

本目录只答一件事：**数据源操作层 `src/ops/` 交出去的东西不许变成某一个界面的实现细节**。

## 为什么幂等那档用替身 `AclSource` 而不是真文件

「有没有落盘」这件事**在文件上看不出来**（`writeJsonAtomic` 重写同样的字节，内容逐字相同）。
唯一能判「第二次调用在实现上凭什么不同」的观测点是 **`write` 有没有被调用**，而那只在替身上
看得见。⚠️ 所以那三条断言的是 `spy.writes` 的**计数**，不是 `changed` 的布尔值 ——
改成断言返回值就等于把这条护栏拆掉（而它照样绿）。

## 防假绿的位置

- **② 与「`@/utils/addr` 只引 barrel」那两条都做成**双向**判据**：单看禁止集的话，
  把 `acl.ts` / 整个实现搬走就能让这组恒绿，故正向一侧要证明「admin → ops」「ops → addr」
  这两条边**今天真的存在**。
- **④ 的牙齿在计数上**，理由见上一节。⚠️ 写「幂等」类护栏前先问「第二次调用在实现上凭什么不同」
  （根 `AGENTS.md`「写护栏时」）—— 答案必须是实现里那条具体机制，不许另设一个「已释放」标志
  给自己发绿牌。
- **① / ③ / ⑤ 的锚点都是行为面**（返回值、`OpsError.code`、`applyPatch` 的抛错），
  不经过任何源码文本探测器，故不存在「探测器认不出那个词」那一类假绿。
- ⚠️ **`source-guards.test.ts` 整组怕空**：`sourceFiles("ops")` 走 `SRC_DIR`
  （`../../helpers/source-scan.js` 那一处导出的常量，**层数只许出现在那一处**）。
  路径写错 → 枚举到空集 → 后面每一条都在空集上通过。故第一条 `it` 就是
  「扫描面非空且含本层出口」，它与后面几条**必须同档**。
- **`read.test.ts` 的「配置报告一个文件都不造」**是把 `beforeEach` 建出来的临时目录**整棵树**
  快照下来比：它防的是「为多打一行造数据源」把无副作用动作变成建文件（账本目录尤其）。

## 临时目录夹具的形状

`_ops.ts` 持有 `beforeEach`/`afterEach` 的临时目录生命周期（`os.tmpdir()` 下的 `proxy-ops-*`）与
「磁盘形态 ↔ 归一形态」那一对账号夹具。⚠️ `dir` 以 **live binding** 导出：各档在用例执行时才读它，
在 import 处取快照会拿到空串。⚠️ 只被一档用到的东西（`usersPath` / `aclPath` / `treeFiles` /
`countingAcl`）留在那一档里，不进这个共用模块 —— 判据是「几档真用到」。

## 文件

- `read.test.ts` — 读面出结构化数据（账号表 / 名单 / 账本 / 配置报告 / 写面返回值）+
  `OpsError.code` 五档真值表与闭合集合。
- `write.test.ts` — 幂等 no-op（替身名单驱动）+ `applyPatch` 字段保全与判据来源。
- `source-guards.test.ts` — 层边界源码级断言（单向依赖 / `@/config` 与 `@/utils/addr` 的 barrel
  出口 / 不 import 代理侧）。
- `_ops.ts` — 三档共用的临时目录生命周期与账号夹具（**不带 `.test.ts`，不被 vitest 收集**）。
- `AGENTS.md` — 本文件。

## 相关路径

- `src/ops/` — 被测层：`resolveOpsSources` / `OpsSources` / `OpsError` / 各读写面函数。
- `src/datasource/acl/`、`src/datasource/users/` — `AclSource` 端口与账号表的归一形态
  （判据「只有一份」的另一半在那边）。
- `src/admin/` — 反向依赖那一侧的对照点（`admin → ops` 那条边由它证明存在）。
- `../../helpers/source-scan.js` — `codeOf` / `sourceFiles` 与 `SRC_DIR`。
- `../../helpers/public-hosts/unit-ops.ts` — 本目录公网 host 字面量的申报（那几条只是名单条目 /
  账号个人名单：被 `parseHostRule` 解析、被 `toEqual` 比较、或写进临时目录里的 `acl.json`，
  **本目录不起监听、不拨号**）。
- `src/utils/addr/AGENTS.md` — 名单条目语法（`@/addr` 那侧）。