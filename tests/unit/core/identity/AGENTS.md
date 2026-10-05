# tests/unit/core/identity/ — 身份域的判据（`@/core/identity`）

本目录只答一件事：**身份插件（`IdentityProvider`）的形状、判定与失效**。
机制与层不变量归 `src/core/identity/AGENTS.md`（凭证判据归插件、零配置读取、`isEnabled`
是唯一开关、异常即拒绝）；这里只管**测试侧锁的是哪几条、牙齿在哪**。

## 锁什么（三条不变量，每条都配了变异实测）

① **凭证防泄漏的判据由 `IdentityProvider.isOwnCredential` 独占、必填、无缺省、不可返回
   `undefined`**。被否掉的是「库层按 `authEnabled`/`authType`/`users.json` 猜」——那在
   「配置即身份真相源」的世界里成立；身份一旦可插值，凭证形态就由**插件**决定（自定义头名、
   HMAC 摘要、云厂商网关签名），config 不再是真相源，从 config 猜**必然失配**。而失配的代价
   不是「剥多了」（目标自己的 `Authorization: Bearer` 被误剥，最多少送一个头），
   而是反过来——**代理自己的凭证被原样转发给目标站**。故判据必填：漏实现要在**编译期**红。
   - 必填本身由 `own-credential.test.ts`「端口形状本身」那条的 `// @ts-expect-error` 锁。
     给端口补一个恒 `false` 的缺省实现 → 那一行失去 error → `pnpm typecheck` 红。
   - 「库层零头名门禁」由 `credential-seam.test.ts` 与 `../helpers/headers.test.ts` 那六条
     零配置断言锁：判据缺席在安全语义上等于「全放行」= 凭证原样转发，故既不许 `?` 也不许 `??`。

② **`proxy-` 前缀（协议规则）与凭证形态（身份规则）判据分开、且顺序不可换**。被否掉的是
   「把头名门禁加回去」：`isProxyHeaderName` 是零依赖纯函数（`error-boundary.ts` 在拿不到任何
   插件的上下文里也要用，**签名一字不许动**）；凭证形态只有插件知道，故**每个出站头名 × 每个值
   都问一遍**。加回头名门禁等于把凭证形态重新关进 `authorization` 这一个名字里——库调用方用
   `X-Api-Key` 鉴权时那个 key 会原样转发给目标站（`credential-seam.test.ts`「自定义头名插件」
   那条是它的反面）。协议规则在前，是因为它无条件、且那个头**根本不该问插件**：放到委派之后，
   「插件漏实现」就有机会把 `Proxy-Authorization` 放出去。
   - 顺序 + 零头名门禁由 `../helpers/headers.test.ts`「`isStrippableOutboundHeader` 体内零
     `authorization` 字面量」那条锁：两条对调、或把 `authorization` 白名单写回去 → 立刻红。
   - 「每个头名都问一遍」由 `credential-seam.test.ts`「判据对**每个**出站头都问一遍」那条的
     `expect(identity.seen).toEqual([{ name: "x-api-key", … }, { name: "x-other-key", … }])` 锁。
   - 「协议规则不问插件」由「`proxy-` 前缀仍是无条件宽规则」那条的 `expect(identity.seen).toEqual([])` 锁。
   - ⚠️ 委派次数 = 每个出站头 × 每个值，配置驱动门面是唯一大头（`readJsonCached` 编排占
     `loadAuthUsers` 的 44%）。**这个成本不构成把头名门禁加回去的理由**：省下的那点委派
     换来的是一条真实形态的凭据泄漏通道。

③ **判据与识别读同一份事实**（`jwtSecret` / `jwtVerify` 各只一处、`isEnabled` 是同一个开关、
   动态门面的 `isOwnCredential` 与 `identify` 共用同一个 `live()` 闭包）。
   两份真相的症状是「能过鉴权的凭证没被剥」= 凭证泄漏。
   ⚠️ 与「六项失效判据」是同一件事的两面：**记忆化省的是构造、不是真相源**——
   见 `snapshot-source-guards.test.ts` 的文件头与那张变异表。

## 认证点的第二道判定（`expiresAt` / `disabled` 两档锁的东西）

两档**逐字同构**、且顺序判据相反（「先 `disabled` 后 `expiry`」）——「谁禁的他」比「他什么时候到期」
更能指导运维下一步动作，故反过来实现时两档都会红。形状校验（必须真的是布尔 / ISO 形态
fail-closed / 已过期合法）归 `../config/auth-users/validate.test.ts`，这两档只答「到点了 /
被禁了到底发生什么」。`expires-at` 五件事：

1. **命中之后才判**：凭证先比对成功，再比到期时刻（审计带 `user` + `reason=account-expired`）。
   凭证都没对上就报「过期了」会把两种完全不同的失败混成一种。
2. **`>=` 边界**：恰好等于到期时刻即拒（与配额那条「恰好等于上限放行」刻意相反）。
3. **过期账号仍在凭证索引里** —— **安全断言**不是功能断言：索引同时供出站剥离判据使用，
   剔除会让它的凭证被原样转发给目标站。
4. **jwt 模式下不生效**：用户名取自 token 的 `sub`、不查账号表，`FileAccountIdentity` 因此
   **不把账号表递给基类**。牙齿是「同名账号 + 过期 `expiresAt` + 合法 token 仍放行」。
5. **不追溯已建立的连接**：判定只在 `identify()` 这一个认证点，隧道不复查。

`disabled` 在此之上多一条 **uid 模式同样生效**（socks4 的 USERID 语义与 basic 共用这道判定）。
两者对「jwt 模式下不生效」的后果分级不同：`expiresAt` 是「到期了还在用」，`disabled` 是
「以为把这个账号封住了、其实完全没封」。对应那条启动期告警是 `account-table-inert`（两字段共用
一个码）。

## 记忆化三档的分工与夹具纪律

- **记忆化是为「消除重复构造」、不是性能优化**：实测命中与不命中只差 0.2–1.6 µs/次，落在噪声底。
- **诚实记录一处行为面做不到的事**：记忆化「命中」在行为面**不可观测**（不命中就重建，重建结果
  与命中那份一致）⇒ 「输入未变即复用同一份快照」只有**源码级**断言能锁。
- **每一条判据都有专属用例**（失败原因明确，不是靠某条无关用例顺带变红）；节流处理照抄既有
  手法（`vi.useFakeTimers()` + `vi.advanceTimersByTime(1500)` + 单调递增 `fs.utimesSync`）。
- **每例一份私有 `ConfigStore` + 私有 users.json + 显式钉住 `authUsersFile`**：不钉会读到
  开发者本地的账号表（症状是断言里凭空多出别人机器上的账号，本机红、CI 绿）。
- **失效面那条以「前提用例」开头**：地基塌了，后面那几条即便全绿也证明不了任何东西。
- **为什么另起一档而不并进身份判据那几档**：那些档各有自己的夹具纪律（判定真值表 / 端口接缝 /
  不落盘文件），本档需要每例一份私有 store + 假时钟，塞进去会污染那几档的假设。

## 文件（⚠️ 不变量编号 ↔ 位置对照）

- `construction.test.ts` — 提取器（头名 / scheme / 值载体怎么被读成 token）+ `createIdentityFromConfig`
  的**注入面**（私有 store 换掉后开关 / 类型 / 账号表都跟着换）。
- `file-account.test.ts` — **不变量 ①③ 的行为面**：`enabled` / `basic` / `uid` 四形态 /
  basic+socks4 的判定真值表。
- `token-parsing.test.ts` — scheme 大小写、空用户名向量、审计事件字段（`attempted`/`user`）、
  `tag` 语义。⚠️ 本档带**申报过的**公网 host 字面量（`example.com:*`），只进审计事件的 `target`。
- `verify.test.ts` — jwt 分支：外部 `verify` 委托、`defaultJwtVerify` 的 fail-closed 面、
  生产路径接线（显式注入优先）。
- `expires-at.test.ts` / `disabled.test.ts` — 认证点的**第二道判定**（`expiresAt` / `disabled`）。
  ⚠️ 两档逐字同构**且顺序判据相反**（「先 disabled 后 expiry」），故合起来才是完整那条。
- `credential-seam.test.ts` — **不变量 ② 的行为面**：自定义 scheme 与自定义头名两个替身插件，
  证明库层真的问到每个头、真的照答案剥。
- `own-credential.test.ts` — **不变量 ①③**：判据与识别同源（源码级 + 端口形状）+
  内置四插件的判据真值表。
- `no-legacy-helper.test.ts` — 旧判据 `isProxyCredentialValue` 在 `src/` 全仓消失，
  含**注释面的逐条登记**。
- `snapshot-invalidation.test.ts` / `snapshot-hot-reload.test.ts` — 记忆化的失效侧
  （`accounts` 对象身份）与热改侧（五个标量 + 注入位），每条判据一个**专属**用例。
- `snapshot-source-guards.test.ts` — 记忆表判据链 + 零定时器 / 零 TTL / 零轮询（源码级）。
- `_identity.ts` — 六档共用的 `b64` / `acct` / `signJwt` / `ctxWith`。
- `_identity-snapshot-memo.ts` — 两档共用的 `b64` / `basicHeader` / `ctxWith`。
- `AGENTS.md` — 本文件。

## 防假绿的位置

- **① 与 ② 的判据全是「读源码文本」，探测器认不出那个词时它们会在空集上通过** ——
  故 `no-legacy-helper.test.ts` 先报「扫到几个文件」（`files.length > 30`），
  `snapshot-source-guards.test.ts` 有 `code.length > 2000` + `liveSnapshots` 的正向存在性，
  `own-credential.test.ts` 那条「`enabled` 门禁与早退是同一行」在锚点消失时会**报错而不是通过**
  （`memoRegion()` 里 `expect(at).toBeGreaterThanOrEqual(0)`）。
  ⚠️ **`no-legacy-helper.test.ts` 的锚是一个已被删掉的符号名**，按根 `AGENTS.md`
  「写护栏时（负向断言的假绿）」，这类断言天生**恒真而不是失败** —— 它靠两件事撑着：
  上面那条「扫到几个文件」证明扫描面非空，第四条**反过来**断言「提到它的地方逐条登记在清单内」
  （有人重新引入它，无论落在代码还是注释，那条都会红）。**改这一档前先做变异实测。**
- **③ 的判据钉在「同一行 / 同一处定义」而不是「值相等」**：`isOwnCredential` 的早退必须是
  `if (!this.isEnabled)` 那一行、判据必须 `return live().isOwnCredential` —— 写成
  `if (!this.enabled && this.kind !== "none")` 功能等价但两份真相，源码级那条立刻红。
- **`snapshot-*` 两档的节流处理照抄既有手法**（`vi.useFakeTimers()` +
  `vi.advanceTimersByTime(1500)` + 单调递增 `fs.utimesSync`），不自己发明；且每例一份
  **私有** `ConfigStore` + **显式钉住** `authUsersFile`（不钉会读到开发者本地的账号表）。
- **`ctxWith` 的 `authority` 用 `example.com:80`（`_identity.ts`）与 `target.invalid:80`
  （`_identity-snapshot-memo.ts`）两种**：前者是**已申报**的（白名单那一片里有它），后者刻意用
  RFC 2606 保留 TLD 免申报。两份 `ctxWith` 是**两份而不是一份**（形状不同，见各自的模块头）。

## 相关路径

- `src/core/identity/file-account.ts` — 被测实现：`FileAccountIdentity`（判据与识别同源那份代码）。
- `src/core/identity/factory.ts` — 动态门面 `createIdentityFromConfig`、记忆表 `liveSnapshots`、
  低层直构 `createIdentity`、内置 HS256 校验 `defaultJwtVerify`。
- `src/core/identity/modes.ts` — 内置四插件 `basicIdentity` / `uidIdentity` / `jwtIdentity` /
  `noneIdentity`。
- `src/core/helpers/headers.ts` — 判据的**消费方**（零配置面在 `../helpers/headers.test.ts`）。
- `src/core/types/identity.ts` / `src/core/types/proxy.ts` — 端口形状与审计事件字段。
- `tests/helpers/source-scan.ts` / `tests/helpers/src-files.ts` — 源码文本面与 `src/**` 递归清单。
- `tests/helpers/public-hosts/unit-core-identity.ts` — 本目录申报过的公网 host 字面量。
- `../helpers/AGENTS.md`、`../inbound-dispatch.test.ts`（`isEnabled` 的消费方）。