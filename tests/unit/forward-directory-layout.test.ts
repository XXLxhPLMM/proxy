import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { blockAfter, codeOf, codeOnly, offendingLines, sourceOf } from "../helpers/source-scan.js";

/**
 * `core/forward/` **目录按两轴重排**后的形状护栏 + 「前置接线已收进基类」的源码级负向断言
 *
 * @description
 * `forward/` 现在按**两条正交的轴**分目录：
 * - `forward/channel/` = **入站协议**轴：四条通道（`http` / `tunnel` / `upgrade` / `socks`）
 *   + 它们共用的握手读取器 `socks-reader`；
 * - `forward/upstream/` = **上游对接**轴：纯传输层 `dial` + 上游连接器层 `connector/`；
 * - `forward/base.ts` = 横跨两轴的公共基类，**刻意留在根上**（它是「通道共享的前置接线」的
 *   家，搬进 `channel/` 会让基类反过来依赖自己子类所在的目录）。
 *
 * 拆目录的真实收益不是「好看」，是**依赖方向变得可断言**：`channel/**` 只能朝 `upstream/**`
 * 单向，反向不许出现。两者平铺成同级文件时方向性根本没法扫，拆开之后可以直接扫 import 钉死。
 *
 * 本档三件事：
 * ① **目录不变式**（文件清单逐字）：`forward/` 根只有 `base.ts`；`channel/` 恰好那五个成员；
 *   `upstream/` 恰好 `dial.ts` + `connector/`；
 * ② **两轴之间的依赖方向**（import 扫描）：`channel/**` 不得引别的通道实现（只允许
 *   `@/core/forward/upstream/**` 与 `@/core/...`），`upstream/**` 不得引 `channel/**`；
 * ③ **窄抽结果**（负向源码断言）：四个通道文件里**零**自己拿连接器的入口、**零** `peerTarget()`
 *   形式的补判——那些都收进了基类方法；并配一组正向/收口面证明那些负向断言不是空跑。
 *
 * ### 本档锁住的三条决策（结论 — 否掉了什么 — 为什么）
 *
 * **① 按入站协议拆出 `channel/`，不是按上游协议。** 被否掉的是「按上游协议分组」，它的
 * 判据是「`channel/` 的存在前提是『每个转发器按一种上游协议分支』，而该前提已被 `connector/` 层
 * 消灭」。**那个判据本身没错，但它把两件事混成了一件**：①「按上游协议分支」确实已被连接器层
 * 消灭（零控制流级协议判据，那半边由 `dialer-protocol-boundary.test.ts` 逐字锁住）；
 * ② **「按入站协议分组」是另一件正交的事**，它的收益不是抽象而是**依赖方向可断言**——
 * 这正是本档 `dirsOf()` / `importsOf()` 那几组断言存在的理由。
 * - **实测「抽不动的代码」仍逐条成立**（`codeOnly` 口径：四条通道合计 936 → 窄抽后 857 行）：
 *   SOCKS 侧「握手 + 目标解析」**112 行形态独立**（只有 SOCKS 入站走客户端原始字节，不过
 *   HTTP 解析器）、`http.ts` 全程操作 `ServerResponse` 且**零次**调 `bridgeWithBuffered`、
 *   `upgrade` 必须**先等 101** 才有隧道（还有非 101 的独立分流）、`refusal` 处置刻意分成
 *   **两种**（`tunnel`「原样透传不断链」让 `Proxy-Authenticate` 送达客户端 vs `socks`
 *   「回 SOCKS 失败应答」因为回 HTTP 报文会污染协议）。**这些仍然不可约：目录分组不等于
 *   抽象，拆目录后协议代码一行没少变。**
 *
 * **② 前置接线收口。** 被否掉的是「不建『前置接线方法族』」，理由是**实测收益太小**
 * （净 -32 行、3.4%），以为不值得。**那个度量衡是错的**：判据应该是**「改一处好过改四处」**
 * 而不是「减几行」——本仓已吃过一次同型亏，每用户流量配额的绕过之所以要逐处修补，正是因为
 * 「计量落点」这个同一逻辑有四份拷贝。
 * - ⚠️ **为什么净收益只有 3.4%**（想「补完剩下的重复」前先读这段）：本仓的「重复」与教科书
 *   不一样——**大部分重复是注释，不是代码**。每份接线都带着一大段解释「为什么这样做」的
 *   注释，窄抽时那些注释**跟着各自的语义留在了通道**；`codeOnly` 口径虽然去掉了注释，却同时
 *   **去掉了大部分收益**。**剩下的「重复」已经不值得抽**：应答形态 4 种、`upstream-error`
 *   载荷 3 种、`isSocksTunnel` 各一个调用点——那正是「不建协议应答层」记的假抽象。
 *   **结论：前置接线已收干净，这层没有下一次同型收益了。**
 * - **那五个基类方法各自抽的是「真正逐字同形的那部分骨架」**；四种应答形态与三份
 *   `upstream-error` 载荷刻意留在通道。本档的 `CHANNEL_GRABS_CONNECTOR` /
 *   `CHANNEL_CONSTRUCTS_CONNECTOR` / 值导入 / `peerTarget()` 四组负向断言 + 「窄抽的四个
 *   入口都在基类上」+「四条通道确实各经基类选连接器」+「http 与 upgrade 仍经
 *   `preDialPeerTarget`」两组正向断言，就是这条决策的可执行形式：**把接线抄回任一条通道，
 *   本档立刻红**；把基类那几个方法删掉，同样红。
 *
 * **③ 「选连接器」全仓只有一处（`ForwarderBase.connectorForRoute`），判据是有效路由而不是
 * 任何配置键。** 否掉「每条通道各写一份三元式」与「让 `connectorForRoute` 读
 * `upstreamProtocol`」——`direct` ⟺ 「该拨真实目标是 `resolveRoute` 已判定的事实」，不是独立
 * 标志位。本档为它准备的正是**五条源码级断言**：四个通道文件零「自己拿连接器」的入口 /
 * 零 `new *Connector` / 对连接器层只有 type-only 引用零值导入 / `this.connectors.direct(`
 * 与 `.upstream(` 各恰好出现一次且都在 `connectorForRoute` 体内 / 该方法体内零
 * `upstreamProtocol` 零 `config.get(`。⚠️ **这五条的锚点全部是「今天仍存在的形状」**——
 * 任何一条锚在已不存在的符号上都会恒真而不锁任何东西（本仓最危险的一类假绿）。
 *
 * 锚点清单（都是今天仍存在的形状）：`this.connectors.` / `createConnectorSource(` / 协议查表
 * 符号 / `new *Connector` / 连接器层的值导入。
 *
 * 口径与 `dialer-protocol-boundary.test.ts` 逐字一致（同一份 `codeOnly`，**只去注释、
 * 留代码与字符串字面量**）：注释里点名自己不再用什么是「在描述这条不变量本身」，
 * 把注释纳入断言就成了自我否定。
 */

/** `src/core/forward/` 的绝对路径 */
const FORWARD_DIR = path.join(__dirname, "..", "..", "src", "core", "forward");

/**
 * `forward/` 根上**只允许**有这一个**文件**（公共基类，刻意不搬进任何一轴）
 * @description 目录条目另列：根上恰好这两个子目录，一条轴一个。
 */
const ROOT_FILES = ["base.ts"];

/** `forward/` 根上的两个子目录（一条轴一个，不许有第三种分组维度） */
const ROOT_DIRS = ["channel", "upstream"];

/** `forward/channel/` 恰好这五个成员（四条入站通道 + 它们的握手读取器） */
const CHANNEL_MEMBERS = ["http.ts", "socks-reader.ts", "socks.ts", "tunnel.ts", "upgrade.ts"];

/** `forward/upstream/` 恰好这两个成员（传输层 + 连接器层目录） */
const UPSTREAM_MEMBERS = ["connector", "dial.ts"];

/** `forward/upstream/connector/` 恰好这八个成员（七个职责模块 + 它的 barrel） */
const CONNECTOR_MEMBERS = [
  "direct.ts",
  "http-connect.ts",
  "index.ts",
  "registry.ts",
  "socks-upstream.ts",
  "socks4.ts",
  "socks5.ts",
  "types.ts",
];

/** 四条入站通道的实现文件（按轴：都在 `forward/channel/` 下） */
const CHANNELS = ["http.ts", "tunnel.ts", "upgrade.ts", "socks.ts"] as const;

/** 列某目录下的条目名（只取 `.ts` 与目录，排序后逐字比对） */
function membersOf(...segments: string[]): string[] {
  return fs
    .readdirSync(path.join(FORWARD_DIR, ...segments), { withFileTypes: true })
    .map((e) => e.name)
    .filter((n) => n.endsWith(".ts") || !n.includes("."))
    .sort();
}

/**
 * 列某目录下**只有文件**（不含子目录）的条目名
 *
 * 只取 `.ts`：这条护栏锁的是**模块布局**（哪些实现文件在哪个目录），`.md` 不是模块。
 * 目录里可以放 `AGENTS.md` 路径说明而不影响布局断言 —— 与 `membersOf` 同一口径。
 */
function filesOf(...segments: string[]): string[] {
  return fs
    .readdirSync(path.join(FORWARD_DIR, ...segments), { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((n) => n.endsWith(".ts"))
    .sort();
}

/** 列某目录下**只有子目录**的条目名 */
function dirsOf(...segments: string[]): string[] {
  return fs
    .readdirSync(path.join(FORWARD_DIR, ...segments), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/** 某目录下全部 `.ts` 的绝对路径（递归） */
function allSources(...segments: string[]): string[] {
  const root = path.join(FORWARD_DIR, ...segments);
  const out: string[] = [];

  for (const entry of fs.readdirSync(root, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.endsWith(".ts")) {
      out.push(path.join(entry.parentPath ?? root, entry.name));
    }
  }

  return out.sort();
}

/** 相对 `src/core/forward/` 的可读路径（失败输出里要能一眼看出是哪个文件） */
function rel(abs: string): string {
  return path.relative(path.join(FORWARD_DIR, ".."), abs).split(path.sep).join("/");
}

/**
 * 「通道层自己拿连接器」的判据（**整段文本**口径，不逐行）
 *
 * @description 五个形状都指同一条违规：**绕过 `ForwarderBase.connectorForRoute` 自己去解析或新建连接器**。
 *
 * **为什么必须是整段文本而不是 `offendingLines` 逐行**：逐行口径对
 * `this\n  .connectors\n  .direct()` 这种换行写法**永远匹配不到**——那正是本档 `peerTarget`
 * 那条踩过的坑（「护栏假绿」最常见的形态）。所以判据一律 `.test(整段)`，逐行结果只进失败信息帮人选。
 */
const CHANNEL_GRABS_CONNECTOR =
  /\bthis\s*\.\s*connectors\s*\.|\bcreateConnectorSource\s*\(|\bresolveUpstream\s*\(|\bPROTOCOL_FACTORIES\b|\bLOOKUP\b/;

/** 「绕过端口自己造连接器」的判据（整段文本口径，同上） */
const CHANNEL_CONSTRUCTS_CONNECTOR = /\bnew\s+[A-Z]\w*Connector\b/;

/** 某形状在 `forward/**` 全文（递归）里的**命中次数**（整段文本口径，不受换行影响） */
function countAcrossForward(re: RegExp): number {
  const global = new RegExp(re.source, "g");

  return allSources().reduce(
    (n, file) => n + (codeOnly(fs.readFileSync(file, "utf8")).match(global)?.length ?? 0),
    0,
  );
}

describe("core/forward：两轴目录的不变式（文件清单逐字）", () => {
  it("forward/ 根上只有 base.ts 一个文件（横跨两轴的公共基类，刻意不进任何一轴）", () => {
    expect(filesOf()).toEqual(ROOT_FILES);
  });

  it("forward/ 根上恰好两个子目录，一条轴一个（不许出现第三种分组维度）", () => {
    expect(dirsOf()).toEqual(ROOT_DIRS);
  });

  it("channel/ 恰好四条入站通道 + 它们的握手读取器（无多余文件、无遗漏、无子目录）", () => {
    expect(filesOf("channel")).toEqual(CHANNEL_MEMBERS);
    expect(dirsOf("channel"), "channel/ 是扁平的：入站通道之间没有子分组").toEqual([]);
  });

  it("upstream/ 恰好「传输层一个文件 + 连接器层一个目录」两个成员", () => {
    expect(filesOf("upstream")).toEqual(["dial.ts"]);
    expect(dirsOf("upstream")).toEqual(["connector"]);
    // 两条断言的合并形态（顺序按 files+dirs 排）
    expect(membersOf("upstream")).toEqual(UPSTREAM_MEMBERS);
  });

  it("upstream/connector/ 的七个职责模块 + 它的 barrel 齐全（层出口是唯一对外引用面）", () => {
    expect(filesOf("upstream", "connector")).toEqual(CONNECTOR_MEMBERS);
    expect(dirsOf("upstream", "connector"), "连接器层是扁平的：七个模块平铺").toEqual([]);
  });

  it("目录不是空壳：每条轴的每个文件都真的有代码（防「建了目录没搬东西」）", () => {
    for (const file of allSources()) {
      expect(codeOnly(fs.readFileSync(file, "utf8")).length, `${rel(file)} 是空文件？`).toBeGreaterThan(
        500,
      );
    }
  });
});

describe("core/forward：两轴之间的依赖方向（单向，反向禁止）", () => {
  /**
   * import 语句（去掉注释后的代码面）
   * @description 只取 `from "..."` 那一段：判据是「引的是哪个模块」，不是「怎么用」。
   */
  function importsOf(file: string): string[] {
    const code = codeOnly(fs.readFileSync(file, "utf8"));

    return [...code.matchAll(/\bfrom\s+"([^"]+)"/g)].map((m) => m[1]);
  }

  it("channel/** 只引同轴的兄弟与 @/core/** ，绝不引别的入站通道实现", () => {
    for (const file of allSources("channel")) {
      for (const spec of importsOf(file)) {
        // 允许：node: 内置 / 跨目录的 @ 别名（配置、core 兄弟、utils、upstream 轴）
        // 禁止：./ 之外的 forward 平铺路径，以及任何指向另一条通道实现的深路径
        expect(
          spec,
          `${rel(file)} 引了「${spec}」：入站通道之间不许互相实现（那会让四条通道长成互相依赖的网）`,
        ).not.toMatch(/@\/core\/forward\/(?!base\.js$|upstream\/)/);
      }
    }
  });

  it("channel/** 引 upstream 轴时只能走 @/core/forward/upstream/**（跨目录用别名）", () => {
    for (const file of allSources("channel")) {
      for (const spec of importsOf(file)) {
        if (!spec.startsWith("@/core/forward/upstream/")) {
          continue;
        }
        expect(
          spec,
          `${rel(file)} 跨目录引上游必须用 @/ 别名：相对路径会让人误以为通道与上游是同层`,
        ).toMatch(/^@\/core\/forward\/upstream\//);
      }
    }
  });

  it("upstream/** 绝不引 channel/**（依赖必须单向：入站 → 上游，反向即目录级环）", () => {
    for (const file of allSources("upstream")) {
      for (const spec of importsOf(file)) {
        expect(
          spec,
          `${rel(file)} 引了「${spec}」：上游对接轴不许反向依赖入站通道（那会让「怎么到达 dest」`
            + "变成取决于谁在请求它）",
        ).not.toMatch(/channel\//);
      }
    }
  });

  it("base.ts 跨两轴引的都是 @/ 别名（它横跨两轴，用相对路径会读错归属）", () => {
    for (const spec of importsOf(path.join(FORWARD_DIR, "base.ts"))) {
      if (spec.startsWith("node:") || spec.startsWith("@/config") || spec.startsWith("@/utils")) {
        continue;
      }
      expect(
        spec,
        "base.ts 引 forward 内部模块必须用 @/core/forward/...（同目录相对路径只对 channel/ 内部成立）",
      ).toMatch(/^@\/core\//);
    }
  });
});

describe("core/forward/channel/**：前置接线已收进基类（窄抽的负向源码断言）", () => {
  it("四个通道文件里零「自己拿连接器」的入口（this.connectors. / createConnectorSource / 协议查表）", () => {
    // ⚠️ 锚点必须是**今天仍存在的形状**：锚在已删除的符号上时，命中会全落在注释里，
    // `codeOnly` 剥成空格后「零命中」恒成立、不锁任何东西。这里的锚是通道层唯一能碰到
    // 连接器的入口——基类那个 `connectors` 字段。
    for (const file of CHANNELS) {
      const code = codeOf("core", "forward", "channel", file);

      expect(
        CHANNEL_GRABS_CONNECTOR.test(code),
        `${file} 自己拿连接器了（命中行 ${JSON.stringify(offendingLines(code, CHANNEL_GRABS_CONNECTOR))}）：`
          + "选连接器只有基类 connectorForRoute 一处"
          + "（direct ⟺ 该拨真实目标 是 resolveRoute 已判定的事实，抄第二份必然漂移；"
          + "协议查表则住在 registry.ts 装配期那一份，通道层再查一次就是第二个真相源）",
      ).toBe(false);
    }
  });

  it("四个通道文件里零 new *Connector（不许绕过 ConnectorSource 造连接器）", () => {
    for (const file of CHANNELS) {
      const code = codeOf("core", "forward", "channel", file);

      expect(
        CHANNEL_CONSTRUCTS_CONNECTOR.test(code),
        `${file} 不得自己 new 连接器（命中行 `
          + `${JSON.stringify(offendingLines(code, CHANNEL_CONSTRUCTS_CONNECTOR))}）：`
          + "连接器由 createConnectorSource 在**装配期**造好并注入，自己 new 等于绕过 ConnectorSource 端口",
      ).toBe(false);
    }
  });

  it("四个通道文件对连接器层只有 type-only 引用，零值导入", () => {
    for (const file of CHANNELS) {
      const code = codeOf("core", "forward", "channel", file);
      // 逐个 import 语句看：只放过 `import type { … }`（引用端口的**类型**是正当的），
      // 任何带值的导入都是「绕开基类自己去取连接器」的入口面。
      const valueImports = [...code.matchAll(/import\s+(?!type\b)([\s\S]*?)from\s+"([^"]+)"/g)]
        .map((m) => m[2])
        .filter((spec) => spec.includes("/upstream/connector/"));

      expect(
        valueImports,
        `${file} 不得从连接器层做**值**导入：通道只拿基类 connectorForRoute 给的那一个连接器对象`,
      ).toEqual([]);
    }
  });

  it("选连接器的两档全仓各只出现一次，且都在 connectorForRoute 体内（收口的正向证据）", () => {
    const body = blockAfter(codeOf("core", "forward", "base.ts"), "protected connectorForRoute(");

    for (const tier of ["direct", "upstream"] as const) {
      const re = new RegExp(`this\\s*\\.\\s*connectors\\s*\\.\\s*${tier}\\s*\\(`);

      expect(
        countAcrossForward(re),
        `this.connectors.${tier}( 在 forward/** 里必须恰好出现一次`
          + "（多一处 = 「第二个选法」又长出来了；零处 = 端口本身被掏空）",
      ).toBe(1);
      expect(body, `两档之一 ${tier} 没在 connectorForRoute 体内被用到（收口的那一处就是它）`)
        .toMatch(re);
    }
  });

  it("connectorForRoute 体内零配置读取（协议在装配期定死，请求期不许重读）", () => {
    const body = blockAfter(codeOf("core", "forward", "base.ts"), "protected connectorForRoute(");

    expect(
      body,
      "connectorForRoute 里读 upstreamProtocol = 每请求重读一个 startup 键："
        + "那份重读会让 registry 的记忆化立刻变成第二真相源（改完配置不重启、source 仍握旧协议、"
        + "且没有任何报错），正是 ConnectorSource 端口要消灭的东西",
    ).not.toMatch(/upstreamProtocol/);
    // 形态上再钉一道：这一档选法是纯二选一，不该读任何配置
    expect(body, "connectorForRoute 是纯二选一，不该读任何配置").not.toMatch(/config\s*\.\s*get\s*\(/);
  });

  it("四个通道文件里零 peerTarget() 调用（查询与补判都由基类 preDialPeerTarget 收口）", () => {
    for (const file of CHANNELS) {
      const code = codeOf("core", "forward", "channel", file);

      // 通道连**查询**都不许自己做：基类那个方法同时返回 `peer`（`http` 侧给
      // `http.request` 的 host/port 与失败日志路由用）与 `denied`，拆开做就等于
      // 「查询在通道、判据在基类」一旦分家，两半就会各漂各的。
      //
      // 用**整段文本**的正则而不是 `offendingLines`（逐行）：判据形状天然跨三行
      // （`const peer = …` / `if (peer.host !== …` / `&& this.preDial(…`），
      // 逐行匹配永远匹配不到 —— 那正是「护栏假绿」最常见的形态。
      expect(
        /peerTarget\s*\(/.test(code),
        `${file} 不得自己调 peerTarget（哪怕只是拿返回值）：传输对端的查询与补判`
          + "都由基类 preDialPeerTarget 一次做完 —— 短路掉补判 = 客户端能让本代理"
          + "经 SOCKS 隧道连回自己的监听地址（真实自环漏洞）",
      ).toBe(false);
      // 第二层：那个「与 targets.dial 比较后补判 preDial」的整段形状也不许复活
      expect(
        /peerTarget\([^)]*\)[\s\S]{0,200}?this\.preDial\(/.test(code),
        `${file} 不得出现「peerTarget() 与 dial 比较后补判 preDial」这个形状`,
      ).toBe(false);
    }
  });

  it("窄抽的四个入口都在基类上（否则上面两条负向断言是「把功能删了也算过」）", () => {
    const code = codeOf("core", "forward", "base.ts");

    for (const method of [
      "connectorForRoute",
      "preDialPeerTarget",
      "settleDenied",
      "settleDialFailure",
      "denyUpstreamLoopOf",
    ]) {
      expect(
        blockAfter(code, `protected ${method}(`),
        `基类上必须有 protected ${method}（防「把接线删了」也算通过那两条负向断言）`,
      ).not.toBe("");
    }
  });

  it("四条通道确实各经基类选连接器（正向：不是「谁都不选」）", () => {
    for (const file of CHANNELS) {
      expect(
        codeOf("core", "forward", "channel", file),
        `${file} 必须经 this.connectorForRoute(...) 选上游`,
      ).toContain("this.connectorForRoute(");
    }
  });

  it("http 与 upgrade 两条通道仍经 preDialPeerTarget 补判（补判不许被顺手删掉）", () => {
    for (const file of ["http.ts", "upgrade.ts"] as const) {
      expect(
        codeOf("core", "forward", "channel", file),
        `${file} 必须经 this.preDialPeerTarget(...) 补判传输对端（真实自环漏洞的护栏）`,
      ).toContain("this.preDialPeerTarget(");
    }
  });

  it("基类里 direct ⟺ 真实目标 的判据只有一处（connectorForRoute 体内那一个三元）", () => {
    const body = blockAfter(codeOf("core", "forward", "base.ts"), "protected connectorForRoute(");

    expect(body, "选连接器的判据必须在方法体内（不是藏在别的调用点）").toContain(
      'route.route === "direct"',
    );
    // 恰好一个三元：多一处就意味着「还有第二个选法」又长出来了
    expect(body.match(/\?/g) ?? []).toHaveLength(1);
  });

  it("settleDenied 只有 403 / 其余两分支（deny 只可能拿到 502 与 403 —— 判据在 guardPreDial）", () => {
    const body = blockAfter(codeOf("core", "forward", "base.ts"), "protected settleDenied(");

    expect(body, "403 必须映射成 target-denied/access（名单拒绝是准入事实，不是网关失败）").toContain(
      "STATUS_FORBIDDEN",
    );
    expect(body, "其余（恒为 502 自环）必须映射成自环 fail").toContain("proxy loop detected");
    // 钉住「不得复活」：`guardPreDial` 只有 `deny(502)` / `deny(403)` 两个调用点，
    // `settleDenied` 里的 400 分支不可达；400 走各协议自己的解析失败路径，不经 deny 闭包。
    expect(
      offendingLines(body, /STATUS_BAD_REQUEST/),
      "settleDenied 不得再判 400：guardPreDial 只调 deny(502) / deny(403)，"
        + "400 那条拒绝走各协议自己的解析失败路径（不经 deny 闭包）",
    ).toEqual([]);
  });
});

describe("core/forward/base.ts：两轴公共基类的铁律仍在（防删注释式退化）", () => {
  it("基类仍写明「身份维度绝不存实例字段」", () => {
    expect(sourceOf("core", "forward", "base.ts")).toContain("绝不存实例字段");
  });

  it("基类文件头点名它横跨两轴、且刻意留在 forward/ 根（否则下一个人会「顺手」搬进 channel/）", () => {
    const raw = sourceOf("core", "forward", "base.ts");

    expect(raw, "必须写明 base.ts 不属任何一轴").toContain("横跨两轴");
    expect(raw, "必须写明它为什么留在根上（搬进 channel/ 会让基类依赖自己的子类目录）").toContain(
      "留在 `forward/` 根",
    );
  });
});
