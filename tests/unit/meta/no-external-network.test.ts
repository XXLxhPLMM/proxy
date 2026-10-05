import { describe, expect, it } from "vitest";
import {
  LITERAL_PROBES,
  PUBLIC_HOST_ALLOWLIST,
  SELF_CHECK,
  allowlistPairs,
  isPublicHost,
  publicHostsIn,
  scanDialSites,
  scanDialTargets,
  scanPublicHostRefs,
  scannedFiles,
  type HostRef,
} from "../../helpers/external-network-scan.js";

/**
 * 「tests 的 unit / integration / library 零外网依赖」护栏
 *
 * @description 要锁的不变量：`pnpm test` 里的任何一条用例都不得把连接打到公网。本仓真实踩过：
 * 某档 wss 打的是外网，单次 TLS 握手约 4.2s 而那条用例的超时预算只有 5s，于是并行跑几十个测试
 * 文件时**必然偶发超时**。一个外网依赖是定时炸弹，一组是地雷。
 *
 * ⚠️ 观测手段（源码级扫描，口径三条）与自检素材在 `../../helpers/` 那两个模块；本档**只钉行为面**：
 * A 面零公网 + B 面逐条申报**且**双向（未申报即红 / 失效条目也红 —— 只清一头等于假绿）。
 * ⚠️ 本档自己不许出现任何公网 host 字面量（探针样本全在 helper 的 `LITERAL_PROBES`），否则 B 面会
 * 把这档判成未申报。⚠️ `meta/` 根只有这一档，故不建 `AGENTS.md`。
 */
describe("tests: unit/integration 零外网依赖", () => {
  describe("扫描器自检（防假绿）", () => {
    it("MUST_FLAG 全部被判成公网", () => {
      const missed = SELF_CHECK.mustFlag.filter((host) => !isPublicHost(host));
      expect(missed, `扫描器漏判了这些公网 host：${missed.join("、")}`).toEqual([]);
    });

    it("MUST_NOT_FLAG 全部不被判成公网（回环 / 私网 / RFC 保留 TLD）", () => {
      const wrong = SELF_CHECK.mustNotFlag.filter((host) => isPublicHost(host));
      expect(wrong, `扫描器误判了这些非公网 host：${wrong.join("、")}`).toEqual([]);
    });

    it("publicHostsIn 在真实请求行形态上逐条给出预期结果", () => {
      for (const probe of LITERAL_PROBES) {
        expect(publicHostsIn(probe.text), `探针：${JSON.stringify(probe.text)}`).toEqual(probe.expect);
      }
    });

    it("扫描范围非空且覆盖三个目录（防路径写错导致永远通过的空断言）", () => {
      const files = scannedFiles();
      expect(files.length).toBeGreaterThan(40);
      expect(files.some((f) => f.startsWith("tests/unit/"))).toBe(true);
      expect(files.some((f) => f.startsWith("tests/integration/"))).toBe(true);
      expect(files.some((f) => f.startsWith("tests/library/"))).toBe(true);
      // helpers/ 与 manual/ 刻意不在范围内：前者是本护栏自身，后者按设计就该打真网络
      expect(files.some((f) => f.startsWith("tests/helpers/"))).toBe(false);
      expect(files.some((f) => f.startsWith("tests/manual/"))).toBe(false);
    });
  });

  describe("A 面：建链原语的实参里零公网 host（零白名单）", () => {
    it("没有任何建链调用把公网 host 当实参传进去", () => {
      // ⚠️ **本条自带前提，不靠下一条的下界兜**：「建链点集合非空」与「没有一个建链点把公网 host
      // 当实参」是两个独立事实，而 `offenders` 是**过滤后的子集** —— 扫描面为空时它恒为 `[]`，
      // 本条恒绿（实测 `SCAN_DIRS` 指空即如此）。下一条那道下界量的是同一张脸，两者不互相代替。
      expect(
        scanDialSites().length,
        "建链调用点一个都扫不到 ⇒ 本条的判据面是空的，「零公网」成了空集为真",
      ).toBeGreaterThan(0);
      const offenders = scanDialTargets();
      const detail = offenders
        .map((s) => `  ${s.file}\n    ${s.primitive}(…${s.snippet}…)\n    命中公网 host: ${s.hosts.join("、")}`)
        .join("\n");
      expect(
        offenders,
        `unit/integration 里有建链调用把公网 host 当实参（那会真出网）：\n${detail}\n\n` +
          "修法：换成 tests/http-test-server.mjs 式的本地源站（tests/helpers/net.ts:getFreePort() 取本机端口 +\n" +
          "仓内测试 PKI tests/helpers/certs.ts），不要放宽超时、更不要 it.skip。",
      ).toEqual([]);
    });

    it("A 面扫得到东西：仓内建链调用点远多于 30 处（防扫描器失效导致空断言恒绿）", () => {
      const sites = scanDialSites();
      expect(
        sites.length,
        `扫到的建链调用点只有 ${sites.length} 处 —— 正则或字面量切分多半已经失效，这条断言会变成空断言`,
      ).toBeGreaterThan(30);
      // 至少覆盖三种原语，证明「不是只认 net.connect 一家」
      const primitives = new Set(sites.map((s) => s.primitive));
      expect(primitives.size).toBeGreaterThanOrEqual(3);
    });
  });

  describe("B 面：公网 host 字面量必须逐条申报（普查 + 显式豁免）", () => {
    it("没有被申报的公网 host 引用（新增即红，必须先想清楚）", () => {
      const allowed = new Set(allowlistPairs().map((r) => `${r.file} ${r.host}`));
      const undeclared = scanPublicHostRefs().filter((r) => !allowed.has(`${r.file} ${r.host}`));
      const detail = undeclared
        .map((r) => `  ${r.file}  →  ${r.host}`)
        .concat(
          undeclared.length
            ? [
                "",
                "每个公网 host 都必须能回答：它会不会真的建立一条到公网的连接？",
                "  · 不会（只是线上文本 / 名单条目 / 配置值 / 日志占位符）→ 到",
                "    tests/helpers/public-hosts/ 下**你那一片** <主题>.ts 里按",
                "    (file, hosts[], reason) 申报，理由要写清「为什么它不建链」；",
                "    片名 = 目标目录名（unit-<主题>.ts / integration-<主题>.ts / library.ts），",
                "    同一片只由管那个目录的 agent 改，别去动别人的片；",
                "  · 会 → 换成 tests/http-test-server.mjs 式的本地源站（本仓唯一的正确修法）。",
                "",
                "manual/ 与 perf/ 按设计就该打真网络，不在扫描范围内；",
                "确实需要手工外网用例请放 manual/，不要放进 unit/integration。",
              ]
            : [],
        )
        .join("\n");
      expect(undeclared, detail).toEqual([]);
    });

    it("白名单不许有失效条目（表会腐烂成黑洞）", () => {
      const found = new Set(scanPublicHostRefs().map((r) => `${r.file} ${r.host}`));
      const stale = allowlistPairs().filter((r) => !found.has(`${r.file} ${r.host}`));
      const detail = stale
        .map((r) => `  ${r.file}  →  ${r.host}`)
        .concat(stale.length ? ["", "这些豁免已没有对应引用，删掉它们。"] : [])
        .join("\n");
      expect(stale, detail).toEqual([]);
    });

    it("白名单每条都有非空理由、file 确实在被扫描范围、host 确实是公网", () => {
      const files = new Set(scannedFiles());
      const problems: string[] = [];
      for (const entry of PUBLIC_HOST_ALLOWLIST) {
        if (!files.has(entry.file)) problems.push(`${entry.file}：不在扫描范围内（路径写错，或该文件已被移除）`);
        if (entry.reason.trim().length < 10) problems.push(`${entry.file}：理由太短，等于没写`);
        if (entry.hosts.length === 0) problems.push(`${entry.file}：hosts 为空`);
        for (const host of entry.hosts) {
          if (!isPublicHost(host)) problems.push(`${entry.file}：${host} 根本不是公网 host，无需豁免`);
        }
      }
      expect(problems, problems.join("\n")).toEqual([]);
    });

    it("白名单不得出现重复的 (file, host) 对", () => {
      const seen = new Set<string>();
      const dup: string[] = [];
      for (const { file, host } of allowlistPairs() as HostRef[]) {
        const key = `${file} ${host}`;
        if (seen.has(key)) dup.push(key);
        seen.add(key);
      }
      expect(dup, `白名单里有重复条目：${dup.join("、")}`).toEqual([]);
    });

    it("B 面扫得到东西：已申报的公网 host 引用至少有 50 条（防扫描器只认得出 1-2 个）", () => {
      // ⚠️ **`it` 名字里的「50 条」比断言弱** —— 名字是守恒闸门的**指纹**，逐字不许改（守恒核对按
      // `it` 名字双向比对，而**改名同时产出一条 LOST 与一条 ADDED、净差为零**）；**下界的真值在断言里**。
      //
      // **下界刻意低于实测值**：钉成实测值等于「下次合法的条目减少立刻红」，而测试树重组之后条目减少是
      // 常态（两个文件并成一个，两条并一条）。余量给得大 ⇒ **成规模的真实退化仍然绿**，本条要防的那类
      // 退化只能落到下界以下。（前提：`refs` 与 `allowlistPairs()` 集合相等 —— 双向判据同时成立靠它。）
      //
      // ⚠️ **牙齿只在「refs 变少」这一个方向，且只在掉到下界以下时才咬**（扫描面指空 / `literalSpans`
      // 完全失效 / TLD 表被砍到只剩极少数）。**`PUBLIC_TLDS` 收窄一项 ⇒ 本条不红**（实测去掉一项后
      // refs 仍远在下界之上）：唯一红的是「白名单不许有失效条目」—— 那批豁免失去了对应引用，**而那条红
      // 的成因离真因（探测器认不出那类 host）很远**，读失败信息的人只会以为「表里有几条过期条目」。
      // ⚠️ 反向同样没牙：refs 变**多**（`codeOnly` 失效 / TLD 表过宽）一律绿 —— **它是下界不是上界**。
      //
      // ⚠️ **扫不到东西时「没有被申报的公网 host 引用」那条恒绿**（实测 `SCAN_DIRS` 指空 ⇒ 多条红、
      // 它照样绿 —— 判据面空了，**空集为真**）。A 面那半自带「建链点集合非空」的前提，那里它是红。
      //
      // **改这条之前先跑一次核对**：esbuild 把 `../../helpers/external-network-scan.ts` 打成 cjs
      // （`__dirname` 钉死到 `tests/helpers/`，否则 `REPO_ROOT` 解析到别处），调那两个真导出打出来。
      expect(scanPublicHostRefs().length).toBeGreaterThanOrEqual(100);
    });
  });
});