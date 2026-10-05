/**
 * `core/forward/channel/{http,tunnel,upgrade,socks}` **零协议判据**：控制流只看连接器的声明式数据
 *
 * @description
 * 与 `../upstream/dial-boundary.test.ts` 的「`Dialer` 零协议词汇」是**同一条不变量的另一半**：
 * 三个被禁 helper 的作用**只有一个**（从 `upstreamProtocol` 二次推导协议身份），判据覆盖哪几个
 * 文件与「口径与 `dial.ts` 那条逐字一致」的理由在 `AGENTS.md`，读源码那一面走
 * `../upstream/_dialer-protocol-boundary.ts`。
 */
import { describe, expect, it } from "vitest";
import { forwardSourceOf } from "../upstream/_dialer-protocol-boundary.js";

/**
 * 去掉注释、只留「代码 + 字符串字面量」
 *
 * @description
 * **只去注释、不去字符串字面量**：字符串字面量正是本护栏要盯的东西——协议名住在那里时，
 * 那就是「传输层却知道协议名」唯一真实的泄漏形态。
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

/** 四个 channel 转发器：`forward/channel/` 下的四条入站通道 */
const CHANNEL_FILES = ["http.ts", "tunnel.ts", "upgrade.ts", "socks.ts"];

/**
 * channel 侧被禁的三个协议判据 helper
 *
 * @description
 * 三者的作用**只有一个**：从 `upstreamProtocol` 二次推导「这条链路是哪一版/哪种承载」。
 * 那正是连接器层要消灭的第二真相源——`connector.kind` 已经是这个事实的声明
 * （`sockss4` 的 kind 就是 `socks4`、`https` 的 kind 就是 `https`）。
 * 判据覆盖四个 channel 文件，**四个文件全部零命中**。
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
      // 选连接器这件事已收进基类 `ForwarderBase.connectorForRoute`，故正向判据指名那个入口。
      // ⚠️ 锚点必须是**今天仍存在的形状**：锚在已删除的符号上时，命中会全落在注释里，
      // `codeOnly` 剥成空格后断言恒真。配对的负向面在 `./base-wiring.test.ts`，
      // 锚点同样是今天仍存在的形状
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
