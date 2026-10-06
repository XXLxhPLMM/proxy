# tests/unit/core/server/ — 入站服务层（`src/core/server/`）的判据

本目录只答一件事：**入站那一侧**（`BaseProxy` 生命周期状态机 + 「哪种入站事件走哪个转发器的哪个
方法」这张派发表），**哪几处不许漂**。出站与上游那一侧的判据在
`tests/unit/core/request-scope/`（分配面与组装面）。

## 相关路径

- `src/core/server/base.ts` — `BaseProxy` 生命周期状态机与 `ContextualBase` 的接线。
- `src/core/server/http.ts` — 三个 `server.on` 回调 + `buildInboundChannels` 派发表（**服务构造期**建）。
- `src/core/server/admission.ts` — 两阶段准入与 `createRequestScope` 在 `src/**` 里**唯一**的那个调用点
  （组装面的判据在 `../request-scope/assembly.test.ts`）。
- `src/core/server/{socks-base.ts,socks-session.ts}` — SOCKS 那一侧（共享同一份准入与 scope 组装，
  但**不进**派发表；它的关卡顺序判据在 `tests/integration/inbound/`）。
- `tests/helpers/{net,config,access}.ts` — `getFreePort` / `testConfig` / `openAccessControl`。