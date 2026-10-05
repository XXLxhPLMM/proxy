# tests/unit/core/helpers/ — `core/helpers` 各纯工具的判据

本目录只答一件事：**转发层那些纯函数与两个薄守卫的字节/返回值/边界**。
机制与层不变量归 `src/core/helpers/AGENTS.md`；这里只管**测试侧锁的是哪几条、牙齿在哪**。

⚠️ **一档一个被测模块，档名跟 `src/` 走**（`target.ts` / `headers.ts` / `self-loop.ts` /
`route.ts`）。例外是 `bridge.test.ts`：它测的两个模块**不住这一层**
（`Dialer` 在 `core/forward/upstream/dial.js`、`guardDialing` 在 `core/guard.js`），
按主题归到本目录是因为它们与「出站头 / 目标 / 自环」同属「一次转发的前后手」这一圈；
判据随模块走，它自己的档里也有一份对应的。

## 锁什么

① **拼装侧补方括号、解析侧剥壳**（`target.ts`）。`net.connect` 要**裸 host**，方括号是拼装侧的
   义务；而 `absoluteFormAuthority` 是**例外档**——它服务的对象是「客户端发来的 URL 原文」，
   那里方括号属于 URL 语法的一部分。拼装侧三行钉法：`formatAuthority("::1", 443) === "[::1]:443"`、
   `formatAuthority("2001:db8::1", 80) === "[2001:db8::1]:80"`、
   `absoluteFormAuthority("https://[::1]:8443/x") === "[::1]:8443"`；解析侧两行钉法：
   `parseTargetParts("/p", "[::1]").host === "::1"`、`parseAuthority("[2001:db8::1]:80")` 的
   hostname 是裸地址。⚠️ **两侧同向**（都留或都剥）才是恒绿的写法 —— 本目录刻意一拼一剥各钉一档，
   才拿得住这条不变量的两面。
② **`headers.ts` 对配置的依赖必须是零**：判据归身份插件 ⇒ 出站头净化不需要知道任何配置项。
   `@/config/index.js` 一个都不许引、连 `ConfigAccessor` 这个类型名都不许出现、`.get(` 一个都
   不许有（哪怕是别的键）。逐条牙在 `headers.test.ts`：`零 @/config/index.js 导入` /
   `零 config.get / 零 ConfigAccessor` / `只 type-only 引 IdentityProvider` /
   `isProxyHeaderName` 零依赖 / `isStrippableOutboundHeader` 体内零 `authorization` 字面量 /
   三个薄封装把 `identity` 收成必填形参（不许 `?` 也不许 `??` —— 判据缺席在安全语义上等于全放行）。
③ **委派必须覆盖每个出站头名、且协议规则在前**（`headers.ts` + `../identity/credential-seam.test.ts`）：
   零配置那条与「问到每个头」那条必须**成对**存在，理由见 `../identity/AGENTS.md` 不变量 ②。
④ **自环判定的三个面同档**：纯函数 `isSelfLoopAddr`（四参 `(目标 host, 目标端口, 监听 host,
   监听端口)`）的通配监听与归一化，加上从 `ConfigAccessor` 取监听地址的薄委托 `isSelfLoop`。
   配置版的行为完全由「它把哪两个值喂给了纯函数版」决定，拆开就只钉住一半。归一化面刻意逐个
   值语法档写开：`0.0.0.0` / `::` / 展开形态是 `canonicalHost` 里三条独立分支（改掉一条另外两条
   不响），`%zone` 后缀与 `[::1]` 方括号形态在这一层归一（link-local 与手工配置两种来源）。
⑤ **路由判定走注入端口**（`route.ts`）：换掉注入的那一份 `RoutePolicy` 判定就整个反过来。
   `resolveForwardTargets` 的 `dial` 指向该 store 的上游而 `dest` 仍是真实目标 —— 两者搞反就是
   「把请求发给了上游自己」；而全局 `proxyMode` / `port` 全程不变正是排除「其实读的还是全局」的
   唯一办法。

## 文件

- `target.test.ts` — ① 加 `wire.ts` 的 CONNECT 报文字节与 host 白名单。
- `headers.test.ts` — ②③ 加内置 HS256 同步验签（`fail-closed`、永不抛）。
  ⚠️ **双源档**：9 个 `it` 里 6 个来自 `identity-credential-seam.test.ts`（源码级零配置，
  `describe("core/helpers/headers.ts：零配置读取（判据已搬出本文件）")`）、
  3 个来自 `proxy-helpers.test.ts`（行为面，`describe("…：出站凭证剥离与内置 HS256 同步验签")`）
  —— 拆开即割裂「判据不在本文件」这条分层事实。
- `self-loop.test.ts` — ④。⚠️ **双源档**：12 个 `it` 里 1 个来自 `proxy-helpers.test.ts`
  （走注入监听地址那一条，`describe("…：走注入监听地址的那一条")`）、11 个来自 `self-loop.test.ts`
  （纯函数面，两组 describe）。
- `route.test.ts` — ⑤，含 `resolveForwardTargets` 的 `dial` / `dest` / `route` 三个出口。
- `bridge.test.ts` — `Dialer.bridge` 与 `guardDialing`：真 `net.Server` 起在 `127.0.0.1` 的
  **端口 0** 上（本目录唯一起监听的几档 —— 「一端关闭带走另一端」「失败只断一端」只有真
  socket 看得见）。⚠️ 双连接的读端必须是**对侧**（读自己那一端会撞 RST 竞态）。
- `AGENTS.md` — 本文件。

## 防假绿的位置

- **② 的判据全是「读源码文本」**：`headers.test.ts` 那六条靠 `codeOnly`（去注释），
  而「三个薄封装把 `identity` 收成必填形参」那条**只取形参列表**（锚点到函数体的 `{` 之间）——
  「往后一直找」会退化成「文件后面某处出现过这句话」，那时删掉形参也照样通过。
- **`isProxyHeaderName` 那条按第一个 `}` 切函数体**，故它断言的是「签名与零依赖」而不是整段文件；
  两条规则（`isProxyHeaderName` / `isOwnCredential`）的**顺序**由 `blockAfter` 取出函数体后
  `indexOf` 比较锁。
- **④ 的归一化面逐个值语法档写开**：通配三条（`0.0.0.0` / `::` / 展开形态）是 `canonicalHost`
  里三条独立分支，改掉一条另外两条不响 —— 这就是它们各自一档的理由。
- **① 的判别力在「解析侧剥壳」那几行**：一旦解析侧把方括号留下，`host` 就是 `"[::1]"` 而不是
  `"::1"`，那行 `toEqual` 立刻对不上。

## 相关路径

- `src/core/helpers/target.ts` / `headers.ts` / `self-loop.ts` / `route.ts` / `wire.ts` — 被测模块。
- `src/core/helpers/credentials.ts` — 内置 HS256 验签与 Basic 令牌解析原语。
- `src/core/forward/upstream/dial.ts`（`Dialer`）、`src/core/guard.ts`（`guardDialing`） —
  `bridge.test.ts` 的被测模块。
- `src/core/identity.ts` — `headers.test.ts` 的判据来源；`noneIdentity()` 是
  `target.test.ts` 那两条「只锁 `proxy-` 前缀宽规则」用的显式 inert 档。
- `../identity/AGENTS.md` — 不变量 ①②③ 的完整论证与变异表。
- `tests/helpers/source-scan.ts`（源码文本面）、`tests/helpers/public-hosts/unit-core-helpers.ts`
  （本目录申报过的公网 host 字面量）、`../helpers/AGENTS.md`。