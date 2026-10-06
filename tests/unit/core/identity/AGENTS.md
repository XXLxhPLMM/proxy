# tests/unit/core/identity/ — 身份域的判据（`@/core/identity`）

本目录只答一件事：**身份插件（`IdentityProvider`）的形状、判定与失效**。
这里只管**测试侧锁的是哪几条、牙齿在哪**。

## 认证点的第二道判定（`expiresAt` / `disabled` 两档锁的东西）

两档**逐字同构**、且顺序判据相反（「先 `disabled` 后 `expiry`」）——「谁禁的他」比「他什么时候到期」
更能指导运维下一步动作，故反过来实现时两档都会红。形状校验（必须真的是布尔 / ISO 形态
fail-closed / 已过期合法）归 `../../config/auth-users/expiry.test.ts`，这两档只答「到点了 /
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
- `../helpers/AGENTS.md`、`../server/base-lifecycle.test.ts`（`isEnabled` 作为必填端口成员的
  消费方：那档的替身把它写成必填，漏实现即编译期红）。