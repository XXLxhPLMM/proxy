import { describe, expect, it } from "vitest";
import { codeOf, offendingLines, sourceOf } from "../helpers/source-scan.js";

/**
 * 「没人用的可选项 / 默认值 / 兜底已清」的**负向**护栏（源码级）
 *
 * @description
 * 本仓处于设计期、库尚未投入使用，**不需要任何兼容层**——所以「其实没人用的可选项 /
 * 默认值 / 兜底」一律当场删掉，不留、不转发、不加 deprecated。本档钉住它们不许回来。
 *
 * 判据统一是**负向源码断言**：形参上的 `?`、参数上的 `= {}`、`?? 兜底常量` 一律不许回来。
 * 为什么必须用源码级而不能用行为断言：
 * - 「`guard` 缺席时会怎样」在删掉那条分支之后**没有运行期形态**可测（编译器就拦住了）；
 * - 「`opts = {}` 会不会被走到」同理；
 * - 更要命的是这些形态的代价是**静默的**：`dialDirect` 少传一个 guard 会在编译期通过、
 *   在运行期往客户端写一段 502 报文，而客户端要等到那个时刻才知道自己被写坏了。
 *
 * 每条都配了变异测试（见汇报），即「把可选项加回去 → 本档必须变红」。
 */

/** 取 `anchor` 那一处调用/声明的圆括号之间的形参文本（anchor 逐条写明，避开同名调用点） */
function paramsOf(code: string, anchor: string): string {
  const at = code.indexOf(anchor);
  if (at < 0) {
    throw new Error(`源码里找不到锚点 ${JSON.stringify(anchor)} —— 结构变了，护栏需显式更新`);
  }
  const start = code.indexOf("(", at + anchor.length - 1);
  let depth = 0;
  let i = start;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i++;
      while (i < code.length && code[i] !== ch) {
        i += code[i] === "\\" ? 2 : 1;
      }
      i++;
      continue;
    }
    if (ch === "(") {
      depth++;
    } else if (ch === ")") {
      depth--;
      if (depth === 0) {
        return code.slice(start + 1, i);
      }
    }
    i++;
  }
  throw new Error(`${anchor} 的形参列表没有闭合`);
}

/** 形参文本里带可选项标记（`?: Type`）的行 */
const OPTIONAL_PARAM = /\w+\s*\?/;

describe("core/forward/upstream/dial.ts：四个守卫形参不得再带可选项（历史遗留已清）", () => {
  const code = codeOf("core", "forward", "upstream", "dial.ts");

  /**
   * 逐个判断记录（为什么都是「删」而不是「保留」）
   *
   * | 形参 | 逐字判断 |
   * |---|---|
   * | `dialDirect(…, opts?)` | 唯一调用点 `connector/direct.ts` 恒传真值；缺席时走 `guardDialing` 缺省档，那份缺省会**向客户端写 502/504 原始 HTTP 报文**并让上下游同生命周期 —— 恰好违反「连接器绝不向 `ctx.client` 写任何字节」。**会静默破坏契约的兜底，删。** |
   * | `dialTls(…, opts?)` | 唯一调用点是 `choose`，而 `choose` 的 guard 已收成必填 → 永不可能缺席。**同一事实的第二个入口，删。** |
   * | `private dialWith(…, guard?)` | 两个调用点（`dialDirect`/`dialTls`）都已必填。**同一事实的第三个入口，删。** |
   * | `choose(…, guard?)` | 三个调用点（`http-connect` 的 `open`/`transport` + `socks-upstream` 的 `dialViaSocks`）恒传真值，且它自己再分发给上面两个 → 没有一条「自洽但未被使用」的路径。**删。** |
   */
  const REQUIRED_GUARD_PARAMS: readonly { name: string; anchor: string }[] = [
    { name: "dialDirect", anchor: "dialDirect(" },
    { name: "dialTls", anchor: "dialTls(" },
    // `dialWith` 另有三处同名调用点，故锚点带 `private` 修饰符逐条钉住声明
    { name: "dialWith", anchor: "private dialWith(" },
    { name: "choose", anchor: "choose(" },
  ];

  for (const { name, anchor } of REQUIRED_GUARD_PARAMS) {
    it(`${name} 的守卫形参必填（不得再带 ?）`, () => {
      const params = paramsOf(code, anchor);

      expect(
        offendingLines(params, OPTIONAL_PARAM),
        `${name} 的守卫形参必须必填：缺席即静默破坏「连接器不向客户端写字节」这条契约`,
      ).toEqual([]);
      // 防假绿：确实收了一个 `DialGuardOptions`（不是把形参删了/改名了）
      expect(params, `${name} 必须显式收 DialGuardOptions`).toContain("DialGuardOptions");
    });
  }

  it("dial.ts 里零 `opts?` / 零 `guard?` 形参（整份文件的负向扫描）", () => {
    expect(
      offendingLines(code, /\b(opts|guard)\s*\?/),
      "dial.ts 不许再出现可选项形参（opts?/guard? 两条已删）",
    ).toEqual([]);
  });
});

describe("core/guard.ts：guardDialing 的 opts 必填（同一条死代码的第四处）", () => {
  it("guardDialing 的 opts 不再带 `= {}` 缺省", () => {
    const code = codeOf("core", "guard.ts");
    const params = paramsOf(code, "guardDialing");

    expect(
      offendingLines(params, OPTIONAL_PARAM),
      "guardDialing 的 opts 必须必填：缺省那份会向客户端写 502/504 且上下游同生命周期",
    ).toEqual([]);
    expect(
      offendingLines(params, /=/),
      `guardDialing 的 opts 不得再有 \`= {}\` 缺省（实际形参：${params.trim()}）`,
    ).toEqual([]);
  });
});

describe("core/forward/channel/tunnel.ts：establishTunnel 的 opts 必填且两个字段都必填", () => {
  const code = codeOf("core", "forward", "channel", "tunnel.ts");

  it("opts 不得再是 `{ head?: Buffer; rest?: Buffer } = {}`", () => {
    const params = paramsOf(code, "establishTunnel");

    expect(
      offendingLines(params, OPTIONAL_PARAM),
      `establishTunnel 的 opts/head/rest 必须全必填（实际形参：${params.trim()}）`,
    ).toEqual([]);
    expect(
      offendingLines(params, /=\s*\{\}/),
      "establishTunnel 的 opts 不得再有 `= {}` 缺省：唯一调用点恒传 { head, rest }",
    ).toEqual([]);
  });

  it("两个字段的类型都锁成 Buffer（head 来自 Node 的 connect 事件、rest 来自 OpenedUpstream，恒有值）", () => {
    const params = paramsOf(code, "establishTunnel");

    expect(params).toContain("head: Buffer");
    expect(params).toContain("rest: Buffer");
  });

  it("唯一调用点恒把两个字段都传进去（否则「必填」只是签名上的谎言）", () => {
    const body = code.slice(code.indexOf("this.establishTunnel("));
    const call = body.slice(0, body.indexOf(");") + 2);

    expect(call, "establishTunnel 的唯一调用点必须传 head").toMatch(/\bhead\b/);
    expect(call, "establishTunnel 的唯一调用点必须传 rest").toMatch(/\brest\b/);
  });
});

describe("connector/**：logPrefix 必填，三处 `?? DEFAULT_LOG_PREFIX` 兜底已清", () => {
  const CONNECTOR_FILES: readonly (readonly string[])[] = [
    ["core", "forward", "upstream", "connector", "direct.ts"],
    ["core", "forward", "upstream", "connector", "http-connect.ts"],
    ["core", "forward", "upstream", "connector", "socks-upstream.ts"],
    ["core", "forward", "upstream", "connector", "socks4.ts"],
    ["core", "forward", "upstream", "connector", "socks5.ts"],
    ["core", "forward", "upstream", "connector", "types.ts"],
    ["core", "forward", "upstream", "connector", "registry.ts"],
    ["core", "forward", "upstream", "connector", "index.ts"],
  ];

  it("connector/** 里零 `DEFAULT_LOG_PREFIX`", () => {
    for (const file of CONNECTOR_FILES) {
      expect(
        offendingLines(codeOf(...file), /DEFAULT_LOG_PREFIX/),
        `${file.join("/")} 不得再出现 DEFAULT_LOG_PREFIX：四个 channel 恒传 logPrefix，`
          + "而那份缺省从来没人触发过、却在三个连接器里各抄了一份",
      ).toEqual([]);
    }
  });

  it("`OpenContext.logPrefix` 是必填字段（端口上不许再带 ?）", () => {
    const raw = sourceOf("core", "forward", "upstream", "connector", "types.ts");
    const block = raw.slice(raw.indexOf("export interface OpenContext"));
    const body = block.slice(0, block.indexOf("clientLifetime?"));

    expect(
      offendingLines(body, /logPrefix\?\s*:/),
      "OpenContext.logPrefix 必须必填：四个 channel 恒传，缺省是没人用的兜底",
    ).toEqual([]);
    expect(body).toContain("readonly logPrefix: string;");
  });

  it("四个 channel 仍然各自申报自己的前缀（连接器层不许自己推导）", () => {
    // 前缀是落盘日志文本契约（forwarder-connector-wiring 逐字断言），值一个都不许变
    const CHANNELS: readonly { file: readonly string[]; prefix: string }[] = [
      { file: ["core", "forward", "channel", "http.ts"], prefix: '"http"' },
      { file: ["core", "forward", "channel", "tunnel.ts"], prefix: '"tunnel"' },
      { file: ["core", "forward", "channel", "upgrade.ts"], prefix: '"upgrade"' },
      { file: ["core", "forward", "channel", "socks.ts"], prefix: '"socks"' },
    ];

    for (const { file, prefix } of CHANNELS) {
      const code = codeOf(...file);

      expect(
        code.includes(`logPrefix: ${prefix},`) || code.includes(`logPrefix: ${prefix}`),
        `${file.join("/")} 必须申报 logPrefix: ${prefix}（守卫前缀是锁死的日志文本契约）`,
      ).toBe(true);
    }
  });
});

describe("core/helpers/predial.ts：PreDialOptions.access 必填（缺省在安全语义上等于全放行）", () => {
  const raw = sourceOf("core", "helpers", "predial.ts");
  const block = raw.slice(raw.indexOf("export interface PreDialOptions"));
  const body = block.slice(0, block.indexOf("access: AccessControl;") + "access: AccessControl;".length);

  it("`access` 是必填字段（端口上不许再带 ?）", () => {
    expect(
      offendingLines(body, /\baccess\?\s*:/),
      "PreDialOptions.access 必须必填：`access` 缺席时若给一个放行兜底，等于把"
        + "「没注入访问控制」静默变成「名单全部放行」——那正是 ACL 静默失效的形态",
    ).toEqual([]);
  });

  it("`access` 不得带任何缺省值（不写 `= ...`、不写 `?? ...` 兜底）", () => {
    // 本条不只查形参列表：守卫函数体里若出现 `opts.access ?? <放行替身>` 同样会红 ——
    // 那样「形参必填」就只是签名上的谎言，调用方仍可以经别处绕过。
    const code = codeOf("core", "helpers", "predial.ts");
    const fn = paramsOf(code, "export function guardPreDial(");

    expect(
      offendingLines(fn, /access\s*=/),
      "guardPreDial 的 opts 不得给 access 任何缺省值",
    ).toEqual([]);
    expect(
      code,
      "predial.ts 不得出现 `access ??` 兜底：core 侧**根本没有** access 缺省档"
        + "（`ProxyOptions.access` 必填、core 侧零缺省解析），"
        + "任何兜底都等于把「没注入访问控制」静默变成「名单全部放行」",
    ).not.toMatch(/\baccess\s*\?\?/);
  });

  it("`config` 仍保留给 isSelfLoop（两个端口职责不同，不许被合成一个）", () => {
    // 防「顺手把 config 也去掉 / 把 access 塞进 config」这类过度合并：自环判定读的是
    // 监听地址（host/port，两个键），名单判定要的是整份可替换端口，两者生命周期与
    // 可注入粒度都不同。合成一个的结果就是要么给判定层塞进一个「什么都能读」的访问器
    // （第二真相源），要么让自环判定跟着访问控制端口走。
    expect(body).toContain("config: ConfigAccessor;");
    expect(body).toContain("access: AccessControl;");
  });
});

describe("core/request-scope.ts：关联 id 的第二个入口已删", () => {
  it("`RequestScopeOptions` 零 requestId/connectionId 形参", () => {
    const raw = sourceOf("core", "request-scope.ts");
    const block = raw.slice(raw.indexOf("export interface RequestScopeOptions"));
    const body = block.slice(0, block.indexOf("}"));

    expect(
      offendingLines(body, /\b(requestId|connectionId)\b/),
      "关联 id 只从 context 取：identity 本来就会被合并进发布的 context，两个入口必然漂移",
    ).toEqual([]);
  });

  it("身份维度仍是从 context 派生的（删形参不等于删功能）", () => {
    const code = codeOf("core", "request-scope.ts");

    expect(code).toContain("context?.requestId");
    expect(code).toContain("context?.connectionId");
  });
});
