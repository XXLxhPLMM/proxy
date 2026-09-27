# src/core/identity — 身份域

## 路径说明

| 文件 | 装什么 | 判据 |
|---|---|---|
| `../identity.ts` | 身份层出口（**本目录刻意没有 `index.ts`**） | 用相对路径逐个 re-export，避免自我引用 barrel 造成循环 |
| `token.ts` | `TokenIdentityBase` 抽象骨架 | 「取凭证 + 脱敏 + 审计发事件 + 结果判定」同形的那一份 |
| `modes.ts` | 四个模式插件工厂（`basicIdentity` / `uidIdentity` / `jwtIdentity` / `noneIdentity`） | 四种差异**只在「拿到 token 之后怎么比对」这一步** |
| `file-account.ts` | `FileAccountIdentity` —— 账号表驱动的那一个 | 读 `AUTH_USERS_FILE`（`cfg/users.json`），**不在** env |
| `factory.ts` | `createIdentity`（低层直构）/ `createIdentityFromConfig`（配置驱动门面）/ `defaultJwtVerify` | `createIdentityFromConfig` 是 CLI 与 `createProxyRuntime` 走的唯一路径 |

**不属于本层**：账号表与配额字段的读面（`src/config/files/users.ts`）、凭证索引与 HS256 验签原语（`../helpers/credentials.ts`）、鉴权握手阶段（`../server/socks-session.ts`）、`auth.decided` 的发布（`../server/base.ts:authorize`）。

## 硬约定

- **`TokenIdentityBase` 刻意一并导出** —— 它是自研身份插件的**唯一复用入口**。不导出会逼调用方把「取凭证 + 脱敏 + 审计发事件」重新抄一遍，而那正是「不许拆成四份拷贝」的理由。
- **`createIdentityFromConfig(ctx, onFileEvent?)` 收整个 `CoreContext`**（配置 / 日志 / 事件总线三件套），**不是 `ConfigAccessor`**。它每次 `identify()` **与每次 `isOwnCredential()`** 都现读 `authEnabled` / `authType` / `jwtSecret` / `authLogging` 与账号文件（热加载），两条路径**共用同一个 live 构造闭包**，不存在「鉴权读到新值、剥离读到旧值」的口径分裂。文件观察面（发公共事件那一半）**由唯一组装点经形参注入**。
- **「现读」指的是现读那六个输入，不是「每次判定都 new 一个实例」**：`factory.ts` 的 `liveSnapshots`（`WeakMap<ConfigAccessor, LiveSnapshot>`，六个输入每次现读、逐项比身份后复用快照，零定时器 / 零 TTL / 零轮询）只消除**重复构造**，**判定本身每次都照跑**。⚠️ **不要把它写成性能优化**（实测只省 0.2–1.6 µs/次，噪声底量级）——热路径成本的大头是 `loadAuthUsers` 的 `readJsonCached` 编排（其中 `path.resolve` 占 44%），**不是**快照构造。
- **`kind` 是稳定字符串、不是闭合集**。core 遇到不认识的值的默认行为恒是「当作已启用」。**消费方只读 `isEnabled`**（口径 = 「本实例会不会拒绝任何人」，含 `none`）——不要再自己判一次 `kind !== "none"`，那是把同一个事实抄成第二份真相。
- **身份层零日志**：审计经 `IdentityContext.onAuthEvent` → `../server/base.ts:authorize` 直发 `auth.decided` → runtime 层落盘。
- **Token 来源**：`Proxy-Authorization` 优先、`Authorization` 回退（RFC 7235，scheme 大小写不敏感）。
- **审计 `tag` 为 `"tunnel"` 仅当 `method === "CONNECT"` / `socks*` 协议** —— 不许用 `authority.includes(":")` 判定。`tag` 在 data、身份维度在 context。
- **`basic` 在 socks4 / sockss4 额外接受 `USERID == username`**（无密码字段）。SOCKS 鉴权发生在握手后：socks5 / sockss5 走 RFC1929 user/pass（`isEnabled` 为真时），socks4 / sockss4 用 USERID。
- **失败闭环**：账号形状非法 abort 启动（`validateAuthUsers`）；`authEnabled + basic|uid + 空表` abort（`assertAuthConfig`）；`identify()` 内异常一律 deny（`authorize()` 捕获）。
- **凭证索引住在 `helpers/credentials.ts`**（`buildCredentialIndexes` / 单槽记忆 / `matchBasicCredential` / `matchUidCredential`），身份层只做薄委托，保证出站头剥离与鉴权用同一判据。

## 凭证防泄漏

判据由 `IdentityProvider.isOwnCredential` 独占（裁决与代价见 `../AGENTS.md`「三个可插值端口」小节）。basic / uid 走**整份账号表**比对；**jwt 也参与出站剥离**——剥 scheme 前缀后按 `isJwtShape` + `verifyHs256Jwt` 验签判定，**不依赖账号表**（jwt 允许空表，故该分支**必须先于空表早退**）。默认注入内置 HS256 校验 `defaultJwtVerify`（薄 async 包装，与出站剥离共用同一实现）；显式注入优先；`jwtIdentity()` 要求显式注入（未注入一律拒绝），`FileAccountIdentity` 直构时 `type=jwt` 同样必填（未注入一律拒绝，审计照打）。

## 决策清单

**每条：结论 — 否掉了什么 — 为什么。推导读代码与 git log，结论不可推导。**

> **本目录的六条决策全部属于「没有任何测试会红」那一类**，所以它们**全部留在这里**。逐条核过：
> `tests/unit/identity*.test.ts` 锁的是**判据的行为与端口形状**（`isEnabled` / `isOwnCredential`
> / 快照记忆化 / jwt 验签），`tests/unit/inbound-dispatch.test.ts` 锁的是**派发表形状**，
> `tests/unit/forward-directory-layout.test.ts` 锁的是**目录布局**——没有任何一条断言会因为
> 「把四个模式合回一个文件」「给本目录加个 `index.ts`」「把文件观察面改成自注册」「把
> `createIdentityFromConfig` 收成只收 accessor」「`createIdentity` 只留一个入口」或「消费方
> 改读 `kind`」而变红。把它们搬进任何测试文件的头注释都只能变成**无人守着的副本**。

1. **拆成四个文件** — 否掉「一个 `identity.ts` 里 switch 四种模式」— 四种模式的差异**只在「拿到 token 之后怎么比对」这一步**（账号表精确比对 / 仅比用户名 / 异步验签 / 恒放行），而「取凭证 + 脱敏 + 审计发事件 + 结果判定」是完全同形的一份。合在一个文件里，读者无法一眼看出「哪部分真的因模式而异」；拆开后：① 库调用方能**单独构造其中一种语义**——这是可插值身份的真实价值；② 那份同形的骨架收进 `TokenIdentityBase`，**不许**把它也拆成四份拷贝（scheme 大小写不敏感、隧道 tag 判据、失败必发审计这三条不变量经不起任何一处漂移）。
2. **本目录不建 `index.ts`** — 否掉「加一个 barrel」— 会在 `../identity.ts` 这个层出口里造成自我引用 barrel 循环。
3. **文件观察面是形参（`onFileEvent?`）而不是 `ctx.events`** — 否掉「让身份模块自注册文件订阅」— `CoreContext` 是**只读三件套视图，不是订阅注册表**：把「我想订阅什么」塞进「我有什么依赖」，等于让同一个对象既是依赖又是装配指令，而一个带登记项的 `readonly` 视图在类型层面就不再只读。更要紧的是订阅**生命周期**（`runtime.start()` 装配、`runtime.stop()` 退订）属于唯一组装根；自注册就多出**第二个**登记点，两个具体后果是 ① 一次文件变更**双发** `config.file-error`（一个事实两个来源）② `stop()` 的退订清单漏掉那一轮，**停机后留下监听器**。ACL 域是同一条纪律的另一个入口（`access-control.ts:bindAclFileEvents`）。
4. **`createIdentityFromConfig` 收 `CoreContext` 整个而不是 `ConfigAccessor`** — 否掉「只收 accessor」— `isOwnCredential` 跑在**出站头剥离热路径**上，逐方法传参等于把 DI 成本摊到最热的路径；而账号文件坏掉时能渲染日志与发事件是必需的。
5. **`createIdentity(opts, config)` 是低层直构入口**（不收 ctx）— 否掉「只留一个入口」— 自研实现要复用 `TokenIdentityBase` 就必须能自己拿一个 accessor 造出来，不必伪造一个 `CoreContext`。
6. **`kind` 不做成闭合集、消费方只读 `isEnabled`** — 否掉「消费方读 `kind`」— `kind` 是稳定字符串：库调用方注入一个 `kind` 不在集合里的实现时，core 的默认行为必须明确（恒「当作已启用」，即安全的一侧），而这需要一个开放类型才表达得了。

## ⚠️ 已知边界：注入的自定义 `verify` 对出站剥离判据不可见

**这是类型层的必然结果，不是疏忽**——三行事实摆在那里就成立：`isOwnCredential` 按端口契约**是同步的**；`verify` 的类型是 `(token, secret) => Promise<boolean>`；同步判据**不能 await Promise**，所以 jwt 分支眼下只能拿内置 `verifyHs256Jwt` 算。

后果要精确说：

- **默认路径零边界。** 生产链注入 `defaultJwtVerify`，它是**同一个 `verifyHs256Jwt` 的薄 async 包装**——剥离与识别逐字节等价，不泄漏。
- **只有注入的非 HS256 校验器受影响。** 注入 RS256 / 远端 JWKS 实现时，**它**认而内置 HS256 判据不认的 token **不会被剥离**，会带着 `Authorization` 到达源站。
- **正确修法是让端口把一个同步结论交给剥离路径**（可选的 `isOwnCredentialSync`，或把校验器拆成「同步结构检查 + 异步密码学检查」两段）。**把 `isOwnCredential` 改成 `async` 不是修法**——那会让**整条**出站头剥离路径变 async，比这个问题本身的分量重得多。**刻意不做**：留档这条已知边界加上修法候选，好让下一个人要么有意去修、要么重新确认这个取舍，而不是重新发现一遍。
