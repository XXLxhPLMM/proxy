import { describe, expect, it } from "vitest";
import {
  FLOOR_RULES,
  SELF_CHECK,
  floorHitsInLine,
  parseEnginesNode,
  sameFloor,
  versionTriple,
  type FloorRule,
} from "../../../helpers/runtime-floor-scan.js";
import { engines, floor, scan } from "./_runtime-floor.js";

/**
 * 运行时地板护栏 —— 真相源的形状与判据自检（`1` 那一组 + 探测器自检）
 *
 * @description 两件事：`engines.node` 必须是**单一 floor 形态**（区间 / caret / 裸版本一律判不合格），
 * 以及**探测器本身有没有写坏** —— 本目录每一档都是负向断言或下限断言，探测器一坏就一起恒绿。
 * ⚠️ **本档是判据的素材面**（注释要逐字写出自己拦下的形状），故它在 helper 的
 * `SCAN_EXCLUDED_SELF_FILES` 里，而 `coverage.test.ts` 的「自指排除恰好两份」钉的就是那张表 ——
 * **搬一次档必须同时改这两处**，理由与三轮变异实测见 `./AGENTS.md`。
 */

const floorTriple = engines.ok ? versionTriple(floor) : ([0, 0, 0] as [number, number, number]);

/** 命中里**出现过**的规则（证明没有「只对自检样本生效」的死规则） */
const rulesInUse = new Set<FloorRule>(scan.hits.flatMap((h) => h.rules));

describe("Node 运行时地板护栏", () => {
  describe("1 真相源：engines.node 的形状", () => {
    it("engines.node 是单一 floor 形态 >=M.m.p", () => {
      // 文档只引用**一个**数字。engines 写成多段地板之后，「文档写的那个数」无法表达它的完整
      // 语义，两者从此无法互相校验 —— 那正是本目录要防的失联。
      expect(engines.ok, engines.ok ? "" : engines.reason).toBe(true);
    });

    it("形态判定本身有牙齿：区间 / caret / 裸版本 / 缺失全部判不合格", () => {
      // 上一条只是**转述**解析器的判决；这一条才是判决本身的判据。少了它，解析器哪天被改成
      // 「什么都收」，整档会安静地全绿。
      const rejected: unknown[] = [
        ">=18 || >=22",
        "^22.13",
        "~22.13",
        "22.13",
        ">=22",
        ">=22.13.0.1",
        "v22.13.0",
        "",
        undefined,
        22.13,
      ];
      for (const raw of rejected) {
        expect(parseEnginesNode(raw).ok, `这个值本该判不合格：${JSON.stringify(raw)}`).toBe(false);
      }
      expect(parseEnginesNode(">=22.13.0").ok).toBe(true);
      expect(parseEnginesNode(">= 22.13.0").ok).toBe(true);
    });

    it("patch 段恒为 0（minor 粒度承诺）", () => {
      // 文档一律写 `22.13`。若 engines 收窄成 `>=22.13.1`，那句文档就在**字面上**成了假话
      // （22.13.0 满足文档、却不满足 engines），而两边都不会报错。
      expect(engines.ok, engines.ok ? "" : engines.reason).toBe(true);
      if (!engines.ok) return;
      expect(engines.patch).toBe(0);
    });
  });

  describe("判据自检（防「探测器写坏了 → 上面每一档一起恒绿」）", () => {
    it.each(
      SELF_CHECK.mustFlag.dirty.map((s) => [s.text, s.version, s.rule] as const),
    )("脏文本会红：%s", (text, version, rule) => {
      const hits = floorHitsInLine(text);
      expect(hits.map((h) => h.version), "探测器没认出这条脏文本的形状").toContain(version);
      expect(hits.find((h) => h.version === version)?.rules ?? []).toContain(rule);
      // 前一条只证明「认得出」；这一条证明「认出来的东西确实是漂移」——
      // 缺了它，判定逻辑坏了（例如把比较写反）也会全绿。
      expect(sameFloor(version, floor), `样本版本 ${version} 竟等于地板 ${floor}，它就不再是漂移样本了`).toBe(false);
    });

    it.each(SELF_CHECK.mustFlag.clean.map((s) => [s.text, s.version, s.rule] as const))(
      "今天的合法写法被认出来且不红：%s",
      (text, version, rule) => {
        const hits = floorHitsInLine(text);
        expect(hits.map((h) => h.version), "探测器没认出今天真实的写法").toContain(version);
        expect(hits.find((h) => h.version === version)?.rules ?? []).toContain(rule);
        expect(sameFloor(version, floor), `今天真实的一行被判成了漂移：${version}`).toBe(true);
      },
    );

    it.each(SELF_CHECK.mustNotFlag)("合法文本零命中：%s", (text) => {
      expect(floorHitsInLine(text).map((h) => h.version)).toEqual([]);
    });

    it.each(SELF_CHECK.mustNotPinBoundary.map((s) => [s.boundary, s.text] as const))(
      "同行的边界版本 %s 不许被顺手提出来当地板：%s",
      (boundary, text) => {
        const versions = floorHitsInLine(text).map((h) => h.version);
        expect(versions).not.toContain(boundary);
      },
    );

    it("每条规则都被至少一个自检样本触发（没有写了却没人验的规则）", () => {
      const fired = new Set<FloorRule>(
        [...SELF_CHECK.mustFlag.dirty, ...SELF_CHECK.mustFlag.clean].flatMap((s) => [
          ...floorHitsInLine(s.text).flatMap((h) => h.rules),
        ]),
      );
      for (const rule of FLOOR_RULES) expect([...fired]).toContain(rule);
    });

    it("每条规则在真实扫描里也命中过（没有只为合成样本存在的规则）", () => {
      for (const rule of FLOOR_RULES) {
        expect([...rulesInUse], `规则「${rule}」在真实仓内一次都没命中`).toContain(rule);
      }
    });

    it("地板扰动自证：把地板换成确定不等于它的值，全部命中都必须变成违规", () => {
      // 「判据会红」这件事不依赖任何合成样本，也不依赖今天的命中数：只要探测器看得见东西，
      // 地板一旦与声明不等，违规集合就等于命中集合。判定逻辑若被写成常量 true，这里会红。
      const perturbed = `${floorTriple[0]}.${floorTriple[1] + 1}.0`;
      expect(sameFloor(perturbed, floor), "扰动值竟与真地板相同，这条断言会恒真").toBe(false);
      const drift = scan.hits.filter((h) => !sameFloor(h.version, perturbed));
      expect(scan.hits.length).toBeGreaterThan(0);
      expect(drift.length).toBe(scan.hits.length);
    });
  });
});