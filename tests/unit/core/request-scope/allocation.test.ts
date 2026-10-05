import { describe, expect, it } from "vitest";
import { blockAfter, codeOf, offendingLines } from "../../../helpers/source-scan.js";

/**
 * 转发器的**分配点**：四个转发器在**服务构造期**一次组装好、跨请求复用，请求期只调它们的方法。
 *
 * 本档锁**源码面**：请求路径里根本**没有** `new XxxForwarder` 这个写法可写。运行期那一半在
 * `tests/integration/forward/`（同一实例被复用 N 次）；⚠️ 两条都要 —— 只锁运行期则「把构造挪回请求
 * 路径、但恰好没被那些用例走到」不红，只锁源码则挡不住「换个写法」（比如经工厂函数间接 new）。
 * ⚠️ 负向锚点纪律与逐条自查表见 `AGENTS.md`；`RequestScope` 存在理由的防删护栏在 `assembly.test.ts`。
 */

const FORWARDERS = "HttpForwarder|TunnelForwarder|WsForwarder|SocksForwarder";

/** 整个转发器层里**任何** `new XxxForwarder`（含跨文件引用） */
const NEW_FORWARDER = new RegExp(`new\\s+(?:${FORWARDERS})\\b`);

/** 四个转发器实现文件 + 它们的基类（`forward/` 根，按「入站通道」轴住在 `channel/`） */
const FORWARDER_FILES = [
  ["core", "forward", "base.ts"],
  ["core", "forward", "channel", "http.ts"],
  ["core", "forward", "channel", "tunnel.ts"],
  ["core", "forward", "channel", "upgrade.ts"],
  ["core", "forward", "channel", "socks.ts"],
] as const;

/** 四个入站通道（`FORWARDER_FILES` 里除基类之外的那四个） */
const CHANNEL_FILES = FORWARDER_FILES.filter((f) => f[2] === "channel");

/** 四个通道构造签名的**逐字**契约（`BaseProxy` 侧另有 `createProxy` 的装配点，不在此列） */
const EXPECTED_CTOR_PARAMS = "ctx: CoreContext, services: CoreServices, connectors: ConnectorSource";

/** 逐请求身份三件（铁律：绝不存成实例字段，只经 `RequestScope` 参数逐次传入） */
const IDENTITY_FIELDS = ["user", "requestId", "connectionId"] as const;

/**
 * 「逐请求身份被存成实例字段」的**两种真实形态**。
 *
 * @description
 * ① `IDENTITY_FIELD_DECL`：带可见性修饰符的字段声明（`protected readonly user: string;`）。
 *    本仓的类字段一律带显式修饰符（实测 `forward/base.ts` 的 `dialer`/`services`/`connectors`、
 *    `server/http.ts` 的 `httpForwarder`/`channels`…），所以这个形状覆盖全部真实写法；
 *    下方「防假绿的正向面」把这条前提也钉住了。
 * ② `IDENTITY_THIS_READ`：经 `this` 读一个逐请求身份。字段必须先声明才读得到，
 *    所以 ① + ② 合起来没有漏网的第三种形态。
 *
 * ⚠️ **刻意不用「已删符号名」当锚**（那是本仓最危险的一类假绿，规则见 `AGENTS.md`）。
 */
const IDENTITY_FIELD_DECL = new RegExp(
  `\\b(?:public|private|protected)\\s+(?:readonly\\s+)?(?:${IDENTITY_FIELDS.join("|")})\\b`,
);
const IDENTITY_THIS_READ = new RegExp(`\\bthis\\s*\\.\\s*(?:${IDENTITY_FIELDS.join("|")})\\b`);

/**
 * 取 `anchor(` 之后到**配对**右括号之间的形参列表（跨行安全）。
 *
 * @description 另有一份刻意保留的同手法拷贝（`dialer-protocol-boundary` 与
 * `../dead-optionality.test.ts`），这里只服务本档、故就地实现。
 * 调用方必须传**已去注释**的文本（`codeOf`）。锚点不存在时抛错——结构变了要显式改护栏，
 * 不能让断言安静地变成空断言。
 */
function paramsOf(code: string, anchor: string): string {
  const at = code.indexOf(anchor);
  if (at < 0) {
    throw new Error(`源码里找不到锚点：${JSON.stringify(anchor)}（结构变了，护栏需显式更新）`);
  }
  let depth = 1;
  let i = at + anchor.length;
  while (i < code.length && depth > 0) {
    if (code[i] === "(") {
      depth++;
    } else if (code[i] === ")") {
      depth--;
    }
    i++;
  }
  return code.slice(at + anchor.length, i - 1).trim();
}

/** 服务层里**请求路径**的代码块锚点（构造函数之外的一切） */
const REQUEST_PATH_BLOCKS: readonly { file: readonly string[]; anchor: string; label: string }[] = [
  { file: ["core", "server", "http.ts"], anchor: 'server.on("request"', label: "HttpProxy 的 request 回调" },
  { file: ["core", "server", "http.ts"], anchor: 'server.on("connect"', label: "HttpProxy 的 connect 回调" },
  { file: ["core", "server", "http.ts"], anchor: 'server.on("upgrade"', label: "HttpProxy 的 upgrade 回调" },
  { file: ["core", "server", "http.ts"], anchor: "private async handleForward(", label: "HttpProxy.handleForward" },
  { file: ["core", "server", "socks-base.ts"], anchor: "private async onConn(", label: "SocksProxyBase.onConn" },
  { file: ["core", "server", "socks-session.ts"], anchor: "export async function runSocks4Session(", label: "runSocks4Session" },
  { file: ["core", "server", "socks-session.ts"], anchor: "export async function runSocks5Session(", label: "runSocks5Session" },
];

describe("core/forward + core/server：请求路径零 new 转发器（源码级负向断言）", () => {
  it("四个转发器实现文件里零 `new XxxForwarder`", () => {
    for (const file of FORWARDER_FILES) {
      const text = codeOf(...file);

      expect(
        offendingLines(text, NEW_FORWARDER),
        `${file.join("/")} 是转发器实现：转发器之间互不实例化（组装只发生在服务构造期）`,
      ).toEqual([]);
    }
  });

  it("请求路径的每一个代码块里零 `new XxxForwarder`（三个 server 回调 + handleForward + onConn + 两个会话处理器）", () => {
    for (const { file, anchor, label } of REQUEST_PATH_BLOCKS) {
      const body = blockAfter(codeOf(...file), anchor);

      expect(
        offendingLines(body, NEW_FORWARDER),
        `${label} 是请求路径：不得实例化转发器（逐请求数据一律经 RequestScope 传入）`,
      ).toEqual([]);
    }
  });

  it("四个通道的构造签名恰好三件套（逐请求事件槽不再有第二个入口）", () => {
    // ⚠️ 锚点必须是**今天仍存在的形状**：锚在一个已删符号上时，它在 `src/**` 的唯一命中很可能
    // 是注释，`codeOnly` 剥掉后恒为零命中、不锁任何东西。这里的锚是四个通道的**构造签名**
    // 逐字只有三件套 —— 「没有第四个形参」正是「逐请求的事件槽不可能又从构造期进来」的
    // **唯一**可自动检查形态。
    for (const file of CHANNEL_FILES) {
      const label = file.join("/");
      const params = paramsOf(codeOf(...file), "constructor(");

      // 防假绿的正向面：逐字锁死三件套。多一个形参（事件槽、terminal、per-request 闭包…）立刻红；
      // 少一个也红（那说明有人把某件必填依赖挪走了，只会让「构造期组装」这条不变式悄悄变形）
      expect(params, `${label} 的构造签名必须逐字是 (ctx, services, connectors)`).toBe(
        EXPECTED_CTOR_PARAMS,
      );
      // 第二道：即便将来签名被有意改写，形参名也不许出现事件槽那三种形态
      expect(
        params,
        `${label} 的构造签名不许出现逐请求事件槽（sink / onEvent / emit）：`
          + "事件出口只经 RequestScope 逐请求传入",
      ).not.toMatch(/\b(?:sink|onEvent|emit)\b/);
    }
  });

  it("四个通道都还在用 `scope: RequestScope` 收逐请求数据（正向面：上面那条不是空断言）", () => {
    // 没有这一条，上一条可能因为「四个通道文件被清空 / 改名 / 路径写错」而恒绿。
    // 判据是**真实存在的入参形态**（`scope: RequestScope`），不是任何符号名。
    for (const file of CHANNEL_FILES) {
      const label = file.join("/");
      const code = codeOf(...file);

      expect(
        offendingLines(code, /\bscope:\s*RequestScope\b/),
        `${label} 必须仍以 scope: RequestScope 逐请求收身份与事件出口`
          + "（改动这一项前先读 tests/unit/core/request-scope/AGENTS.md 的铁律）",
      ).not.toEqual([]);
      // `RequestScope` 只 type-only 引：逐请求值对象不该有运行期依赖边
      expect(code, `${label} 对 RequestScope 只许 type-only 引用`).toMatch(
        /import\s+type\s+\{[^}]*RequestScope/,
      );
    }
  });

  it("ForwarderBase 与四个子类上零 `user`/`requestId`/`connectionId` 实例字段", () => {
    // 标题与实现必须对齐：扫的范围就是 `FORWARDER_FILES`（基类 + 四个子类），锚点是这条铁律
    // **今天真实的两种形态**。锚点写成一个已删符号名时，它的命中会全落在注释里，
    // `codeOnly` 之后恒为零命中——**范围比标题窄 + 锚点已死**两个毛病会叠在一起。
    //
    // 为什么这两种形态就够了：「把逐请求身份存成实例字段」这件事在源码上**只**有两种表现——
    // ① 声明字段（`protected readonly user: string | undefined;`），
    // ② 经 `this` 读它（`this.user`）。没有第三种：字段必须先声明才读得到。
    // 逐请求的**正确**形态（`scope.user` / `preDial` 形参 `user` / `openTunnelMeter` 的
    // `scope.user` 实参）刻意不在这两条判据里——它们是**局部**数据，本来就该活一次。
    for (const file of FORWARDER_FILES) {
      const label = file.join("/");
      const code = codeOf(...file);

      expect(
        offendingLines(code, IDENTITY_FIELD_DECL),
        `${label} 不得声明 ${IDENTITY_FIELDS.join("/")} 实例字段：`
          + "四个转发器实例跨请求/跨会话复用，逐请求身份存字段就是「A 的请求记到 B 头上」的串号雷",
      ).toEqual([]);
      expect(
        offendingLines(code, IDENTITY_THIS_READ),
        `${label} 不得经 this 读 ${IDENTITY_FIELDS.join("/")}：`
          + "逐请求身份只经 RequestScope 参数进来（scope.user）",
      ).toEqual([]);
    }

    // 防假绿的正向面：两条判据的正则在**同一批文件**上确实能命中同形态的其它字段
    // （`dialer` / `services` / `connectors`）。若哪天源码风格变了（字段不再带修饰符），
    // 这三条会一起红，而不是安静地变成三条空断言。
    const base = codeOf("core", "forward", "base.ts");
    for (const name of ["dialer", "services", "connectors"] as const) {
      expect(
        offendingLines(base, new RegExp(`\\bprotected\\s+readonly\\s+${name}\\b`)),
        `锚点失效：forward/base.ts 上不再有 protected readonly ${name} 字段，`
          + "IDENTITY_FIELD_DECL 的形状已对不上今天的源码",
      ).toHaveLength(1);
    }
    expect(
      offendingLines(base, /\bthis\s*\.\s*services\b/),
      "锚点失效：forward/base.ts 上不再有 this.services 读取，IDENTITY_THIS_READ 的形状已对不上今天的源码",
    ).not.toEqual([]);
  });
});

describe("服务层组装点：构造次数与请求数无关（静态计数）", () => {
  it("HttpProxy 恰好 new 三个转发器（各一次），且都在构造函数体内", () => {
    const code = codeOf("core", "server", "http.ts");
    const ctor = blockAfter(code, "constructor(options: ProxyOptions");

    for (const name of ["HttpForwarder", "TunnelForwarder", "WsForwarder"]) {
      const total = offendingLines(code, new RegExp(`new\\s+${name}\\b`));
      const inCtor = offendingLines(ctor, new RegExp(`new\\s+${name}\\b`));

      expect(total, `${name} 在 http.ts 里只允许出现一次构造`).toHaveLength(1);
      expect(inCtor, `${name} 的唯一构造点必须在 HttpProxy 构造函数体内`).toHaveLength(1);
    }
  });

  it("SocksForwarder 全仓只被 SocksProxyBase 构造一次，且在字段初始化器里", () => {
    const socksBase = codeOf("core", "server", "socks-base.ts");
    const forwarders = codeOf("core", "forward", "channel", "socks.ts");

    expect(
      offendingLines(socksBase, /new\s+SocksForwarder\b/),
      "SocksForwarder 只能在 SocksProxyBase 构造一次（跨会话共享单例）",
    ).toHaveLength(1);
    expect(
      offendingLines(forwarders, /new\s+SocksForwarder\b/),
      "socks.ts 是实现文件，不许自己实例化自己",
    ).toEqual([]);
  });

  it("服务层合计恰好 4 个构造点（3 + 1），与请求数、连接数都无关", () => {
    const total = [
      ...offendingLines(codeOf("core", "server", "http.ts"), NEW_FORWARDER),
      ...offendingLines(codeOf("core", "server", "socks-base.ts"), NEW_FORWARDER),
    ];

    expect(
      total,
      "服务层只允许有这 4 个转发器构造点；多一个就意味着又有人在请求路径里 new",
    ).toHaveLength(4);
  });
});