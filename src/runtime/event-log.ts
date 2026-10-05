/**
 * @fileoverview 代理事实事件 → 日志端口的绑定：EventHub 订阅 + logger 渲染
 * @module runtime/event-log
 * @description
 * core 只抛事实（`this.events.publish(...)`）、从不直接落盘；本文件是那层**翻译**：
 * 把 `EventHub` 上的公共事件收成 `[{event-code}]` / `[route]` / `[forward]` 之类稳定可 grep 的日志行。
 *
 * **本文件有两族绑定，身份是同一个——「EventHub 事实 → 注入的 logger」**：
 * `bindProxyEventLogs`（11 类**代理事实**：请求期 / 服务期）与 `bindLifecycleLog`
 * （`lifecycle.changed` 那一行 `[lifecycle] state …`，**服务期**）。
 *
 * ## 为什么住这个层（判据：「谁声明拥有这个进程」）
 *
 * 落盘**不拥有进程**——它不装信号、不 fork、不 `process.exit`、不读 `process.env`，只有
 * `hub.subscribe` 与 `logger.*` 几种动作，**零 `process` 触点**。挂在「拥有进程」那一层会让
 * 库调用方（`createProxyRuntime()`）拿不到落盘日志，只剩两条路：接受没有落盘，或自己重写那
 * 11 个订阅并记得在 stop 时退订（漏了就泄漏监听器）。住在库层还**不新增任何依赖边**
 * （`server/` → `runtime/` 是既有方向），于是 CLI 侧与库侧是**同一份绑定**，日志行一条不多
 * 一条不少。
 *
 * ## 零副作用
 *
 * 只订阅、不注册进程事件、不读 env、不写文件。真正的 IO 在 logger 那一侧
 * （`LoggerImpl` → `jsonl.ts`）；传进来一个 `createNoopLogger()` 就是零落盘。
 */

import {
  logBadRequest,
  logIpDenied,
  logLoopDetected,
  logQuotaExceeded,
  logUsageWriteError,
  logTargetDenied,
  logTargetUnresolved,
  logUpstreamError,
  logUpstreamRefused,
  logUpstreamTimeout,
} from "@/core/log-events.js";
import type { EventEnvelope, EventHub, EventName, EventSubscription } from "@/core/events/index.js";
import type { PipeEvent } from "@/core/types/pipe.js";
import type { ProxyForwardKind, ProxyProtocol } from "@/core/types/proxy.js";
import type { Logger } from "@/utils/logger/index.js";

/** forward.error 日志名前缀：kind -> 函数名，Record 保证新增 kind 时编译期必补 */
const FORWARD_ERROR_LABEL: Record<ProxyForwardKind, string> = {
  http: "forwardHttp",
  tunnel: "forwardTunnel",
  upgrade: "forwardUpgrade",
};

/**
 * 代理事件日志订阅 - core 只抛事实不直接记，日志收拢于此。
 *
 * 订阅源是注入的 `EventHub`（core 只 `publish` 事实、不自带 EventEmitter）。落点见下表，
 * `pipe` 的 14 变体 switch 是穷尽清单：
 *
 * | 事实 | 订阅的公共事件 | 落点 |
 * |---|---|---|
 * | 请求头 dump | `forward.request-headers` | `[{kind}] headers` debug |
 * | 请求开始    | `request.started`        | `[forward]` info |
 * | 转发失败    | `forward.error`          | `forwardXxx error` error |
 * | 服务错误    | `server.error`           | `server error (host:port):` error |
 * | 客户端错误  | `server.client-error`    | `[bad-request] client error: …` warn |
 * | 鉴权裁决    | `auth.decided`           | `[auth] allow` debug / `[auth] deny` info |
 * | 开始监听    | `server.listening`       | `listening on host:port` debug |
 * | 停止监听    | `server.closed`          | `server closed` debug |
 * | 管道事实    | `pipe`                   | 按 `type` 落 `[event-code]` / `[route]` |
 * | 配额耗尽（core 直发公共事件） | `usage.quota-exceeded` | `[quota-exceeded]` warn |
 * | 账本写盘失败（runtime 经 `onUsageError` 上报） | `usage.write-error` | `[usage-write-error]` error |
 *
 * 身份维度（`client`/`target`/`user`/`method`）从 `EventEnvelope.context` 读；
 * `method` 由 `core/server/http.ts` 写进 context（payload 只有 `kind`）。
 *
 * `[{kind}] headers` 那行的数据源是 core 侧**已掩码**的 `forward.request-headers` 事件
 * （`maskSensitiveHeaders` 住在 `core/server/http.ts`，掩码在 publish 之前完成，原始凭证不跨
 * 事件总线）。文本格式、debug 等级与 `client`/`target`/`headers`/`user` 四个字段**含顺序**
 * 都是锁死的文本契约。
 *
 * listener **不需要** try/catch：`EventHub` 已隔离单个 listener 的异常并交给 `onListenerError`，
 * 且不会阻断同事件名的其它 listener。
 *
 * ## 日志端口类型为什么是 `Logger` 接口而不是 `LoggerImpl`
 *
 * **不取** `LoggerImpl`：具体类是**容器的选择、不是能力要求**，而本文件对 logger 的全部需求
 * 只有 `debug/info/warn/error`。`Logger` 的这四个签名是 `(...args: unknown[])`——末位 plain
 * object 参数即结构化字段（`log-events.ts` 的 `EventLog` 也是同一个最小面），故本文件全部调用点
 * **在 `Logger` 下逐字成立**。⚠️ **不得因此去 import `LoggerImpl`**（那是 `utils/` 的实现类）。
 *
 * @param hub - 订阅用的总线。**由调用方在绑定那一刻给**（`runtime.ts` 传 `RuntimeContext` 的**当前**
 *   `ctx.events`，与 `CoreEventBridge.attach()` 同一条纪律，见那里注释）。
 * @param logger - 日志端口；`createNoopLogger()` 即零落盘。
 * @returns **幂等**退订函数：调两次不炸、第二次是空转，且**只摘本函数自己挂上去的那些订阅**
 *   （总线上宿主自己的订阅必须原样存活——绝不许图省事改用 `hub.removeAll()`）。
 *   ⚠️ **返回的是自带归属的闭包，不是 `{ hub, subscription }` 那一对**：归属由退订闭包自己携带
 *   （每个 `EventSubscription.dispose()` 靠闭包持有自己的 hub 记录，且全部引用都在闭包内），
 *   换总线也不会退错、也不会被误判归属。
 */
export function bindProxyEventLogs(hub: EventHub, logger: Logger): () => void {
  const subscriptions: EventSubscription[] = [];

  const bind = <K extends EventName>(
    name: K,
    handler: (e: EventEnvelope<K>) => void,
  ): void => {
    subscriptions.push(hub.subscribe(name, handler));
  };

  bind("forward.request-headers", (e) => {
    const { context, data } = e;
    // 锁死的文本契约：同样的 msg、debug 等级、同样四个字段（含顺序）。headers 是 core 侧已掩码好的形态。
    logger.debug(`[${data.kind}] headers`, {
      client: context.client,
      target: context.target ?? "-",
      headers: data.headers,
      user: context.user,
    });
  });
  bind("request.started", (e) => {
    const { context } = e;
    const client = context.client ?? "-";
    const target = context.target ?? "-";
    // 查询维度进结构化字段，msg 只留可读文本，避免 client/target/user 在 msg 里重复
    switch (e.data.kind) {
      case "http":
      case "tunnel":
      case "upgrade": {
        // 三种 kind 仅 method 有差异：tunnel 恒 CONNECT，其余取请求行方法（core 写入 context.method）
        const method = e.data.kind === "tunnel" ? "CONNECT" : (context.method ?? "GET");
        logger.info("[forward]", {
          kind: e.data.kind,
          client,
          target,
          method,
          user: context.user,
        });
        break;
      }
      default: {
        e.data.kind satisfies never;
        break;
      }
    }
  });
  bind("forward.error", (e) => {
    const label = FORWARD_ERROR_LABEL[e.data.kind] ?? "forwardUnknown";
    logger.error(`${label} error`, e.data.error);
  });
  bind("server.error", (e) => {
    const { error, host, port } = e.data;
    logger.error(`server error (${host}:${port}):`, error);
  });
  bind("server.client-error", (e) => {
    logBadRequest(logger, `client error: ${e.data.error.message}`);
  });
  bind("auth.decided", (e) => {
    const { data, context } = e;
    // allow 是逐请求的常规成功（与 [forward] 成功行重复）-> debug；deny 是预期内拒绝，info 留审计
    if (data.passed) {
      logger.debug("[auth] allow", {
        user: data.user ?? context.user,
        client: context.client,
        target: context.target,
        tag: data.tag,
      });
    } else {
      // attempted/reason 进结构化字段（undefined 自动跳过）
      logger.info("[auth] deny", {
        client: context.client,
        target: context.target,
        attempted: data.attempted,
        reason: data.reason,
      });
    }
  });
  bind("server.listening", (e) => {
    logger.debug(`listening on ${e.data.host}:${e.data.port}`);
  });
  // 每用户流量配额耗尽：core 只发布事实（`core/forward/base.ts:publishQuotaExceeded`），
  // 传输侧的硬切（507 / destroy）已由那条路径执行完，这里只落一条 warn。
  // **不走上方的 `pipe` switch**：它是新公共契约（`usage.quota-exceeded`）而不是管道细节，
  // 刻意没往 `PipeEvent` 判别联合里加变体——那会让 14 变体的穷尽清单与两处测试同时要改，
  // 而这条事实本来就不需要「管道上下文」。
  bind("usage.quota-exceeded", (e) => {
    const { data } = e;
    // 文本契约：`[<user>] 配额耗尽 dir=<up|down> usage=<n> limit=<n>`。三个数都要人可读：
    // 运维据此判断「是该扩容（usage≈limit）还是该查这个方向（dir=up/down 占了多少）」。
    // usage / limit 同为**合计**口径（上传 + 下载），所以 dir 只用来答「哪边吃的」，
    // 不用来算差额。
    logQuotaExceeded(
      logger,
      `${data.user} 配额耗尽 dir=${data.dir} usage=${data.usage} limit=${data.limit}`,
      { user: data.user, dir: data.dir, usage: data.usage, limit: data.limit },
    );
  });
  bind("usage.write-error", (e) => {
    // 写盘失败：内存计数继续（配额判定不受影响），未落盘增量留待重试。**error 级**，
    // 且文案里带上「不要为此重启」——重启会把队列里未落盘的增量一起丢掉。
    logUsageWriteError(logger, e.data.path, e.data.error);
  });
  bind("server.closed", () => {
    logger.debug("server closed");
  });
  bind("pipe", (event) => {
    // 载荷即 `PipeEvent` 判别联合原样，下面的 14 变体 switch 是穷尽清单
    const e: PipeEvent = event.data;
    // 该 PipeEvent 上的查询维度统一透传为结构化字段
    const fields = { user: e.user, client: e.client, target: e.target };
    switch (e.type) {
      case "target-unresolved": {
        logTargetUnresolved(logger, e.url as string | undefined, fields);
        break;
      }
      case "loop-detected": {
        const req = e.req as { method?: string; url?: string } | undefined;
        logLoopDetected(
          logger,
          `${req?.method} ${req?.url} -> ${e.target as string}`,
          fields,
        );
        break;
      }
      case "upstream-refused": {
        logUpstreamRefused(logger, e.statusLine as string, fields);
        break;
      }
      case "upstream-error": {
        // 转发层 502 的成因（TLS 校验失败 / ECONNREFUSED / DNS 等）必须落到 warn 级，
        // 否则默认分支的 debug 会把「为什么 502」淹掉
        logUpstreamError(logger, (e.message as string) ?? "upstream error", e.err, fields);
        break;
      }
      case "upstream-timeout": {
        logUpstreamTimeout(logger, (e.message as string) ?? "upstream timeout", fields);
        break;
      }
      case "route": {
        // route 事件与 [route] 行 1:1（core 在 server 模式短路处不发）；字段形态是 jq 契约、勿动
        logger.info("[route]", {
          target: e.target,
          route: e.route,
          ...(e.reason ? { reason: e.reason } : {}),
        });
        break;
      }
      case "ip-denied": {
        logIpDenied(
          logger,
          `${e.protocol as string} 客户端 ${e.client as string} 拒绝 reason=${e.reason as string}`,
          { client: e.client, reason: e.reason, protocol: e.protocol, user: e.user },
        );
        break;
      }
      case "target-denied": {
        // 文本格式：`<target> 拒绝 reason=<reason> source=<global|user>`。
        // `source` 只在判定层给出时追加（手工构造的事件缺它 → 文本与结构化字段都不带 `source`），
        // 结构化字段同步补 `source`：**运维必须能一眼看出该改 acl.json 还是 users.json**，
        // 403 单看 reason 分不出是全局黑名单还是某个用户的个人名单。
        const source = e.source ? ` source=${e.source}` : "";
        logTargetDenied(logger, `${e.target as string} 拒绝 reason=${e.reason as string}${source}`, {
          target: e.target,
          host: e.host,
          reason: e.reason,
          ...(e.source ? { source: e.source } : {}),
          user: e.user,
          client: e.client,
        });
        break;
      }
      case "socks": {
        logger.info(e.message as string, {
          user: e.user,
          client: e.client,
          target: e.target,
        });
        break;
      }
      case "debug": {
        logger.debug(e.message as string);
        break;
      }
      // 拨号守卫与握手畸形类：仅 debug 级留痕，无结构化落盘
      case "dial":
      case "established":
      case "bad-request":
      case "client-error": {
        logger.debug(e.message ?? String(e.type));
        break;
      }
      default: {
        // 判别联合新增变体时在此显式收口：`e satisfies never` 编译期强制补 case，
        // 杜绝新事件被静默吞进兜底分支
        e satisfies never;
        break;
      }
    }
  });

  /**
   * 幂等退订：调两次不炸、第二次是空转。
   *
   * @description 幂等由 `splice(0)` 提供：清空数组之后第二次迭代到的就是空数组，而
   * `EventSubscription.dispose()` 自身也是幂等的，两层各自成立。**不另设 `released` 标志**——
   * 那种重复保险在本文件测不出来（摘掉它行为不变，变异验证记录在
   * `tests/integration/logging/event-binding-runtime.test.ts` 的文件头），见
   * `tests/unit/core/dead-optionality.test.ts` 对死可选性的零容忍。
   *
   * ⚠️ **这里绝不许图省事改用 `hub.removeAll()`**：总线可能属于宿主（`createProxyRuntime({ events })`），
   * 连带清掉别人的订阅就是越权。退订只摘**本函数自己挂上去的那些**。
   */
  return (): void => {
    for (const subscription of subscriptions.splice(0)) {
      try {
        subscription.dispose();
      } catch {
        // 退订失败不应阻断 stop/重试。
      }
    }
  };
}

/**
 * 生命周期跃迁 → `[lifecycle] state …` 那一行（**服务期**那一族绑定的全部）。
 *
 * @description
 * 订阅源是公共 `EventHub` 上的 `lifecycle.changed`——core 的 `BaseProxy.setState` 直接发布它
 * （core 不继承 Node `EventEmitter`），本层**只订阅、不强转**。
 *
 * ## 文本契约：一个字都不许改
 *
 * `[lifecycle] state <prev> -> <next> protocol=<protocol>`，**`debug` 等级、无结构化字段**
 * （三条身份维度一个都不带）。`prev` / `next` 直接取信封里的 `data`——core 那边「相同状态直接
 * return」那条幂等守卫仍然生效，故每次跃迁恰好一行。**CLI 侧与库侧逐字相同**是这一族的目标
 * （`bindProxyEventLogs` 的十几条文本契约同受同一条约束）。
 *
 * ## 与 {@link bindProxyEventLogs} 同文件、同判据、但**独立导出**
 *
 * - **同文件**：本文件的身份就是「EventHub 事实 → 注入的 logger」这一跳，零 `process` 触点、
 *   落盘不拥有进程、同一轮 `activateSubscriptions` / `releaseSubscriptions` 装配与退订——
 *   三条判据逐条相同，两族之间没有可拆的边界。
 * - **独立导出**（不并进 `bindProxyEventLogs`）：本函数**只需要一条订阅**，且要额外吃
 *   `protocol`（来自 runtime 自己的 core 实例）。并进去会让
 *   「11 类代理事实的映射表」这个可读索引被一条服务期事实污染，那张表是 jq / 文本契约的索引，
 *   掺进不相干的一行只会更难核对。**两条退订闭包在 `runtime.ts` 的同一轮里各自装配与释放**，
 *   生命周期归属仍然只有一个权威。
 *
 * @param hub - 订阅用的总线，**由调用方在绑定那一刻给**（`runtime.ts` 传 `RuntimeContext` 的**当前**
 *   `ctx.events`，与 `CoreEventBridge.attach()` / `bindProxyEventLogs` 同一条纪律）。
 * @param logger - 日志端口；`createNoopLogger()` 即零落盘。
 * @param protocol - 进 `protocol=` 那段的值，**由调用方从 runtime 自己的 core 实例取**
 *   （`this.proxy.protocol`），不另配一份、也不从配置重读。
 * @returns **幂等**退订函数，归属由闭包自己携带（与 `bindProxyEventLogs` 同一形态，理由见上）。
 */
export function bindLifecycleLog(
  hub: EventHub,
  logger: Logger,
  protocol: ProxyProtocol,
): () => void {
  const subscription = hub.subscribe("lifecycle.changed", ({ data }) => {
    logger.debug(`[lifecycle] state ${data.prev} -> ${data.next} protocol=${protocol}`);
  });
  return (): void => {
    try {
      subscription.dispose();
    } catch {
      // 退订失败不应阻断 stop/重试（与 `bindProxyEventLogs` 的退订闭包同一纪律）。
    }
  };
}
