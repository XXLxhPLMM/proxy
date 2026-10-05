/**
 * 传输层 / 协议层的**职责边界**：`Dialer` 上不得再出现任何「按协议拨号/握手」的入口
 *
 * @description
 * 本档分两侧钉这条边界：负向 = `Dialer.prototype` 上零协议方法、且**去注释后的源码文本**里连
 * 协议词汇都不许有；正向 = 那几个协议实现确实住在各自的连接器里（防反向搬家）。决策 ①②
 * （协议实现的住处、`readReply` 与两条文案为什么归 SOCKS 基类、`codeOnly` 的口径）与路径纪律
 * 在 `AGENTS.md`；那两条文案的文本面与行为面在 `./socks-reply-text.test.ts`，channel 那一侧
 * （同一不变量的另一半）在 `../channel/no-protocol-branch.test.ts`。
 */
import { describe, expect, it } from "vitest";
import { Dialer } from "@/core/forward/upstream/dial.js";
import {
  HttpConnectConnector,
  Socks4Connector,
  Socks5Connector,
} from "@/core/forward/upstream/connector/index.js";
// 共享基类是连接器层内部件（刻意不进 barrel），测试按深路径直引
import { SocksUpstreamConnector } from "@/core/forward/upstream/connector/socks-upstream.js";
import { SOCKS_REPLY_ERRORS, forwardSourceOf } from "./_dialer-protocol-boundary.js";

/** 搬迁后 `Dialer` 的 public 方法清单（有序比较，防漂移） */
const PUBLIC_METHODS = ["bridge", "choose", "dialDirect", "dialTls"];

/**
 * `Dialer.prototype` 上应存在的**全部**自有方法名（含 `constructor` 与 private `dialWith`）
 *
 * @description
 * 刻意做成闭集：新增任何一个方法（含新增协议方法）都会让这条变红，
 * 逼改动者显式更新本清单并在评审里说明——这正是「职责不许悄悄回流」的可执行形式。
 * `readReply` 不在其中：它随 SOCKS 握手住在 `SocksUpstreamConnector` 基类。
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
 * 报错文案就住在那里，它们是「传输层却知道协议名」唯一真实的泄漏形态。
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
