/**
 * 生成物与生成器输入同步：`src/server/banner.ts` 印的版本号 === `package.json` 的 `version`
 *
 * @description
 * `banner.ts` 是构建时生成的（`build.mjs:152-155` 调 `scripts/gen-banner.mjs`，`--version
 * "${pkg.version}"`，`build.mjs:121` 还为它加了 watcher 豁免「监听它会无限自激」），而它是**入库**的
 * —— 入库的东西要能被审阅，缺的正是「它与 package.json 同步」这一条。
 *
 * 缺了它的那次形态：版本号在 `package.json` 里被抬到 5.3.0 而没跑 `build`，于是横幅继续印 v5.2.0。
 * 而收尾纪律要求 lint → typecheck → test → **build**（build 是必跑的最后一条），于是工作树每次都被
 * build 弄脏，而那个反射动作（把 `banner.ts` checkout 掉）每次都在把一个**对外可见的假版本号**放回
 * 仓库 —— 启动横幅会印着与 npm 上不同的版本。
 *
 * 判据落在「真相源那一侧」：钉「等于某个写死的串」的话，每次改版本号都得记得改那个串，而改漏了就是
 * 一次假绿；钉「印的 == `package.json` 的 `version`」则本条只在「改了却没跑 build」时才红。
 *
 * 读的是 `codeOf`（去注释）而不是 `sourceOf`：版本串躺在**字符串字面量**里，而把同样那串写进注释
 * 会让判据在没有生成物的情况下照样绿。
 *
 * @module tests/unit/meta/version-sync
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT, codeOf } from "../../helpers/source-scan.js";

/**
 * banner.ts 里印版本号那一行的形状
 * @description 只取版本号那一段（`\d+\.\d+\.\d+`），**刻意不锚 ANSI 码**：样式是
 * `gen-banner.mjs` 的自由，锚它会让这条护栏因非漂移的原因红，而那会把人训练成忽略它。
 */
const PRINTED_VERSION = /@b-hole\/proxy\s+v(\d+\.\d+\.\d+)/;

describe("生成物与生成器输入同步", () => {
  it("`src/server/banner.ts` 印的版本号 === `package.json` 的 `version`", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
      readonly version: string;
    };
    const code = codeOf("server", "banner.ts");

    // 防假绿的正向面：先证明 banner.ts 里今天仍有那一行，否则下面那句比较是「两个 undefined 相等」
    const printed = PRINTED_VERSION.exec(code);
    expect(
      printed,
      "锚点失效：banner.ts 里不再有 `@b-hole/proxy  vX.Y.Z` 那一行"
        + "（gen-banner.mjs 改了输出形态，本条要跟着改）",
    ).not.toBeNull();

    expect(
      printed?.[1],
      `启动横幅印的是 ${printed?.[1]} 而 package.json 是 ${pkg.version}`
        + " —— banner.ts 是 build.mjs 的生成物，跑一次 pnpm build 即可重新生成",
    ).toBe(pkg.version);
  });
});
