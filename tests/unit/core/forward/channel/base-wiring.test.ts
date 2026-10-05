/**
 * `core/forward/channel/**` 的**前置接线已收进基类**：窄抽的负向源码断言 + 收口的正向证据
 *
 * @description
 * 四个通道文件里零「自己拿连接器」的入口 / 零 `new *Connector` / 零连接器层值导入 /
 * 零 `peerTarget()` 形式的补判——那些都收进了 `ForwarderBase`；再配一组正向面证明那些负向
 * 断言不是空跑（把接线抄回任一条通道立刻红，把基类那几个方法删掉同样红）。决策来由、锚点
 * 纪律与「整段文本 vs 逐行」口径在 `AGENTS.md`；目录清单与两轴依赖方向在 `../layout.test.ts`。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  blockAfter,
  codeOf,
  codeOnly,
  offendingLines,
  sourceOf,
  SRC_DIR,
} from "../../../../helpers/source-scan.js";

/** `src/core/forward/` 的绝对路径（从 `SRC_DIR` 派生，层数只许出现在 helper 那一处） */
const FORWARD_DIR = path.join(SRC_DIR, "core", "forward");

/** 四条入站通道的实现文件（按轴：都在 `forward/channel/` 下） */
const CHANNELS = ["http.ts", "tunnel.ts", "upgrade.ts", "socks.ts"] as const;

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

/**
 * 某目录下全部 `.ts` 的绝对路径（递归）
 *
 * @description 刻意与 `../layout.test.ts` 那一份**同形而不同物**：那条判据是「两轴各自的成员清单」，
 * 这一条要数的是「某个形状在 `forward/**` 全文里恰好出现几次」，两者的问题不同、也没有第三个
 * 档同时用到两者 —— 按「一个形状只服务一个判据」拆开，比把两套问题塞进一个共用前导更不容易各自漂。
 */
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

/** 某形状在 `forward/**` 全文（递归）里的**命中次数**（整段文本口径，不受换行影响） */
function countAcrossForward(re: RegExp): number {
  const global = new RegExp(re.source, "g");

  return allSources().reduce(
    (n, file) => n + (codeOnly(fs.readFileSync(file, "utf8")).match(global)?.length ?? 0),
    0,
  );
}

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
