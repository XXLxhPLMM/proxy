# tests/unit/config/auth-users/ — `users.json` 那一层

本目录只答一件事：**磁盘上这份 `users.json` 能不能被读成一份可信的账号表**（形状校验、读取面、
两条读面的跨层纪律）。

计量与消费侧判定**不在本目录**：`@/datasource/quota` 的 `UsageMirror` 与窗口滚动在
`tests/unit/datasource/quota/**`，真装配上的耗尽行为在 `tests/integration/traffic-quota/`，
`acl` 的判定层优先级在 `tests/unit/core/access-control/**`。

## 两个驱动键的缺省后端 = json，而选它就是接受账本那个缺口

`authUsersDriver` / `quotaUsageDriver` 的缺省都是 `json`，而 `FIELDS` **不给**这两个键自己的
`def` —— 缺省只有 `defaults` 一个真相源（判据在 `quota-fields.test.ts` 那个 describe）。

⚠️ **json 档账本没有多进程判定共享**（`@/datasource/quota/jsonl-source.ts` 文件头）：
多个进程共享同一份账本时账号级封禁退化成「每进程一份」。**选 json 当缺省就是接受这一点。**
那条缺口今天**只有注释与 `.env.example` 在说，没有告警**——`RuntimeWarning` 已裁决
「到第三条 inert 告警就不再加 if 分支」，加第 4 条要先做它的 `level` 化重构。

## 总纪律：形状是 fail-closed，任一格不合法即**整份文件作废**

不是「只丢非法的那一个、其余照常生效」。理由：那会造出「我配了名单 / 配额但它没生效」这种
**要读源码才能查出来**的问题——而配置面本该在启动期就说完话。

⚠️ 三个后果方向相反，判据因此必须逐条钉住，任何一条都**不许由别的条代**：
- **形态非法 → 整份文件作废**（本目录的绝大多数断言）；
- **已过期 / `bytes: 0` / `disabled: false` 都是合法值**——那就是这些字段要表达的状态，
  只有**形态**非法才作废（`expiry.test.ts` 与 `quota-validate.test.ts` 各有一条正向对照）；
- **可选字段缺省时产物里不许凭空多出那个键**（`quota.window` 归一在消费侧，见下面 ⑤）。

## `expiresAt` / `disabled` 的 fail-closed 归一（`expiry.test.ts` 那档的两条推导）

判定在 `src/core/identity/`（认证点），本目录只答「磁盘上这个值能不能被读成一个时刻 / 一个布尔」。

**`expiresAt` —— 形态必须带时区偏移**：`Date.parse` 会把 `"2026-10-01"` 读成 **UTC 午夜**、把
`"2026-10-01 00:00"` 读成**本地午夜**——同一份配置在 UTC 机器与 `+08:00` 机器上差 8 小时，
而运维写它时心里想的是本地零点。收下它等于把「这台机器的时区」变成隐藏真相。

**`expiresAt` —— 日历上不存在的日必须拒**：`Date.parse("2026-02-30T00:00:00Z")` 实测返回**有限值**
（静默滚成 3 月 2 日），故按「该月天数」显式再判一次。

### `disabled` 的判据为什么是 `typeof`

1. **必须真的是布尔**：`"true"` / `1` / `null` 一律让整份表作废。⚠️ 这条与 `expiresAt` 的
   fail-closed 同源但**没有例外**：不存在「已过期的 disabled」这种「值非法、但状态合法」的
   值，故这里**没有**「照收下来说明它无效」这条路。
2. **判据必须是 `typeof` 而不是三态真值**：写成 `disabled === true` 会把 `"true"` / `1`
   静默归一成 `false`（= 启用）——那正是「看着配了禁用、实际按没配跑」的假安全感，
   **比整份表作废更坏**（服务照跑，且没人收到任何信号）。本档有专门一条断言钉住这个方向。
3. **显式 `false` 与缺省同义但都合法**，且归一化**保留 `false` 本身**（不压成缺省键）：
   压缩会让「我明确开了这个账号」与「我明确关了它」在文件里长得一样，而那是下一次 diff /
   人工编辑最容易读错的一处。

## 配额：四个已否决的方向 + 四条裁决

四个**已否决**的方向（文档里出现即为错，除非同时改掉对应的负向护栏）：

① **禁限速 / 速率整形。** 只能到 chunk 粒度（TLS record ~16KB），低限速值要靠延迟换平滑；
且整形必然要 `pause()` / `resume()`，会与 `guardDialing` 的半关闭联动形成**第三层流控**。
牙齿：`quota-validate.test.ts` 的「未知子键 fail-closed」与「本文件不出现任何限速/并发字段名」。

② **禁每用户最大并发连接数。** 那是「连接数配额」不是「流量配额」，与窗口 / 字节两条轴都正交；
真要做必须先定义「并发数按哪个窗口重置」。牙齿：同上那两条。

③ **禁滚动时间窗。** 理由（解释成本 / 聚合成本 / 不预留占位值）写在「窗口化」与 `src/datasource/quota-window.ts` 文件头。
牙齿：`quota-window.test.ts` 的「非法 window 整组非法」整组 + 那条源码级负向
（`QUOTA_WINDOW_VALUES` 切片里不许出现 `week|hour|rolling`）。

④ ⚠️ **账本落盘是所有进程共用的一份，而实时判定是每进程一份**（完整推导与两处滞后量在
`src/datasource/quota/types.ts` 与 `mirror.ts:mirrorLagBoundMs`）：热路径读进程内镜像，镜像每
`QUOTA_FLUSH_INTERVAL` 才回读一次共享存储，于是 `N` 个进程共享同一份账本时合计放行可达
`N × quota.bytes` **加上**一段滞后量。**换驱动换不掉这条**——两个内置档都是「共享存储 + 进程内
镜像」同一种形态。
⚠️ **这一条没有任何断言会红**（跨进程判定在单进程测试里根本不可观测）：它靠
`tests/unit/datasource/quota/sqlite/layout.test.ts` 那条源码级断言（真相源只有一份）与
`tests/integration/quota/ledger-restart-recovery.test.ts`（两个实例写同一个库时量在同一行上相加）
间接兜住，但「判定是每进程一份」这个事实本身测不出来。**别把它当成已覆盖。**

另外四条裁决：

⑤ **缺省 `month` 的归一在消费侧**（`@/datasource/quota-window.ts:quotaWindow`），**不在本层补
默认值**——归一化产物只回显磁盘上写了什么；缺省时**不写 `window` 键**。故 `UserQuota.window` 是可选键，
`QUOTA_KEYS` 是**含 `window` 的闭合集合**（漏加 → 所有写了窗口的文件因「未知子键」整组作废）。
牙齿：`quota-window.test.ts` 的「缺省**不写** window 键」——补一个 `window: "month"` 就红。

⑥ **`quota` 与 `acl` 互不影响，但各自独立决定整份文件是否作废**（一个合法一个非法 →
**整份文件判非法**）——否掉「只丢非法的那一个、另一个照常生效」。
牙齿：`quota-validate.test.ts` 的「quota 与 acl 互不影响」（两个都合法时逐字 `toEqual`；
一个非法时 `toBeUndefined()`）、`quota-window.test.ts` 的「window 与 acl 各自独立」
（同一裁决的第四种组合）与 `validate.test.ts` / `expiry.test.ts` 那两条「**与 X 各自独立**」。

⑦ **热路径零分配是硬要求**——`loadUserPolicy` / `loadUserQuota` 是**每请求**调用的
（`consume` 甚至是**每 chunk** 调用，一次大文件传输几万次），故用下标循环定位账号
（`find` 的闭包也是分配）+ `WeakMap` 按**源对象身份**记忆冻结副本，连续两次查询返回
**同一对象身份**。牙齿：三条「热路径零分配」断言（`policy` / `quota-load` / `quota-window`）。
记忆表外仍**新建**冻结副本，故「拿到的对象与缓存内部引用无关」由 `quota-load.test.ts` 的
「返回值只读且与缓存内部引用无关」独立锁住。

⑧ **`acl` 与 `quota`（含 `window`）对凭证索引都不可见**——牙齿是那三条「凭证索引不受 X 影响」：
两侧**账号集合必须相同**（否则比的是「多了一个账号」而不是「X 有没有污染索引」），另加
「配额数字 / 名单条目 / 窗口字面量一个都不许进 `basic` 键」。

## 两族读面共用的纪律

- ⚠️ **读面零直接读取器**：另开一个读取器会造成两份节流缓存、两份解析、两套坏文件处理并互相
  污染同一缓存键。判据是「`read.ts` 一处都没有 + **每个后端恰好一处**」——
  锚的是**今天仍存在的形状**（函数调用 + 文件名），不是某个已被删掉的模块名（点不存在的符号，
  断言会恒真）。牙齿：`source-guards.test.ts` 与 `quota-load.test.ts` 的跨层一致性各一条，
  两条都覆盖 `loadUserPolicy` 与 `loadUserQuota` 两个函数体。
- **坏文件保留上一份有效值**：非法结构 / 非法 JSON 都要 `error` + **保留**上一次的值，
  绝不「清成空表 / 清成无限制」。三条读面各钉一次（`read` / `policy`+`quota-window` / `quota-load`）。
- **一次内容变更只报一次 `reloaded`**：两个读取器共用同一缓存条目与去重状态，故断言是
  `toEqual(["用户账号文件:reloaded"])` **逐字**而不是数次数。
- **启动期强校验同样 fail-closed**：`readAuthUsersAsync` 与同步读面共用同一份形状校验，
  故「同步判非法」的那批输入在启动期也是 `exists === true` + `error`（不是静默当没配）。

## 防假绿的位置

- **闭合白名单的联动断言**：三处（`ACCOUNT_KEYS` 里的 `acl` / `quota` / `disabled` / `expiresAt`，
  与 `QUOTA_KEYS` 里的 `window`）。漏加白名单会让**所有**带那个字段的账号文件整份作废 ——
  这些断言钉的是「加了它能过」，删掉白名单条目它们就红。
- **索引不可见那三条**：两侧账号集合必须**逐项相同** + `basic.size` 钉死 + 逐个值语法档
  （`b.basic.keys()` 里不许出现配额数字 / 名单条目 / 窗口字面量）。只比集合的话，一个
  「多了一个账号」的实现照样通过。
- **零分配用 `toBe` 不用 `toEqual`**：后者对「重新冻结了一份内容相同的新对象」照样通过，
  **锁不住分配**。另配一条正向对照（「按用户名分槽，不串号」：`not.toBe(first)`），
  否则前几条都在「一次都没跑成」的形状上恒绿。
- **O(1) 索引判形状不判计时**：计时断言在 CI 机器上必然抖，而「建索引 / 查索引」这两个动作出现、
  「扫全表」不出现是不会抖的。索引的判据是**账号数组的对象身份**，故它与读取缓存同生共死。

- ⚠️ **正则锚点必须点名具体符号名**（`validate.ts` 里只许有 `RE_ACCOUNT_EXPIRY`）：
  锚成泛化的 `const RE_` 会把任何新增的正则都算成违规，于是下一个来的人只能把有效期判据改写成
  字符串切片来绕过它。名单条目一侧的「零正则」由另外三条源码级断言 + 行为面锁住。
- ⚠️ **`_*.ts` 与样本常量必须留在本目录，不许进 `tests/helpers/`**：
  `external-network-scan.ts` 的 `SCAN_DIRS` 排除 `helpers/` 而 `walk()` 收目录下**全部** `.ts`
  —— 把带公网 host 字面量的东西搬进 `helpers/` 等于让那部分覆盖从零外网扫描里**静默消失**，
  而两条下界断言照样绿。**可见的重复优于看不见的失效。**
- ⚠️ **本目录的档一律不自己数 `..`**：`helpers/source-scan.ts` 已导出 `REPO_ROOT` / `TESTS_DIR` /
  `SRC_DIR`，层数只许出现在那一处。少一个 `..` 抛 `ENOENT`（自己暴露），
  **多一个 `..` 枚举到空集则恒绿** —— 后者只会静静地不再判任何东西。
  自查一行：`grep -rn "__dir" tests/unit/config/auth-users/ --include=*.ts`（`.ts` 侧必须零命中；
  本文件那一行是本纪律的说明，不算命中）。

## 零外网白名单

本目录的样本账号表（`_auth-users.ts` 的 `MIXED_ACCOUNTS` / `_user-quota.ts` 的 `MIXED`）带
公网 host 字面量（`*.corp.com` / `ads.io` / `a.com` …），它们**留在本目录**（见上）。
⚠️ 白名单条目按**目标目录**分片，而本目录归 `tests/unit/config/` 那一片
（`tests/helpers/public-hosts/unit-config.ts`，**`file:` 值由 `tests/unit/config/` 的属主改，
本目录不许碰那个文件**）—— 搬档时那一片不跟着改就会当场被判 stale。
⚠️ 本目录有 7 档带公网 host 字面量（`read` / `expiry` / `quota-load` 三档零字面量，故不建条目），
搬动其中任何一档时都要**先确认那一片的 `file:` 跟着改**，否则 B 面双向断言立刻红。

## 相关路径

- `../../../../src/datasource/users/validate.ts` — 形状校验与条目语法（`ACCOUNT_KEYS` /
  `QUOTA_KEYS` / `USER_POLICY_GROUP_KEYS` / `RE_ACCOUNT_EXPIRY`）。
- `../../../../src/datasource/users/read.ts` — 两条读面（`loadUserPolicy` / `loadUserQuota`）与
  身份索引 / 节流 / 事件。
- `../../../../src/datasource/users/{json,sqlite}-source.ts` — 两个后端各一处读取点。
- `../../../../src/datasource/users/types.ts` — `UserQuota` 字段形状（为什么只有一个合计上限）。
- `../../../../src/datasource/quota-window.ts` — 缺省 `month` 的归一（消费侧裁决）。
- `../../../../src/core/helpers/credentials.ts` — 凭证索引面（`acl` / `quota` 对它不可见）。
- `../../../helpers/source-scan.ts` — 源码级断言的文本面（`codeOf` / `codeOnly`）+ 三个路径常量。
- `../../../helpers/config.ts` — `testConfigStore` / `set` / `snapshotConfig` / `restoreConfig`。
- `../../../helpers/public-hosts/unit-config.ts` — 本目录的零外网白名单片（**属主是
  `tests/unit/config/` 那一片，不在本目录的写集里**）。
- `../../AGENTS.md`（`tests/unit/`）、`../../../AGENTS.md`（`tests/`）、`../../../../AGENTS.md`
  （仓根）。
