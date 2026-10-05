/**
 * 二进制产物表 —— `build-pkg.mjs` 建什么、`package-dist.mjs` 装什么、`tests/unit/packaging/zip/payload.test.ts`
 * 认什么，**三处同源的那一份**
 *
 * @description
 * ## 为什么这张表住在自己的文件里
 *
 * 三个脚本各写一份名字表，就是「下游下载页 / zip 清单 / 实际产物三处对不上」那类事故的原料：
 * 构建时改了名，打包脚本还在找旧名，而 zip 护栏正指着旧名断言 —— 三处**同时**绿，产物却少一个。
 * 故它住在这里，由两侧 import；护栏那一侧**刻意不 import**（见 `tests/unit/packaging/zip/payload.test.ts` 的
 * 判据自检档），改成断言「本表产出的名字集合 == 护栏自己写的闭集」，两份独立列表必须相等。
 *
 * ## 为什么每个（平台 × 入口）都要**单独一次 pkg 调用**
 *
 * pkg 一次调用**只推导一个基础名**（`config.js:resolveOutput`：取 `pkg.name` 或 `-o`，多 target 时
 * 由 `assignTargetOutputs` 追加差异轴）。也就是说 `proxy` / `proxy-cli` 两个不同的名字
 * **在一次调用里根本产不出来** —— 「一个 pkg 块列多个入口、每项带名字」那种写法不是配错了，
 * 是**不存在的能力**（`pkg.scripts` 只是「额外打进去的 JS 文件」的 glob 列表，每项必须是字符串，
 * 见 `walker.js:upon` 的 `typeof p !== 'string'` 抛错）。
 *
 * 故这里是**展平后的一张表**（6 行），而不是 2 × 2 的嵌套形状：调用方逐行跑，没有「平台套入口」
 * 那层需要另外对齐的映射。
 *
 * ## 这张表覆盖的是 `bin` 的**全部**入口
 *
 * 控制面与数据面同进程（`MANAGER_ENABLED=true` 时随 `proxy` 起来），故 `bin` 只有两个名字，
 * 而这张表**恰好**两个 —— 三条分发通道（npm tarball / Node zip / 二进制 zip）在这件事上完全对称。
 * 「二进制 zip 拿不到控制面」那种曾经的不对称，其成因是布局死结：控制面那个进程唯一的职责是
 * spawn 别的进程，它 spawn 的是 `process.execPath` + **一个 `app.js` 路径**，而二进制 zip 里只有
 * exe、没有 `app.js`。同进程之后这条死结整条消失。
 * 牙齿：`tests/unit/packaging/zip/manifest.test.ts` 的「Node 包带全两个入口」与同档
 * 「二进制包带自己的可执行文件、Node 包带 app.js 与最小 package.json」两条一正一反。
 *
 * ## 为什么没有「pkg assets」
 *
 * 二进制快照里**不需要**任何非 JS 负载，三条理由（都实测过）：
 * - `dist/node-sqlite3-wasm.wasm`：pkg 的 node22 基础二进制是 **v22.23.2**（`pkg-fetch` 的
 *   `expected-shas.json`），远高于 `22.13` 那个免 flag 边界，`node:sqlite` 内置可用。实测
 *   `proxy-cli-win.exe usage show` 正常打开账本 —— 走的就是内置档。
 * - `.env.example` / `cfg/*.example` / `keys/`：由 `package-dist.mjs:addCommonAssets` 从 `dist/`
 *   注入到**每个 zip 里、exe 旁边**（不是快照里），解压后 cwd 即 configDir，按 `.env.example` 的
 *   相对缺省解析成立。
 * - ⚠️ **别把 `pkg.assets` 加回来**：用 JS 文件当入口时 pkg **根本不读** `package.json` 的 `pkg` 块
 *   （`config.js:resolveConfig` 的 `sourcePkg = configJson?.pkg ?? inputJson?.pkg ?? {}`，
 *   JS 文件入口下 `inputJson` 是 undefined），所以加了它就是一份**看着活着、其实被静默忽略**的
 *   配置 —— 那正是本文件要消灭的东西。要往快照里加东西就得走 `--config <file>`。
 */

/** 三个平台的 pkg target（`build.mjs` 只出 node22：理由见 `build-pkg.mjs` 的文件头） */
export const PLATFORMS = [
  { target: "node22-win-x64", os: "win", exe: ".exe" },
  { target: "node22-linux-x64", os: "linux", exe: "" },
  { target: "node22-darwin-x64", os: "macos", exe: "" },
];

/** 两个进发行 zip 的入口（`bin` 名与文件名前缀一一对应，故只需一个 `prefix`） */
export const ENTRIES = [
  { bin: "proxy", entry: "dist/app.js", prefix: "proxy" },
  { bin: "proxy-cli", entry: "dist/proxy-cli.js", prefix: "proxy-cli" },
];

/**
 * 展平后的待构建二进制（6 行）：每个（平台 × 入口）一次 pkg 调用
 * @description
 * `file` 是 `dist/` 下的**最终文件名**，pkg 靠 `--output` 显式指定（不给的话它按 `pkg.name` +
 * 平台轴推导，会变成 `@b-hole/proxy-win.exe` 且塞进 `dist/@b-hole/` 子目录）。
 */
export const BINARIES = PLATFORMS.flatMap((p) =>
  ENTRIES.map((e) => ({
    /** pkg `--target` */
    target: p.target,
    /** 发行 zip 的平台标签（`win-x64` / …），zip 脚本按它挑哪个 zip */
    os: p.os,
    /** pkg 的入口文件（相对仓库根） */
    entry: e.entry,
    /** 产物落在 `dist/` 下的名字，zip 里同名 */
    file: `${e.prefix}-${p.os}${p.exe}`,
  })),
);

/**
 * 二进制 zip 清单：`proxy-v<version>-<label>.zip`
 * @description
 * ⚠️ **同时带 `os` 与 `label`**：消费方要按 `os`（`win`）去 `BINARIES` 里筛条目，按 `label`
 * （`win-x64`）拼 zip 文件名。这两个值**形状不同**（差一个 `-x64`），只给一个就必然出现
 * 「筛出来是空的 → 静默 skip 平台」这类假绿 —— 那正是本轮修掉的 `build-pkg` 吞错同款。
 */
export const BINARY_ZIPS = PLATFORMS.map((p) => ({ os: p.os, label: `${p.os}-x64` }));
