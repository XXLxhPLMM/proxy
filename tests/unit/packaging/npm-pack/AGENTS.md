# tests/unit/packaging/npm-pack/ — `npm pack` 那条通道

本目录只答一件事：**`npm pack` 产出的 tarball 里装了什么、以及 `files` 白名单与 `build.mjs` 的源码面有没有被改坏**。
`build:pkg` 的五个 standalone zip 是**另一条通道**（`../zip/`，本目录的判据对 `dist/*.zip` 完全看不见）。

## 本档盯的两类事故，各自决定了一档判据的形状

1. **`files` 里的路径无法被 `.npmignore` 排除**（npm 的规则如此）—— 根 `.npmignore` 里的
   `.env*` / `log/` 对白名单路径**一条都拦不住**。所以判据只能作用在 `files` 白名单与
   tarball 清单本身上：`files` 零裸目录（`lib` / `dist` 要写成带白名单的精确路径）。
2. **`build.mjs` 的两类守卫会反噬**：`dist/` 若从不清空就是「只进不出的抽屉」，而
   `cfg/*.json` 骨架与 `.env.*` 拷贝上的 `!fs.existsSync` 守卫，**保住的恰恰是它本要防的
   那份文件**。故静态不变式那一档钉死「构建前清空 `dist/`」与「cfg 骨架无条件覆写：
   写 users.json / acl.json 的块里零 `existsSync` 守卫」。

## 判据是真实 tarball 清单，不是只读 `files` 字段

`npm pack --dry-run --json` 吐出来的清单才是判据（实测 ~4.5s，`--dry-run` 只遍历不写盘）。
只断言 `files` 字段的话，「白名单收得太紧把包收空」「某个 glob 展开出意料之外的路径」
这两类事故都看不见 —— 那是**弱化判据**。

⚠️ **清单取自 `npm pack` 而不是 `pnpm pack`**（实测差异）：两者清单**不等价** ——
`pnpm pack` 会无条件多带整个 `readme/` 目录（7 个文件约 119KB），`npm pack` 不带。故对着
`tar -tzf` 看到的行数会比本目录的 dry-run 多几行 `readme/` —— **那不是漏判**。两者对 `files`
的尊重是一致的（干净实验：两个 packer 都排除了 `src/`）。`readme/**` 不含任何被禁形状，
因此本目录的每一条结论对 `pnpm pack` 同样成立；不额外跑 `pnpm pack` 是因为它不能
`--dry-run`、会真写一个 tarball，换不到新的牙齿。`scan.test.ts` 里那条
「判据口径提示」会在 npm 也开始带 `readme/` 时提醒人回头更新这一段。

## 两条刻意的口径收窄（写明理由，别当成漏检）

- **`log` / `logs` 路径段只对 `lib/` 之外生效**：`lib/server/log/config-log.js` 是
  `src/server/log/config-log.ts` 的编译产物（`server/log/` 是**源码目录名**，不是日志目录）。
  `lib/` 整体是 `tsc` 从 `src/**` 产出的 `.js`/`.d.ts`，里面不可能长出运行期数据文件；
  真正会长大文件的是 `dist/`。故豁免**只**给 `lib/`，并且额外断言「所有带 log 段的路径
  必须都在 `lib/` 之下」，让豁免范围不能被悄悄放大。
- **`cfg/` 规则对全部路径生效**（不给 `lib/` 豁免）：`lib/` 里不存在 `cfg` 路径段，
  规则写全范围更简单也更严。`lib/**` 那条 `src|scripts|tests` 规则不适用同理。

## 防假绿的位置

- **判据自检**（`scan.test.ts` 的「判据自检」那一档）：把探测器套在 `realLeakSamples` 上，
  逐条断言「它会红」，并断言每条规则至少被一个样本触发。探测器写坏了时这一档立刻红，
  而不是让上面所有负向断言一起变成永远通过。⚠️ `realLeakSamples` 里那几条路径是
  **v5.1.3 tarball 里真实出现过的文件**（历史记录），判据只对字符串做路径段匹配 ——
  **样本文本逐字不许跟着文件搬家改**。
- **降级面显式报出**（`scan.test.ts` 的「覆盖面」那一档）：`lib/` 与 `dist/` 是 gitignored 的
  构建产物，缺失时正向档 `skipIf` 跳过，但这一档会把「此刻只覆盖了静态不变式 + 判据自检」
  **打出来**，不静默假装全覆盖。
- **`files-whitelist.test.ts` 的两条下界不许省**：`binEntries.length > 0` 与
  `names.length > 1`（`bin` 是空对象时「目标互异」会恒真）。
- **零裸目录用文件系统事实判**：写成 `dist/app.jsx`（文件不存在）在没构建的工作树上也会判它是
  文件路径 —— 那种错由正向档负责，不在静态档越权假红。

## 文件

- `scan.test.ts` — tarball 清单这一档：降级面可见 + 判据自检 + 清单零命中三条（清单整体零违规 /
  带 log 段的路径全部在 `lib/` 之下 / `dist/` 白名单**逐项列出**）。
- `files-whitelist.test.ts` — 白名单与构建脚本这一档：正向（包不许被收空，六条 `it` 钉住
  `lib/index.js` / `dist/app.js` / `build.mjs` 的 entryPoints / `bin` 的每个入口 / 配置模板 /
  清单规模）+ `files` 静态不变式七条 + `build.mjs` 源码面三条。
- `_pack-contents.ts` — 两档共用的面：真 dry-run 清单、模块加载时的**预热**、`hasLib` /
  `hasDist` / `built`、以及两条两档都用到的判据（`isNonExampleEnv` / `isKeyMaterial`）。
  ⚠️ **两个测试文件跑在各自的 worker 里 ⇒ 本模块被加载两次、`npm pack --dry-run` 也真的跑两次**
  （并行，故整组墙钟与合并成一个文件时同量级）。那条预热**不许删**：不预热的话第一次调用
  落在 `files-whitelist.test.ts` 的第一条 `it` 上，而 15s 的 `testTimeout` 是**用例预算**——
  机器一忙就 `Test timed out in 15000ms`，症状与判据漂移长得一模一样（实测踩到过一次）。
- `AGENTS.md` — 本文件。

## 相关路径

- `../../../../package.json` — `files` 白名单与 `bin`（与 `build.mjs` 的 `entryPoints` 互相锁，
  两侧由 `files-whitelist.test.ts` 反过来断言）。
- `../../../../build.mjs` — 两个组合根的产物 + `dist/` 的无条件清空 + `cfg` 骨架覆写。
- `../../../../scripts/package-dist.mjs` — **另一条通道**（`../zip/` 那一侧）。
- `../zip/` — `build:pkg` 的五个 standalone zip 护栏（`files` 白名单对 zip 完全看不见）。
- `../../../helpers/source-scan.ts` — `codeOnly` / `REPO_ROOT`（路径层数只许出现在那里）。