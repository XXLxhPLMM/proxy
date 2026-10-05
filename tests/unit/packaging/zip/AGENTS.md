# tests/unit/packaging/zip/ — `build:pkg` 那条通道

本目录只答一件事：**`dist/` 下那五个 standalone zip 里装了什么、以及 `package-dist.mjs` 的源码面有没有被改坏**。
`npm pack` 的 tarball 是**另一条通道**（`../npm-pack/`）：`package.json` 的 `files` 白名单对
`dist/*.zip` **完全看不见**，反过来 zip 里带不带 `keys/` 白名单也无从表达 —— 故本目录是 zip 通道
**唯一**的牙齿。⚠️ `packaging/` 那一层**直接 0 档**，所以**不建** `packaging/AGENTS.md`；
这条跨子目录不变量的完整表述归 `tests/unit/AGENTS.md` 的目录↔`src/` 对照表。

## `keys/` 收私钥是**有意的**（故本档守的是「闭集 + 同一性」，不是「零私钥」）

三处事实锁死了这个设计：

- `.env.example` 的缺省是 `TLS_KEY=keys/server.key` / `TLS_CERT=keys/server.crt`，
  按 configDir 相对解析 —— zip 里没有 `keys/server.key`，https / sockss5 入站直接起不来。
- `readme/usage/*.md` 的目录树把 `keys/{server,ca,client}.{crt,key}` 写进发行物布局，
  并附「生产环境请替换为正式证书」。
- `build.mjs` 无条件把仓库 `keys/` 整目录 `cpSync` 进 `dist/keys/`，`package-dist.mjs`
  再把 `dist/keys/` 整个 `addDir` 进每个 zip。

**于是危险点不是「有私钥」，而是「私钥的集合与来源不受约束」**：往仓库 `keys/` 里丢一份
自己的正式证书，`build.mjs` 的无过滤镜像 + `addDir` 的无过滤递归会**静默**把它送进全部 5 个
zip 分发出去。故零命中档对 `keys/` 立两条判据：条目集合**闭集**（不多不少那 7 个已入库文件）+
逐条**逐字节同一性**（与仓库 `keys/` 同名文件相同）。前者抓「多带一个」，后者抓「换掉一个」。
二者合起来等价于「zip 只能带仓库里那份早已公开的测试 PKI」，暴露面增量为零。

## `node16.zip` 与 `node22.zip` 的 `app.js` 相同是**有意的双标签约定**，不是异常

同一份 esbuild 产物打两个标签（`package-dist.mjs` 里有整段理由：pkg 6.22 的远程 cache 没有
node16 预编译基础二进制，二进制包做不到双标签，而 `app.js` 本身与 Node 版本无关）。
`manifest.test.ts` **正向断言**这两个条目的 CRC 相同，把约定钉住 —— 免得将来有人把
「字节相同」当异常顺手「修」掉。

## 闭集枚举而不是「禁掉某几样」

「不许出现 X」挡不住「Y 悄悄溜进来」。正向档逐项列出**允许**的形状，新增一个条目时必须红、
逼人写清「它为什么可以进发行 zip」；这与 `../npm-pack/` 里 `allowedInDist` 那条是同一个手法。

⚠️ **闭集常量刻意独立写一遍，不从产物表推导**（判据的价值在「新增一个产物必须红」；
若从 `scripts/pkg-binaries.mjs` 推导，闭集跟着产物表一起变宽，那道闸门自动打开）。
代价由 `payload.test.ts` 的收敛档补上：断言「两份列表相等」，任何一侧单独改动都会红。

## ⛔ 跨档的条件 `describe`：守卫必须在**两个文件**里各重建一次

`scan.test.ts` 与 `payload.test.ts` 各自重开 `describe.skipIf(!built)("1 零命中：zip 清单里不许出现的形状")`，
而**只有一部分 `it` 落在其中**（`scan` 两条、`payload` 一条）。⚠️ 两处都必须写出
**守卫表达式原文** `describe.skipIf(!built)`，且 `built` 从 `_zip-contents.ts` import：

- 只在一处重建 ⇒ 另一处那个 `it` **无条件运行** ⇒ 产物缺失时它抛错，或者更坏：它过，
  **vitest 用例总数从 1308 变 1309**（静默改数）。
- 只搬 `skipIf` 三个字而让 `built` 在本文件另立一份 ⇒ **编译通过然后跳过 0 条**
  （本文件那份 `built` 恒真或恒假）。所以那个变量**不许**在档里自己算。

## 降级面显式报出（`scan.test.ts` 的「覆盖面」档）

zip 是 `build:pkg` 的产物且整个 `dist/` 被 gitignore，没跑过打包的工作树上不存在。
缺失时 1–4 档 `skipIf` 跳过，但那一档会把「此刻只覆盖了静态不变式 + 判据自检」**打出来**，
不静默假装全覆盖；存在时把每个 zip 的条目数打到 stderr（覆盖面数字要看得见，不能只存在于
某个人的终端历史里）。

## `pkg` 块逐项必须是字符串（`manifest.test.ts` 那条 describe）

`pkg.scripts` / `pkg.assets` 是 glob 列表，pkg 的解析器逐项做 `typeof p !== 'string'` 就抛
`Config items must be strings`（`walker.js:upon`）。故任何**对象**形式（`{path, name}`）都是非法配置。

⚠️ **为什么它值得占一档**：这个形状曾经长期躺在 `package.json` 里，每次构建都抛错，而
`build-pkg.mjs` 的 catch 把失败降级成一行 warn、退出码仍是 0 —— 于是一条
**二进制从来没构建成功过**的流水线完整发布了出去，而**三道该拦住它的机制同时失效**：

1. **`build-pkg.mjs` 的 catch 吞掉失败**（降级成 warn，退出码 0）；
2. **CI 不跑测试**（`.cnb.yml` 只做 Docker build + push，无 lint/typecheck/test 门禁）；
3. **zip 护栏零产物时 `skipIf` 降级**（没跑过 `build:pkg` 的工作树上 `dist/` 里零个 zip，
   于是「产物里不该有的形状」全部无法判定）。

⚠️ 三条里**任何一条单独在位都拦得住** —— 它们是同时失效的，所以这一档与另外两处降级面
（`scan.test.ts` 的覆盖面档、`package-dist-source.test.ts` 那档）要一起读。

## 防假绿的位置

- **判据自检**（`scan.test.ts`）：每条负向规则都套一遍合成的脏条目（`dirtySamples`），
  逐条断言「它会红」，并断言每条规则至少被一个样本触发。⚠️ `dirtySamples` 逐条对应今天真实存在的
  **危险形状**，判据只对字符串做路径段匹配 —— **样本文本逐字不许跟着文件搬家改**。
- **锚点全是今天仍存在的形状**（`addDir(zip, keysDir, "keys")`、`fs.cpSync(keysSrc, keysDest, {`
  …），没有一条锚在可能已被删掉的符号名上（通用规则见根 `AGENTS.md`「写护栏时」）。
- **`cfg/users.json` / `cfg/acl.json` 走「内容空骨架」而不是「禁掉 cfg json」**：它们**必须**在
  zip 里（首次启动要读到，否则 abort）。零命中档禁的是「`cfg/` 下出现闭集以外的 `.json`」。
- **`manifest.test.ts` 的 `zipFiles` 刻意不从 `bundles` 派生**：派生会让「五个 zip 齐全」
  变成「`EXPECTED_ZIPS` 与它自己相等」——恒真。
- **`readZip` 抛错而不是返回空清单**：空清单会让「零违规」变成恒真；ZIP64 命中即抛
  （本仓最大的单条目 77MB，远不到那个门槛，真到那天会在这里响）。

## 文件

- `scan.test.ts` — zip 清单这一档：降级面可见 + 判据自检（含「真清单也过同一套判据」）+
  零命中两条（条目名零违规 / `keys/` 逐字节同一性）。
- `payload.test.ts` — 闭集里的两个例外（`cfg/*.json` 空骨架，**只落在这个文件**）+
  收敛档四条（产物表 ↔ 判据闭集 ↔ zip 布局三方对表）。
- `manifest.test.ts` — `package.json` 的 `pkg` 块逐项形状（含探测器自检）+ 正向十条
  （五个 zip 齐全 / `.env.example` 五个键 / `keys/` 闭集 / 仓库 `keys/` 上游 /
  二进制与 Node 包各自必带 / 两个入口都在 / **不再产出 `manager.js`** / 双标签字节相同 /
  中英文文档齐全）。
- `package-dist-source.test.ts` — `package-dist.mjs` 的源码面五条（**不依赖产物**）：
  零 `.env.development|production|local` / `cfg` 空骨架无条件写入 / `addDir` 调用点闭集 /
  `keys/` 仍走那个已审计形状 / `build.mjs` 对 `keys/` 的无过滤镜像。
- `_zip-contents.ts` — 四档共用的面：`readZip`（central directory 解析 + 惰性 inflate）、
  `bundles` / `built`、`EXPECTED_ZIPS` / `pkgVersion`、以及两个以上档用到的闭集常量
  （`AUDITED_EXECUTABLE_NAMES` / `AUDITED_PKI_FILES` / `AUDITED_VENDOR_PREFIX`）。
- `AGENTS.md` — 本文件。

## 相关路径

- `../../../scripts/package-dist.mjs` — zip 的装配脚本（`addDir` 无过滤递归的所在地）。
- `../../../scripts/pkg-binaries.mjs` — 平台 × 入口的产物表（**刻意不被判据 import**）。
- `../../../build.mjs` — `entryPoints` 与 `keys/` 的整目录镜像（zip 里 `keys/` 条目的上游）。
- `../../../package.json` — `bin` 的两个入口 + `version`（`EXPECTED_ZIPS` 的标签来源）。
- `../../../keys/` — 那套**故意入库**的自签测试 PKI（根 `AGENTS.md`「已裁决的 git 状态」有裁决）。
- `../npm-pack/` — **另一条通道**（`files` 白名单那一侧）。
- `../../../tests/helpers/source-scan.ts` — `codeOnly` / `REPO_ROOT`（路径层数只许出现在那里）。