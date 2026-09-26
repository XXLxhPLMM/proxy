import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { PassThrough, type Duplex } from "node:stream";
import { Dialer } from "@/core/forward/upstream/dial.js";
import { HttpConnectConnector, Socks4Connector, Socks5Connector } from "@/core/forward/upstream/connector/index.js";
// 共享基类是连接器层内部件（刻意不进 barrel），测试按深路径直引
import { SocksUpstreamConnector } from "@/core/forward/upstream/connector/socks-upstream.js";
import { restoreConfig, set, snapshotConfig, testContext } from "../helpers/config.js";

/**
 * 传输层 / 协议层的**职责边界**护栏（「零例外」）
 *
 * 抽象建起来之后最容易出的事，是「实现没跟上抽象」：连接器只剩薄委托，真实现还躺在
 * `forward/upstream/dial.ts` 里。那样一回事，想读「我们怎么做 SOCKS5 上游」的人去 `upstream/connector/socks5.ts`
 * 找不到东西，得翻到 `upstream/dial.ts`——**可发现性极差**。
 *
 * 本文件把这个边界钉成可执行断言，分两侧：
 * - **负向**：`Dialer` 上不得再出现任何「按协议拨号/握手」的入口，且**去注释后的源码文本
 *   里连协议词汇都不许有**（防止有人把协议实现塞回传输层，或换个名字重新长出来）。
 *   2c 把最后两个漏洞也收掉了：① `readReply` 及其两条带 SOCKS 字样的报错文案从 `Dialer`
 *   搬进 `SocksUpstreamConnector`；② upgrade 通道的有效 client 模式改走
 *   `connector.transport()`。现在**零例外**。
 * - **正向**：那几个协议实现确实住在各自的连接器里（防止反向搬家——把实现从连接器
 *   挪回 `Dialer` 同样破坏这条不变量）。
 *
 * `readReply` 的可见性由编译期锁定：`connector/socks4.ts` / `socks5.ts` 经
 * `this.readReply(...)` 调它（基类的 `protected`），`pnpm typecheck` 会在它被改回
 * `private`、或从基类挪走时变红。
 */

/** 搬迁后 `Dialer` 的 public 方法清单（有序比较，防漂移） */
const PUBLIC_METHODS = ["bridge", "choose", "dialDirect", "dialTls"];

/**
 * `Dialer.prototype` 上应存在的**全部**自有方法名（含 `constructor` 与 private `dialWith`）
 *
 * @description
 * 刻意做成闭集：新增任何一个方法（含新增协议方法）都会让这条变红，
 * 逼改动者显式更新本清单并在评审里说明——这正是「职责不许悄悄回流」的可执行形式。
 * 2c 起 `readReply` 不在其中（它随 SOCKS 握手搬去了 `SocksUpstreamConnector`）。
 */
const OWN_METHODS = ["bridge", "choose", "constructor", "dialDirect", "dialTls", "dialWith"];

/** 搬迁走的那些方法名：一个都不许留在传输层 */
const MOVED_OUT = [
  "dialSocks",
  "dialViaHttpUpstream",
  "handshakeSocks",
  "handshakeSocks4",
  "handshakeSocks5",
  "withUpstreamDial",
  "readConnectReply",
  "readReply",
];

/** `readReply` 的两条报错文案：**落盘日志文本的一部分，逐字不可改**（2c 只搬位置不改文案） */
const SOCKS_REPLY_ERRORS = ["socks upstream closed before reply", "socks reply timeout"];

/** Node 传输 API：`net.connect` / `tls.connect` 是「建链」，不是上游协议词汇，断言前先遮蔽 */
const NODE_TRANSPORT_API = /\b(?:net|tls)\.connect\b|\bsecureConnect\b/g;

/** 协议词汇表：只有 SOCKS 与 CONNECT 两种上游协议（见 `registry.ts:PROTOCOL_FACTORIES`） */
const PROTOCOL_WORDS = /socks|connect/i;

/** 取 prototype 上的自有方法名（不含继承链） */
const ownNames = (proto: object): string[] => Object.getOwnPropertyNames(proto).sort();

/**
 * 去掉注释、只留「代码 + 字符串字面量」
 *
 * @description
 * **只去注释、不去字符串字面量**：字符串字面量正是本护栏要盯的东西——`readReply` 的两条
 * 报错文案就住在那里，它们是「传输层却知道协议名」唯一真实的泄漏形态（2c 之前的事实）。
 *
 * 反过来，注释里出现协议名是**在描述这条不变量本身**（文件头不得不点名自己禁止什么），
 * 若把注释也纳入断言，这条断言就自我否定、只能靠删文档来过——那是拿护栏换文档，两头都亏。
 *
 * 单趟状态机：识别 `'` / `"` / 反引号三种字符串（含反斜杠转义）与行注释、块注释，
 * 注释逐字符换空格、换行原样保留（行号不漂移，失败时给出的行仍对得上原文）。
 * 已知边界：本仓 `forward/upstream/dial.ts` 与 `connector/` 下的连接器源码都无正则字面量；
 * 若将来引入含引号的正则字面量，切分会失准——那时失败输出会直接把原文贴出来，人眼一看就知道。
 */
function codeOnly(source: string): string {
  const out: string[] = [];
  let i = 0;

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") {
        out.push(" ");
        i++;
      }

      continue;
    }

    if (ch === "/" && next === "*") {
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        out.push(source[i] === "\n" ? "\n" : " ");
        i++;
      }

      out.push("  ");
      i += 2;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      out.push(ch);
      i++;

      while (i < source.length && source[i] !== ch) {
        if (source[i] === "\\") {
          out.push(source[i]);
          out.push(source[i + 1] ?? " ");
          i += 2;
          continue;
        }

        out.push(source[i]);
        i++;
      }

      out.push(ch);
      i++;
      continue;
    }

    out.push(ch);
    i++;
  }

  return out.join("");
}

/** 命中的那几行（失败时把原文贴出来，省得人去猜是哪一行） */
function offendingLines(text: string, re: RegExp): string[] {
  return text
    .split("\n")
    .map((line, i) => ({ line, no: i + 1 }))
    .filter(({ line }) => re.test(line))
    .map(({ no, line }) => `${no}: ${line.trim()}`);
}

/** 借原型取 protected 的 `readReply`（运行期它就是基类原型上的方法；只为断言其行为） */
function callReadReply(
  connector: SocksUpstreamConnector,
  sock: Duplex,
  n: number,
): Promise<Buffer> {
  return (
    SocksUpstreamConnector.prototype as unknown as {
      readReply(s: Duplex, bytes: number): Promise<Buffer>;
    }
  ).readReply.call(connector, sock, n);
}

/** 四个 channel 转发器：控制流一律只看连接器的声明式数据（`kind`/`targetForm`/`peerTarget()`） */
/** 四个 channel 转发器：`forward/channel/` 下的四条入站通道 */
const CHANNEL_FILES = ["http.ts", "tunnel.ts", "upgrade.ts", "socks.ts"];

/** `src/core/forward/` 下某个文件的原文（按轴分目录：`channel/` 与 `upstream/`） */
function forwardSourceOf(...segments: string[]): string {
  return fs.readFileSync(path.join(__dirname, "..", "..", "src", "core", "forward", ...segments), "utf8");
}

/**
 * channel 侧被禁的三个协议判据 helper
 *
 * @description
 * 三者的作用**只有一个**：从 `upstreamProtocol` 二次推导「这条链路是哪一版/哪种承载」。
 * 那正是连接器层要消灭的第二真相源——`connector.kind` 已经是这个事实的声明
 * （`sockss4` 的 kind 就是 `socks4`、`https` 的 kind 就是 `https`）。
 * 2b-2a 起 `http.ts` 零命中，2c 起 `websocket.ts` 零命中，**2d 收掉 websocket 的 socks
 * 早分支与 `socks.ts` 的日志二次推导后四个 channel 全部零命中**。
 */
const CHANNEL_PROTOCOL_CALLS = /\b(?:isSocksProto|socksVersionOf|isTlsUpstreamProto)\b/;

/**
 * 某段代码里该正则的**命中行数**
 *
 * @description 逐行 `test`，故传入的正则**必须不带 `g`**：带 `g` 时 `test` 有状态
 * （`lastIndex` 会跨行推进，某行未命中还会把它复位成 0），「出现两处」会被数成一处。
 */
function countLines(text: string, re: RegExp): number {
  expect(re.global, "countLines 传入的正则不得带 g 标志（见本函数注释）").toBe(false);

  return text.split("\n").filter((line) => re.test(line)).length;
}

describe("core/forward/upstream/dial 只做传输层（负向：协议实现不得回流）", () => {
  it("Dialer.prototype 上没有 dialSocks / dialViaHttpUpstream / handshakeSocks* / readReply", () => {
    const names = ownNames(Dialer.prototype);

    for (const gone of MOVED_OUT) {
      expect(names, `Dialer 不得再持有 ${gone}：上游协议实现只住在 connector/<协议>.ts`).not.toContain(
        gone,
      );
    }
  });

  it("Dialer.prototype 的方法集合恰为「建链 + 桥接」闭集（2c 起 readReply 已搬走）", () => {
    expect(ownNames(Dialer.prototype)).toEqual(OWN_METHODS);
  });

  it("保留的 public 方法齐在（bridge / dialDirect / dialTls / choose）", () => {
    for (const name of PUBLIC_METHODS) {
      expect(typeof Dialer.prototype[name as keyof Dialer], `${name} 必须是可调用的 public 方法`).toBe(
        "function",
      );
    }
  });

  it("没有任何方法名带 SOCKS / CONNECT 协议词汇（换个名字长出来也拦住）", () => {
    // 只认「协议名出现在方法名里」这一种回流形态：dialSocks / socksHandshake / connectViaHttp…
    const suspicious = ownNames(Dialer.prototype).filter((n) => /socks|connect/i.test(n));

    // 已知例外：dialWith/choose/dialDirect 这类纯建链方法不含协议词汇，故此处应恒为空
    expect(suspicious).toEqual([]);
  });

  it("dial.ts 的代码与字符串字面量里零协议词汇（源码级负向断言：换个位置/名字也拦住）", () => {
    // 遮蔽 Node 传输 API 后逐行查：net.connect / tls.connect 是「建链」，不是上游协议词汇
    const text = codeOnly(forwardSourceOf("upstream", "dial.ts")).replace(NODE_TRANSPORT_API, "<nodeTransportAPI>");
    const hits = offendingLines(text, PROTOCOL_WORDS);

    expect(
      hits,
      "dial.ts 是纯传输层：代码与字符串字面量里都不许出现 SOCKS / CONNECT 协议词汇"
        + "（2c 之前 readReply 的两条报错文案就是靠这条缝漏进来的）",
    ).toEqual([]);
  });

  it("两条握手报错文案在 dial.ts 里零命中（含注释：它们整个搬走了，不是搬走又留个注释提及）", () => {
    const raw = forwardSourceOf("upstream", "dial.ts");

    for (const msg of SOCKS_REPLY_ERRORS) {
      expect(raw.includes(msg), `dial.ts 不得再出现「${msg}」`).toBe(false);
    }
  });
});

describe("core/forward/upstream/connector 各自持有协议实现（正向：实现真在连接器里）", () => {
  it("SOCKS4 握手体在 Socks4Connector、SOCKS5 握手体与 CONNECT 应答解析在 Socks5Connector", () => {
    expect(ownNames(Socks4Connector.prototype)).toContain("handshake");
    expect(ownNames(Socks5Connector.prototype)).toContain("handshake");
    expect(ownNames(Socks5Connector.prototype)).toContain("readConnectReply");
  });

  it("HTTP CONNECT 协议实现（拨上游→发 CONNECT→等状态行）在 HttpConnectConnector", () => {
    expect(ownNames(HttpConnectConnector.prototype)).toContain("connectViaUpstream");
  });

  it("SOCKS 拨号外壳只有基类一份（两版子类都不许各抄一遍）", () => {
    expect(ownNames(SocksUpstreamConnector.prototype)).toContain("dialViaSocks");

    for (const sub of [Socks4Connector, Socks5Connector] as const) {
      expect(
        ownNames(sub.prototype),
        `${sub.name} 不许自带 dialViaSocks 副本（白名单→拨号→握手的外壳只有基类一份）`,
      ).not.toContain("dialViaSocks");
    }
  });

  it("握手应答读取器 readReply 住在 SOCKS 基类一份（只有 SOCKS 握手用它）", () => {
    expect(ownNames(SocksUpstreamConnector.prototype)).toContain("readReply");
    expect(ownNames(Dialer.prototype)).not.toContain("readReply");

    for (const sub of [Socks4Connector, Socks5Connector] as const) {
      expect(
        ownNames(sub.prototype),
        `${sub.name} 不许自带 readReply 副本（只有基类一份；带协议文案的原语不能两处各写一遍）`,
      ).not.toContain("readReply");
    }
  });
});

describe("readReply 的两条报错文案（落盘日志文本，逐字不可改）", () => {
  it("两条文案逐字住在 SocksUpstreamConnector 源码里（2c 只搬位置、不动一个字）", () => {
    const base = forwardSourceOf("upstream", "connector", "socks-upstream.ts");

    for (const msg of SOCKS_REPLY_ERRORS) {
      expect(
        base.includes(`new Error("${msg}")`),
        `socks-upstream.ts 里的报错文案必须逐字是 ${JSON.stringify(msg)}（它经 channel 的 catch 进落盘日志）`,
      ).toBe(true);
    }
  });

  it("对端提前关闭 → reject「socks upstream closed before reply」（行为面，不只是文本）", async () => {
    const connector = new Socks4Connector(testContext, false);
    const sock = new PassThrough();
    const pending = callReadReply(connector, sock, 2);

    sock.destroy();
    await expect(pending).rejects.toThrow(SOCKS_REPLY_ERRORS[0]);
  });

  it("沉默上游 → 按 upstreamTimeout 兜底报「socks reply timeout」并销毁 socket", async () => {
    const snap = snapshotConfig(["upstreamTimeout"]);

    try {
      set("upstreamTimeout", 20);
      const connector = new Socks4Connector(testContext, false);
      const sock = new PassThrough();
      const pending = callReadReply(connector, sock, 2);

      await expect(pending).rejects.toThrow(SOCKS_REPLY_ERRORS[1]);
      expect(sock.destroyed, "读超时必须销毁已建链的上游（否则连接挂在守卫之外）").toBe(true);
    } finally {
      restoreConfig(snap);
    }
  });
});

/**
 * 四个 channel 转发器里**零协议判据**（负向：控制流只看 `connector` 的声明式数据）
 *
 * @description
 * 与上面「`Dialer` 零协议词汇」是同一条不变量的**另一半**：抽象建好之后，channel 侧
 * 同样不许再从 `upstreamProtocol` 二次推导协议身份。历史上四个 channel 各写一份
 * `isSocksProto(proto) ? … : isTlsUpstreamProto(proto) ? … : …` 的四连分支，
 * 2b-2a（http）、2c（websocket 的 client 档）、**2d（websocket 的 socks 早分支 +
 * `socks.ts` 的日志文案版本号）** 逐个收掉，现在四个文件全部零命中。
 *
 * **口径与 `dial.ts` 那条逐字一致**：读原文 → 单趟去注释、留代码与字符串字面量 → 逐行匹配。
 * **只去注释、不去字符串**：这三个名字是**标识符**不是文案，字符串里出现它们只可能是
 * 拼错；而注释里点名它们是**在描述这条不变量本身**（文件头不得不说自己不再用什么），
 * 把注释纳入断言就成了自我否定、只能靠删文档来过——与 `dial.ts` 那条同一条理由。
 *
 * **已用变异测试验证**：往任一 channel 文件里放回一句 `isSocksProto(` / `socksVersionOf(` /
 * `isTlsUpstreamProto(` → 下一条立刻变红。
 */
describe("core/forward/channel/{http,tunnel,upgrade,socks} 零协议判据（负向：控制流只看 connector）", () => {
  it("四个 channel 转发器的代码与字符串字面量里零协议判据 helper", () => {
    for (const file of CHANNEL_FILES) {
      const hits = offendingLines(codeOnly(forwardSourceOf("channel", file)), CHANNEL_PROTOCOL_CALLS);

      expect(
        hits,
        `${file} 是 channel：协议身份只能来自 connector.kind（registry 构造期钉死），`
          + "不许再从 upstreamProtocol 二次推导 isSocksProto/socksVersionOf/isTlsUpstreamProto",
      ).toEqual([]);
    }
  });

  it("护栏不是空跑：四个文件都真的经基类 connectorForRoute 选上游，且源码非空", () => {
    for (const file of CHANNEL_FILES) {
      const code = codeOnly(forwardSourceOf("channel", file));

      expect(code.length, `${file} 源码读到了吗（路径写错会让上面的负向断言假绿）`)
        .toBeGreaterThan(2000);
      // 选连接器这件事已收进基类（`ForwarderBase.connectorForRoute`），故这里的正向判据
      // 从「直接调 connectorFor/directConnector」改成「经基类这一个入口」。
      // ⚠️ `connectorFor` / `directConnector` 是**已删除**的符号（端口化时整体没了），
      // 所以它们**只能**出现在这类历史叙述里，绝不能拿去当断言锚点——锚在已删除的符号上
      // 会让断言恒真（教训见 `tests/AGENTS.md`）。与之配对的负向面在
      // `unit/forward-directory-layout.test.ts`，锚点是**今天仍存在**的形状
      // （`this.connectors.` / `createConnectorSource(` / `new *Connector` / 连接器层值导入）。
      // **不能**因此放松成「什么都行」——它仍必须指名那个入口。
      expect(
        /connectorForRoute/.test(code),
        `${file} 必须经 forward/base.ts:connectorForRoute 选上游（否则本档整体失去意义）`,
      ).toBe(true);
    }
  });

  it("upgrade 是单一路径：不再裸读 proxyMode（2d 删掉了最后一处上游协议分支）", () => {
    const code = codeOnly(forwardSourceOf("channel", "upgrade.ts"));

    expect(
      code,
      'upgrade.ts 必须只用 resolveForwardTargets 给出的有效路由，不许再 get("proxyMode")',
    ).not.toMatch(/get\("proxyMode"\)/);
    // emitRoute 恰好一处 = 「每请求恰发一条 route 事件」的源码级对应
    expect(
      countLines(code, /this\.emitRoute\(/),
      "upgrade.ts 只许有一处 emitRoute（多一处就会让同一请求发两条 route）",
    ).toBe(1);
    // 守卫仍要判两次：①有效拨号地址（client 模式即上游）+ ③传输对端 ≠ ①时的补判
    // （后者现在住在基类 `preDialPeerTarget`，故 upgrade.ts 只**直接**调一次；见下面两档）
    expect(
      countLines(code, /this\.preDial\(/),
      "upgrade.ts 直接调 preDial 恰好一处：①有效拨号地址（③已收进基类 preDialPeerTarget）",
    ).toBe(1);
    expect(
      countLines(code, /this\.preDialPeerTarget\(/),
      "upgrade.ts 必须经 preDialPeerTarget 补判传输对端（短路它 = 一个真实的自环漏洞）",
    ).toBe(1);
    // ⚠️ 私有方法 `viaSocks` **不许回来**：它内部那份 resolveRoute/preDial/emitRoute
    // 会重复发事件（同一请求两条 `route`）。这条是「负向守卫」，不是「去找那段代码」。
    expect(code, "viaSocks 不许回来（它内部的路由判定/守卫/路由事件是重复的第二份）").not.toMatch(
      /viaSocks\s*\(/,
    );
  });

  it("socks.ts 的日志文案版本号取自 connector.kind，不再从 upstreamProtocol 推导", () => {
    const code = codeOnly(forwardSourceOf("channel", "socks.ts"));

    expect(
      code,
      "socks.ts 的 SOCKS 上游版本号必须取自 connector.kind（kind 即身份），不得二次推导",
    ).not.toMatch(/socksVersionOf/);
    expect(
      code,
      "`(socks${ver}->socks${version})` 那句文案的版本号来源要钉在 connector.kind 上",
    ).toMatch(/connector\.kind === "socks4" \? 4 : 5/);
    // 文案逐字不可改（它进落盘日志）
    expect(code, "日志文案逐字不可改").toContain("tunnel via socks upstream ${host}:${port}");
  });
});
