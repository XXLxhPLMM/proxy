# 结构化字段（JSONL）

> **按需分册**：skill 只自动加载 `SKILL.md`（读它的 frontmatter 决定要不要用），同目录的 `*.md` 分册**不会**被自动灌进上下文。
> **什么时候读**：要写日志解析器、按字段过滤 JSONL、或查某个事件码落盘后有哪些字段时

## Structured fields (JSONL)

- **Field detection**: if the **last** call argument is a plain object (prototype `Object.prototype` or `null`, which naturally excludes `Error`/`Array`/`Buffer`/`Date`/class instances), it is treated as structured fields.
- **Error rendering**: an `Error` argument in `msg` (and an `Error` field value on the console channel) renders as readable single-line text `name: message [code=...] [first stack frame]` — `JSON.stringify(new Error("x"))` would only yield `{}` and silently drop the 502 cause (ECONNREFUSED / TLS verification failure). The console `msg` channel is intentionally unchanged: a raw `Error` is still passed to `console.*` as-is so native stacks stay readable. Field detection is unaffected — `Error` is still not a fields object.
- **Console** (human-readable, unchanged style): `<ISO> <LEVEL> <prefix> <msg> k=v k=v`. Values: string → `sanitizeLogText`, number/bool → `String`, else compact JSON.
- **One rendering implementation, two callers**: field detection (`splitFields`), `k=v` rendering (`renderFields`) and non-field serialization (`stringifyValue`) live once in `sanitize.ts` and are shared by `LoggerImpl.fmt` and `createConsoleLogger` — **never duplicate them at module level**. The **one** intentional difference: `LoggerImpl.fmt` passes non-string arguments (including `Error`) through to `console.*` untouched to keep native stacks readable, while `createConsoleLogger` funnels them through `stringifyValue` (hence `renderErrorText`).
- **File** (JSONL, one JSON object per line):

  ```json
  {
    "ts": "2026-09-20T14:03:11.201Z",
    "level": "info",
    "pid": 1234,
    "prefix": "[proxy]",
    "msg": "[forward]",
    "client": "1.2.3.4",
    "target": "example.com:80",
    "method": "GET",
    "user": "alice"
  }
  ```

  Merge order is `{ ...fields, ts, level, pid, prefix, msg }` — **reserved keys `ts`/`level`/`pid`/`prefix`/`msg` win**, so a same-named field is ignored. `JSON.stringify` handles control-char escaping, so one call stays exactly one line.

- **Query it** with `jq` (the whole point of JSONL):

  ```bash
  jq -r 'select(.user=="alice") | .msg, .target' log/*.jsonl
  jq -r 'select(.msg=="[auth] deny") | .client' log/*.jsonl | sort | uniq -c
  jq 'select(.level=="warn")' log/*.jsonl
  ```

- Log lines carrying a `user` field: auth `allow`, `[forward]`, socks lines, and per-request `pipe` events (the username comes from `IdentityResult` — and is stamped on by the per-request `RequestScope.emit` closure — `ForwarderBase` holds no `emit` field of its own, so there is exactly **one** identity-injection point, `createRequestScope`). The two names that deliberately kept the `Auth` spelling are `AuthAccount` and `ProxyAuthEvent`, both **data**, not a way of identifying someone. ACL denials add `[ip-denied]` / `[target-denied]` (warn).
