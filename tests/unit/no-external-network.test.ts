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
} from "../helpers/external-network-scan.js";

/**
 * 「`tests/{unit,integration,library}` 零外网依赖」护栏
 *
 * @description
 * **要锁的不变量**：`pnpm test` 里的任何一条用例都不得把连接打到公网。
 * 这不是洁癖 —— 本仓真实踩过：`integration/http-proxy-node.test.ts` 的 wss 档打的是外网
 * `ws.postman-echo.com`，单次 TLS 握手约 4.2s，而那条用例自己的超时预算只有 5s，
 * 于是并行跑 75 个测试文件时**必然偶发超时**（连续两次全量跑各撞上一次，单独跑通过）。
 * 一个外网依赖是定时炸弹，一组是地雷。
 *
 * **观测手段**：源码级扫描（口径三条，写在 `helpers/external-network-scan.ts` 文件头）。
 * 断言分两面，缺一不可：
 * - **A 面（拨号位，零白名单）**：建链原语（`net.connect` / `tls.connect` / `http[s].request` /
 *   `fetch` / `dns.*`）的**实参**里出现公网 host 即红。这层有牙齿、不需要豁免。
 * - **B 面（普查 + 显式申报）**：每个公网 host 字面量都必须有 (file, host) 级别的豁免 + 理由。
 *   它抓的是 A 面看不见的形态 —— **host 作为本地 helper 的实参**
 *   （本仓踩过的那档就是 `wssViaConnect(port, "<公网 host>", 443)`）：那种形态与
 *   「名单条目字符串」在文本上无法区分，只能靠「必须申报」这道人工闸门。
 * - **B 面反向断言**（白名单不许有失效条目），否则这张表会腐烂成什么都往里塞的黑洞。
 * - **扫描器自检**：防「正则坏了 → 扫不出东西 → 全绿」这类假绿。
 *
 * 扫描器与白名单刻意住在 `helpers/`（不在扫描范围内）：白名单必须写出被豁免的公网 host
 * 字面量，若它自己被扫描就是纯自噬。分工与 `helpers/source-scan.ts` 同构：**文本面在 helper，断言在这里**。
 * 推论：**本档自己不允许出现任何公网 host 字面量**（探针样本全在 helper 的 `LITERAL_PROBES`），
 * 否则 B 面会把这档判成未申报 —— 这是刻意的，断言档必须与被断言的仓一样干净。
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
                "    tests/helpers/external-network-scan.ts 的 PUBLIC_HOST_ALLOWLIST 里按",
                "    (file, hosts[], reason) 申报，理由要写清「为什么它不建链」；",
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
      expect(scanPublicHostRefs().length).toBeGreaterThanOrEqual(50);
    });
  });
});
