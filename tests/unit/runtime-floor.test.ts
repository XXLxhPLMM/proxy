import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  EXCLUDED_DIRS_ANY_DEPTH,
  EXCLUDED_DIRS_AT_ROOT,
  EXCLUDED_FILE_PATTERNS,
  FLOOR_RULES,
  MUST_DECLARE_FILES,
  REPO_ROOT,
  SCAN_EXCLUDED_SELF_FILES,
  SELF_CHECK,
  SQLITE_BOUNDARIES,
  crossLineFloorShapes,
  excludedAreaHits,
  floorHitsInLine,
  parseEnginesNode,
  readEnginesFloor,
  repoText,
  sameFloor,
  scanRepo,
  unpinnedRuntimeMentions,
  versionTriple,
  type FloorRule,
} from "../helpers/runtime-floor-scan.js";

/**
 * Node 运行时地板护栏（唯一真相源 = `package.json` 的 `engines.node`）
 *
 * @description
 * **地板这个数字为什么必须由测试来守**：`engines` 在 npm 与 pnpm 上都只是 WARN（退出码 0），
 * `devEngines` 只在 npm 上生效 —— 没有任何 `package.json` 字段能拦住开发环境（见根
 * `AGENTS.md`「开发必须 Node >= 22.13 由谁保证」那一节，实测表就在那儿）。真正强制地板的
 * 是 `tests/unit/usage-source.test.ts` 里那条真跑 `node:sqlite` 的 builtin 档断言，而那份文件
 * 里的两个数字（`22.5` 出生 / `22.13` 免 flag）**又被十几处文档复述**。数字一多，漂移就是
 * 时间问题：地板在文档里被写低，消费者照着装；被写高，开发环境自己起不来，而**没有任何一处
 * 会报错**。本档就是那道「不会报错」的反面。
 *
 * ## 五档分工
 * 0. **覆盖面**：扫了多少文件、命中多少处、跳过了哪些二进制、排除清单的每一项为什么成立。
 *    **降级面必须看得见** —— 少了这一档，「本档此刻只覆盖了哪些文本」就只存在于判据作者的脑子里。
 * 1. **真相源的形状**：`engines.node` 必须是**单一 floor 形态**，且 patch 段恒为 0。
 * 2. **地板声明零漂移**（核心）：全仓每一处「声明地板」的形状都必须等于 `engines.node`。
 * 3. **正向存在性**：`node:sqlite` 的**两个**边界必须在讲分流机制的那几处同时出现 ——
 *    这是**正向**断言（缺了就红），防「有人把两档表简化成一句、把机制叙述删掉」。
 * 4. **口径自检**：跨行形状为零、排除清单没被扩大、源码目录 `src/server/log/` 没被连坐、
 *    未钉的运行时版本提及被普查出来。
 * 判据自检单独成档（见下），它的存在理由是：**上面每一档都是负向断言或下限断言**，
 * 探测器一旦写坏（例如比较符的正则少写一个字符），它们会一起变成永远通过。
 *
 * ## 判据自检怎么防假绿（通用规则见根 `AGENTS.md`「写护栏时」）
 * - **脏样本逐条「会红」**：合成脏文本（`22.6` 顶替地板、`22.5` 被当成免 flag 版本）必须
 *   **既被识别、又确实不等于今天的 `engines` 地板**。两条合起来才是「它会红」；只写前半条，
 *   「识别出 22.6 但判定逻辑坏了」照样全绿。
 * - **合法样本逐条「不红」**：`mustFlag.clean` 是今天真实的写法（相邻 / 隔散文 / 无空格 /
 *   反引号 / 后缀加号 / 徽章编码），它们必须被识别**且**等于地板。
 * - **负向样本的锚点逐条是今天活着的行**：`mustNotFlag` / `mustNotPinBoundary` 逐字取自仓内
 *   真实文本（上界写法、`node:sqlite` 模块名、区间、两个边界的机制叙述、方法学举例）。
 *   点名一个不存在的形状，负向断言会**恒真**而不是失败。
 * - **地板扰动自证**：把地板换成一个确定不等于它的值再跑真实扫描，全部命中都必须变成违规。
 *   判据「会红」这件事因此不依赖任何合成样本，也不依赖今天的命中数。
 *
 * ## 「地板」与「边界叙述」是两类东西（这一档最容易做错）
 * **地板只有一个**：`engines.node` 里那个数。本档**只**钉它。
 * `22.5`（`node:sqlite` 出生）与 `22.13`（免 flag）是**两个独立事实**，它们在
 * `src/utils/sqlite/*`、根 `AGENTS.md`、`Dockerfile` 里的叙述是**合法的机制说明**，不是漂移；
 * 判据刻意不碰它们（理由与判据形状写在 `helpers/runtime-floor-scan.ts` 的文件头）。
 * 反过来也**不许**把边界叙述漏出视野：第 4 档的普查会把每一处在谈运行时、却没被钉住的版本
 * 字面量打印出来，包括上界写法与「数字自己是句子主语」那类判据覆盖不到的形态。
 *
 * ## 三条刻意的口径收窄（写明理由，别当成漏检）
 * - **大小写敏感的 `Node`**：`node:sqlite` 是**模块名**、`node:22` 是**镜像标签**，都不是运行时
 *   地板。`Dockerfile` 那句「base image 是 `node:22`（≥22.5，走内置档）」因此合法。
 * - **桥接窗口里不许有数字**：`Node 16 – 22.12` 这种区间里站着另一个数字，并成一条声明就会
 *   凭空得到一个地板。窗口上限 48 字符，用来覆盖「运行时名与地板被一截散文隔开」的写法。
 * - **`lib/` 显式排除**：它是 `build:lib` 的产物、`.gitignore` 已忽略，`.d.ts` / `.js` 里的注释
 *   是 `tsc` 从 `src/**` 拷过去的，**内容由 `src/` 决定**。扫进去它会红（今天那里面就躺着陈旧
 *   的 `22.5` 声明），**红了说明该排除它、不是该改它**。第 0 档单独把它扫一遍来证明这个排除
 *   确实在干活 —— 否则「排除」就是一句没人验证的空话。
 */

const engines = readEnginesFloor();
const scan = scanRepo();

/** 判据要跟的唯一真相：地板的三元组；`engines` 不合格时这一层全部落空（由第 1 档报出原因） */
const floor = engines.ok ? `${engines.major}.${engines.minor}.0` : "";
const floorTriple = engines.ok ? versionTriple(floor) : ([0, 0, 0] as [number, number, number]);

/** 全部命中里不等于地板的那些（核心档的判据） */
const violations = scan.hits.filter((h) => !sameFloor(h.version, floor));

/** 命中里**出现过**的规则（证明没有「只对自检样本生效」的死规则） */
const rulesInUse = new Set<FloorRule>(scan.hits.flatMap((h) => h.rules));

/** `lib/` 是否存在（`build:lib` 的产物，gitignored） */
const hasLib = existsSync(path.join(REPO_ROOT, "lib", "index.js"));
/** `lib/` 里的陈旧声明（证明排除 `lib/` 这件事在干活） */
const libHits = hasLib ? excludedAreaHits("lib") : [];

describe("Node 运行时地板护栏", () => {
  describe("0 覆盖面：扫了多少、命中多少、降级面在哪（必须看得见）", () => {
    it(`报出本档此刻的覆盖面：${scan.files.length} 个文本文件 / ${scan.hits.length} 处地板声明 / 跳过 ${scan.skipped.length} 个非文本`, () => {
      const perFile = new Map<string, number>();
      for (const hit of scan.hits) perFile.set(hit.file, (perFile.get(hit.file) ?? 0) + 1);
      const summary = [...perFile]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([file, n]) => `  ${n} × ${file}`)
        .join("\n");
      process.stderr.write(
        [
          `运行时地板护栏：扫了 ${scan.files.length} 个文本文件，命中 ${scan.hits.length} 处地板声明（地板 = ${floor}）`,
          ...(engines.ok ? [] : [`  ⚠️ engines.node 不合格：${engines.reason}`]),
          "命中分布：",
          summary,
          `降级面：跳过 ${scan.skipped.length} 个非文本文件（${scan.skipped.join("、") || "无"}）`,
          `未钉的运行时版本提及：${unpinnedRuntimeMentions().length} 处（只报出、不判定，见第 4 档）`,
          "",
        ].join("\n"),
      );

      // 扫描面下界：路径写错、排除清单写太宽、或整仓遍历坏掉时这一档会立刻红
      expect(scan.files.length).toBeGreaterThan(100);
      // 命中下界：判据一条都匹配不到时这一档会立刻红（下界不是定数，见第 2 档的说明）
      expect(scan.hits.length).toBeGreaterThanOrEqual(8);
      // 降级面不许把源码吃掉：非文本跳过清单里不许出现源码 / 文档 / 配置扩展名
      const textExtensions = /\.(ts|tsx|mts|cts|js|mjs|cjs|md|json|jsonc|ya?ml|example|development|production)$/;
      expect(scan.skipped.filter((f) => textExtensions.test(f))).toEqual([]);
    });

    it("扫描面排除了依赖与构建产物（node_modules / .git / dist / lib 任意层级）", () => {
      for (const hit of scan.hits) {
        expect(EXCLUDED_DIRS_ANY_DEPTH.some((d) => hit.file.split("/").includes(d))).toBe(false);
      }
      // 锁文件是依赖解析的机器产物，且体量大到会淹没判据输出
      for (const pattern of EXCLUDED_FILE_PATTERNS) {
        expect(scan.files.filter((f) => pattern.test(f))).toEqual([]);
      }
    });

    it("排除清单不许扩大到源码与文档目录（豁免面不可被悄悄放大）", () => {
      // 排除项只能是依赖 / 构建产物 / 本机状态 / 编辑器配置
      for (const kept of ["src", "tests", "readme", "scripts", "keys", "cfg", ".opencode"]) {
        expect(EXCLUDED_DIRS_ANY_DEPTH).not.toContain(kept);
        expect(EXCLUDED_DIRS_AT_ROOT).not.toContain(kept);
      }
      // 且排除项确实都是今天真实存在的目录（写一个不存在的排除名 = 白写）
      const declared = [...EXCLUDED_DIRS_ANY_DEPTH, ...EXCLUDED_DIRS_AT_ROOT];
      const onDisk = declared.filter((d) => existsSync(path.join(REPO_ROOT, d)));
      expect(onDisk.length).toBeGreaterThanOrEqual(4);
    });

    it("log 只在仓库根排除：源码目录 src/server/log/ 必须在扫描面内", () => {
      // `.gitignore` 自己把 `/log/` 写成根锚定，理由是裸 `log/` 会把 src/server/log/ 一起吞掉。
      // 护栏若按任意层级排除 `log`，就会把一份源码级注释从扫描面里静默删掉。
      expect(EXCLUDED_DIRS_AT_ROOT).toContain("log");
      expect(EXCLUDED_DIRS_ANY_DEPTH).not.toContain("log");
      expect(scan.files).toContain("src/server/log/config-log.ts");
      expect(scan.files).toContain("src/server/log/AGENTS.md");
    });

    it("自指排除恰好两份（判据的素材面与它自己的说明，理由见 helper 文件头）", () => {
      expect([...SCAN_EXCLUDED_SELF_FILES].sort()).toEqual([
        "tests/helpers/runtime-floor-scan.ts",
        "tests/unit/runtime-floor.test.ts",
      ]);
      // 排除必须真的生效，否则上面那张表就是一句空话
      for (const self of SCAN_EXCLUDED_SELF_FILES) {
        expect(scan.files).not.toContain(self);
      }
    });

    describe.skipIf(!hasLib)("lib/ 排除的牙齿（产物存在时才有）", () => {
      it("单独扫 lib/ 会命中地板声明 —— 所以排除它不是空转，而是有东西可排", () => {
        expect(libHits.length).toBeGreaterThan(0);
        process.stderr.write(
          `运行时地板护栏：lib/（build:lib 的产物，gitignored）里有 ${libHits.length} 处地板声明，` +
            `例如 ${libHits[0]?.file}:${libHits[0]?.line} 声明 ${libHits[0]?.version} —— ` +
            "它由 src/ 决定，已被显式排除，不参与判定\n",
        );
      });

      it("lib/ 里的声明要么与地板相同、要么是另一条**合法**的边界叙述（不是地板漂移）", () => {
        // ⚠️ 判据刻意**不是**「lib/ 里有与地板不同的声明」：`build:lib` 是 `src/` 的忠实编译，
        // 所以重建后的 lib/ 必然与 src/ 一致、与地板一致。上一版把「存在陈旧声明」当前提，
        // 于是 `pnpm build:lib` 跑完就红 —— 那是在要求一个**陈旧产物**永远不许被重建，
        // 把「排除 lib/」的理由从「它是派生产物」偷换成了「它碰巧是错的」。
        //
        // 真正要钉的是排除的**理由**：lib/ 里的地板形状必须与 src/ 同源（同一批文件），
        // 所以它要么等于地板、要么是被判据显式放行的边界叙述（如 sqlite 的 22.5 出生线），
        // **绝不会**出现「src/ 里没有、只有 lib/ 才有」的地板数字。
        const srcVersions = new Set(scan.hits.map((h) => h.version));
        const libOnly = libHits.filter((h) => !srcVersions.has(h.version));
        expect(
          libOnly.map((h) => `${h.file}:${h.line} → ${h.version}`),
          "lib/ 里有 src/ 不存在的地板数字：那是 lib/ 自己漂了（陈旧产物），该重建 build:lib 而不是改判据",
        ).toEqual([]);
      });
    });
  });

  describe("1 真相源：engines.node 的形状", () => {
    it("engines.node 是单一 floor 形态 >=M.m.p", () => {
      // 文档只引用**一个**数字。engines 写成多段地板之后，「文档写的那个数」无法表达它的完整
      // 语义，两者从此无法互相校验 —— 那正是本档要防的失联。
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

  describe("2 地板声明：全仓零漂移（核心档）", () => {
    it(`${scan.hits.length} 处地板声明全部等于 engines 地板 ${floor}`, () => {
      const detail = violations
        .map(
          (h) =>
            `  ${h.file}:${h.line}  声明 ${h.version}（规则 ${h.rules.join("/")}）\n    ${h.text}`,
        )
        .join("\n");
      expect(
        violations.map((h) => `${h.file}:${h.line} → ${h.version}`),
        `这些地方声明的 Node 地板不是 engines 里的 ${floor}：\n${detail}\n\n` +
          "修法只有一条：package.json 的 engines.node 是唯一真相源。改地板就改它，然后同步全仓；\n" +
          "改错了就把这一处改回它。**不要**在别处新写一个数。\n" +
          "注意 node:sqlite 的 22.5（出生）与 22.13（免 flag）是两个独立事实，那类叙述不是漂移、" +
          "本档也不判它们。",
      ).toEqual([]);
    });

    it(`命中数 ${scan.hits.length} >= 8（下界，不是定数）`, () => {
      // 命中数会随文档增删变化。钉死具体个数会把「加一个文档」变成「改一次测试」的噪音，
      // 于是人们会去改测试而不是加文档；下界只挡住「探测器整体失灵」。
      expect(scan.hits.length).toBeGreaterThanOrEqual(8);
    });

    it.each(MUST_DECLARE_FILES)("%s 必须至少声明一处地板", (file) => {
      // 正向存在性：这些是今天对消费者承诺地板的入口文档，删掉声明等于撤掉承诺
      expect(scan.files, `${file} 不在扫描面内（路径写错，或它已被移出受版本管理的范围）`).toContain(file);
      const own = scan.hits.filter((h) => h.file === file);
      expect(own.length, `${file} 里一处地板声明都没有了`).toBeGreaterThanOrEqual(1);
    });

    it("紧邻写法与隔散文写法都被认出来（48 字符桥接窗口不是死代码）", () => {
      // 桥接窗口若被谁改窄成「只认反引号与空格」，`readme/README.en.md` 那句
      // 「Requires Node.js installed locally (**`engines` says `>= 22.13`**…)」就会从护栏里
      // 消失 —— 而它恰恰是唯一一处把 `engines` 与地板写在同一行散文里的英文文档。
      expect(scan.hits.filter((h) => h.proseBridge).length).toBeGreaterThanOrEqual(1);
      expect(scan.hits.filter((h) => !h.proseBridge).length).toBeGreaterThanOrEqual(8);
    });
  });

  describe("3 正向存在性：node:sqlite 的两个边界必须并存", () => {
    it.each(SQLITE_BOUNDARIES.map((b) => [b.file, b.boundaries.join(" 与 ")] as const))(
      "%s 里必须同时出现两个边界（%s）",
      (file) => {
        // **正向**断言（缺了就红），不是负向。`node:sqlite` 的分流判据是「require 得不得成」，
        // 而它的理由就是「有两个边界」；把两档表简化成一句就会把这个理由删掉 —— 删掉之后
        // 下一个读代码的人会以为「22.5 就够」，而代码在 22.5–22.12 上其实会静默落到 WASM 档。
        const text = repoText(file);
        for (const boundary of SQLITE_BOUNDARIES.find((b) => b.file === file)?.boundaries ?? []) {
          expect(text.includes(boundary), `${file} 里没有 ${boundary}：两个边界的机制叙述被删掉了一半`).toBe(true);
        }
      },
    );
  });

  describe("4 口径自检：判据的视野边界本身要可判", () => {
    it("跨行的地板形状为零（行级口径今天不漏东西）", () => {
      // 一条声明被折行排版（「Node」在行尾、地板在下一行）时，行级判据看不见它。
      // 今天一处都没有 —— 钉住这个「零」，哪天有人折行排版，这里会先红，提示口径要显式扩到
      // 跨行，而不是让那条声明静默逃出护栏。
      const shapes = crossLineFloorShapes();
      expect(shapes.map((s) => `${s.file}:${s.line}`), `出现了跨行的地板声明：\n${shapes.map((s) => `  ${s.file}:${s.line}  ${s.text}`).join("\n")}`).toEqual([]);
    });

    it("在谈运行时、却没被钉住的版本字面量被普查出来（普查器不是死代码）", () => {
      // 这一档是「边界叙述不许被误判成漂移」的对偶面：它们**不是**漂移，但也不能从视野里消失。
      // 上界写法（`Node < 22.13`）、裸边界叙述（`22.5 出生`）、以及「数字自己是句子主语」
      // （`**为什么是 22.13**`）都在这里 —— 判据覆盖不到它们是**已知缺口**，不是「不存在」。
      const mentions = unpinnedRuntimeMentions();
      expect(mentions.length).toBeGreaterThan(0);
      const scanned = new Set(scan.files);
      expect(mentions.filter((m) => !scanned.has(m.file))).toEqual([]);
      process.stderr.write(
        `运行时地板护栏：未钉的运行时版本提及 ${mentions.length} 处 —— 已知缺口，非漂移：\n` +
          mentions.map((m) => `  ${m.file}:${m.line}  [${m.versions.join("、")}]  ${m.text}`).join("\n") +
          "\n",
      );
    });

    it("判据与普查构成一个划分：每处运行时版本字面量要么被钉住、要么被普查报出", () => {
      // 用一份**独立写在这里的**朴素扫描做对照：它比 helper 里的两份都笨（不做上下文判定、
      // 不认边界），因此「它看见的都被前两者覆盖」是一条真的信号 —— 探测器或普查器的正则
      // 少写一个字符，就会有字面量从两份视野里同时溜走，这里立刻红。
      const DUMB_VERSION = /\b\d{2}\.\d+(?:\.\d+)?\b/g;
      const RUNTIME_CONTEXT = /node(?:\.js)?\b|node:sqlite|node:\d|engines/i;
      const reported = new Map(unpinnedRuntimeMentions().map((m) => [`${m.file}\u0000${m.line}`, m.versions]));
      const missing: string[] = [];
      for (const rel of scan.files) {
        repoText(rel)
          .split("\n")
          .forEach((line, index) => {
            if (!RUNTIME_CONTEXT.test(line)) return;
            const all = [...new Set([...line.matchAll(DUMB_VERSION)].map((m) => m[0]))].filter(
              (v) => versionTriple(v)[0] >= 16,
            );
            if (all.length === 0) return;
            const pinned = new Set(floorHitsInLine(line).map((h) => h.version));
            const census = reported.get(`${rel}\u0000${index + 1}`) ?? [];
            for (const v of all) {
              if (pinned.has(v) || census.includes(v)) continue;
              missing.push(`${rel}:${index + 1}  ${v}`);
            }
          });
      }
      expect(missing, `这些运行时版本字面量既没被地板判据钉住、也没进普查（等于从视野里消失）：\n${missing.join("\n")}`).toEqual([]);
    });
  });
});
