import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import { codeOnly } from "../helpers/source-scan.js";

/**
 * 打包内容护栏（`build:pkg` 的 5 个 standalone zip 清单 + `package-dist.mjs` 源码面）
 *
 * @description
 * **本档与 `pack-contents.test.ts` 的分工：两条互不相通的打包通道，各守各的。**
 * `package.json` 的 `files` 白名单只管 `npm pack` 那条 tarball，对 `dist/*.zip` **完全看不见**；
 * 反过来 zip 里带不带 `keys/`，白名单也无从表达。故本档是 zip 通道**唯一**的牙齿。
 *
 * ## `keys/` 收私钥是**有意的**（故本档守的是「闭集 + 同一性」，不是「零私钥」）
 * 三处事实锁死了这个设计：
 * - `.env.example` 的缺省是 `TLS_KEY=keys/server.key` / `TLS_CERT=keys/server.crt`，
 *   按 configDir 相对解析 —— zip 里没有 `keys/server.key`，https / sockss5 入站直接起不来。
 * - `readme/usage/*.md` 的目录树把 `keys/{server,ca,client}.{crt,key}` 写进发行物布局，
 *   并附「生产环境请替换为正式证书」。
 * - `build.mjs` 无条件把仓库 `keys/` 整目录 `cpSync` 进 `dist/keys/`，`package-dist.mjs`
 *   再把 `dist/keys/` 整个 `addDir` 进每个 zip。
 *
 * **于是危险点不是「有私钥」，而是「私钥的集合与来源不受约束」**：往仓库 `keys/` 里丢一份
 * 自己的正式证书，`build.mjs` 的无过滤镜像 + `addDir` 的无过滤递归会**静默**把它送进全部 5 个
 * zip 分发出去。故零命中档对 `keys/` 立两条判据：条目集合**闭集**（不多不少那 7 个已入库文件）+
 * 逐条**逐字节同一性**（与仓库 `keys/` 同名文件相同）。前者抓「多带一个」，后者抓「换掉一个」。
 * 二者合起来等价于「zip 只能带仓库里那份早已公开的测试 PKI」，暴露面增量为零。
 *
 * ## `node16.zip` 与 `node22.zip` 的 `app.js` 相同是**有意的双标签约定**，不是异常
 * 同一份 esbuild 产物打两个标签（`package-dist.mjs` 里有整段理由：pkg 6.22 的远程 cache 没有
 * node16 预编译基础二进制，二进制包做不到双标签，而 `app.js` 本身与 Node 版本无关）。
 * 本档**正向断言**这两个条目的 CRC 相同，把约定钉住 —— 免得将来有人把「字节相同」当异常顺手「修」掉。
 *
 * ## 本档的形态：读真实 zip 的 central directory，不是重跑 `package-dist.mjs`
 * central directory 里就有每个条目的名字 / 未压缩长度 / CRC-32 / 数据偏移，**判据本身不需要解压**。
 * 只有要断言内容的那几个小条目（`cfg/*.json` / `keys/*` / `.env.example`）才惰性 inflate ——
 * 二进制包里那个 77MB 的可执行文件绝不能为了算 md5 而解出来。
 * ⚠️ 不重跑打包脚本是硬要求：`package-dist.mjs` 开头会 `unlinkSync` 掉全部 `proxy-v*.zip`，
 * 「为了拿清单而跑一遍」会**先删掉现有产物**，把「读现成产物」变成「重建产物」。
 *
 * ## 零命中 vs 正向 vs 静态：为什么大部分判据是「闭集枚举」而不是「禁掉某几样」
 * 「不许出现 X」挡不住「Y 悄悄溜进来」。本档的正向档逐项列出**允许**的形状，新增一个条目时
 * 必须红、逼人写清「它为什么可以进发行 zip」；这与 `pack-contents.test.ts` 里
 * `allowedInDist` 那条是同一个手法。
 *
 * ## 降级面显式报出（`覆盖面` 档）
 * zip 是 `build:pkg` 的产物且整个 `dist/` 被 gitignore，没跑过打包的工作树上不存在。
 * 缺失时 1–4 档 `skipIf` 跳过，但本档会把「此刻只覆盖了静态不变式 + 判据自检」**打出来**，
 * 不静默假装全覆盖；存在时把每个 zip 的条目数打到 stderr（覆盖面数字要看得见，不能只存在于
 * 某个人的终端历史里）。
 *
 * ## 防假绿（通用规则见根 `AGENTS.md`「写护栏时」）
 * - **判据自检**：每条负向规则都套一遍合成的脏条目，逐条断言「它会红」；探测器写坏时这一档立刻红，
 *   而不是让上面所有负向断言一起变成永远通过。
 * - **锚点全是今天仍存在的形状**（`addDir(zip, keysDir, "keys")`、`fs.cpSync(keysSrc, keysDest, {`
 *   …），没有一条锚在可能已被删掉的符号名上。
 * - **`cfg/users.json` / `cfg/acl.json` 走「内容空骨架」而不是「禁掉 cfg json」**：它们**必须**在
 *   zip 里（首次启动要读到，否则 abort）。零命中档禁的是「`cfg/` 下出现闭集以外的 `.json`」。
 */

const ROOT = path.resolve(__dirname, "..", "..");
const DIST = path.join(ROOT, "dist");
const packDistSource = codeOnly(fs.readFileSync(path.join(ROOT, "scripts", "package-dist.mjs"), "utf8"));
const buildSource = codeOnly(fs.readFileSync(path.join(ROOT, "build.mjs"), "utf8"));

// ── zip 读取：只解析 central directory，内容按需惰性 inflate ──

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_ZIP64_EOCD_LOCATOR = 0x07064b50;

interface ZipEntry {
  /** zip 内路径（`/` 分隔） */
  name: string;
  /** 未压缩长度 */
  size: number;
  /** CRC-32（central directory 里读到的，未经本地校验） */
  crc: number;
  /** 压缩方法：0 = stored，8 = deflate */
  method: number;
  /** 压缩长度 */
  compressedSize: number;
  /** 文件缓冲区内数据起始偏移 */
  dataOffset: number;
}

interface ZipArchive {
  entries: ZipEntry[];
  /** 按条目名取内容（惰性解压；同一个条目只解一次） */
  bytes: (name: string) => Buffer;
}

/**
 * 解析 zip 的 central directory
 *
 * @description
 * 判据只需要条目名 / 长度 / CRC / 数据偏移，这些**全在 central directory 里**，不解压也拿得到。
 * 数据偏移由 local file header 的变长字段（文件名 + extra）算出，所以两次都要走一遍 header。
 * 找不到 EOCD、central directory 签名不对、或出现 ZIP64 时**抛错**而不是返回空清单 ——
 * 返回空清单会让「零违规」这条断言变成恒真（通用规则见根 `AGENTS.md`「写护栏时」）。
 * 本仓最大的单条目 77MB，远不到 ZIP64 门槛；真到那天会在这里响，而不是悄悄少读几个条目。
 */
function readZip(file: string): ZipArchive {
  const buf = fs.readFileSync(file);

  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i -= 1) {
    if (buf.readUInt32LE(i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }

  if (eocd < 0) throw new Error(`${path.basename(file)}：找不到 EOCD 记录，判据会拿到空清单`);

  // ZIP64 的 EOCD locator 紧跟在 EOCD 之前；命中即抛错而不是按 32 位字段读出一堆垃圾
  if (eocd >= 20 && buf.readUInt32LE(eocd - 20) === SIG_ZIP64_EOCD_LOCATOR) {
    throw new Error(`${path.basename(file)}：ZIP64 尚未支持，护栏需显式扩展读法`);
  }

  const total = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];

  for (let i = 0; i < total; i += 1) {
    if (buf.readUInt32LE(at) !== SIG_CENTRAL) {
      throw new Error(`${path.basename(file)}：第 ${i} 个 central directory 条目签名不对`);
    }

    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const localOffset = buf.readUInt32LE(at + 42);
    const name = buf.toString("utf8", at + 46, at + 46 + nameLen);
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);

    entries.push({
      name,
      method: buf.readUInt16LE(at + 10),
      crc: buf.readUInt32LE(at + 16),
      compressedSize: buf.readUInt32LE(at + 20),
      size: buf.readUInt32LE(at + 24),
      dataOffset: localOffset + 30 + localNameLen + localExtraLen,
    });

    at += 46 + nameLen + extraLen + commentLen;
  }

  const cache = new Map<string, Buffer>();

  return {
    entries,
    bytes(name: string): Buffer {
      const hit = cache.get(name);
      if (hit) return hit;
      const entry = entries.find((e) => e.name === name);
      if (!entry) throw new Error(`zip 里没有条目 ${name}`);
      const raw = buf.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
      const data = entry.method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw);
      cache.set(name, data);
      return data;
    },
  };
}

// ── 判据 ──

/** 发行 zip 允许出现的顶层条目（闭集：新增顶层必须红，逼人写清它为什么可以分发） */
const AUDITED_TOP_LEVEL = new Set([
  ".env.example",
  "README.en.md",
  "README.zh-CN.md",
  "USAGE.en.md",
  "USAGE.zh-CN.md",
  "app.js",
  "package.json",
  "cfg/",
  "keys/",
  "node_modules/",
]);

/** 平台可执行文件名（`binaryMap` 那三个；其余名字一律不许出现在顶层） */
const AUDITED_EXECUTABLE = /^proxy-(?:win\.exe|linux|macos)$/;

/** 唯一允许整包进 zip 的第三方依赖（Node 16–22 的 SQLite 驱动，见 `addWasmDriver` 的理由段） */
const AUDITED_VENDOR_PREFIX = "node_modules/node-sqlite3-wasm/";

/**
 * `cfg/` 下允许出现的全部条目（闭集）
 *
 * @description
 * 两个 `.example` 是模板；`users.json` / `acl.json` 首次启动要读到，缺一个就 abort，
 * 故它们**必须**在 zip 里（内容另由零命中档的「空骨架」判据锁死）。
 * 写成整个 `cfg/` 的闭集而不是「只禁 `.json`」：账本的缺省落点 `QUOTA_USAGE_DIR=cfg/usage`
 * 产出的是 `usage.jsonl` / `usage.db`，**不匹配任何扩展名黑名单** —— 目录维度才是它们的形状。
 */
const AUDITED_CFG = new Set([
  "cfg/users.json.example",
  "cfg/acl.json.example",
  "cfg/users.json",
  "cfg/acl.json",
]);

/** 仓库 `keys/` 自带的那套**故意入库**的自签测试 PKI 的文件名 */
const AUDITED_PKI_FILES = [
  "ca.crt",
  "ca.key",
  "ca.srl",
  "client.crt",
  "client.key",
  "server.crt",
  "server.key",
];

/** 路径段是否等于日志目录名，命中即运行期产物 */
const isLogSegment = (p: string): boolean =>
  p.split("/").some((seg) => seg === "log" || seg === "logs");

/** `.env.*` 里除 `.env.example` 以外的一切（模板之外的都是开发者本机状态） */
const isNonExampleEnv = (p: string): boolean => {
  const name = p.slice(p.lastIndexOf("/") + 1);
  return (name.startsWith(".env.") || name === ".env") && name !== ".env.example";
};

/** 证书与私钥材料：公开证书与私钥在这里**不作区分** —— 判据只管「出现在哪儿」，不管是不是公开的 */
const isCertOrKeyMaterial = (p: string): boolean => /\.(key|srl|pem|p12|pfx|crt|cer)$/i.test(p);

/** 源码 / 构建脚本 / 测试目录一律不分发 */
const isSourceTree = (p: string): boolean => /(^|\/)(src|scripts|tests)\//.test(p);

/**
 * zip 内路径的负向判据，**逐条**独立可读（失败时直接指出是哪一条）
 *
 * @description
 * `keys/` 下的证书私钥**豁免扩展名判据**（那是有意分发的，见文件头），改由两条闭集判据接管：
 * 名字必须在 `AUDITED_PKI_FILES` 里，且（内容判据见零命中档的第二条）必须与仓库同名文件逐字节相同。
 * @param p zip 内的相对路径（`/` 分隔）
 * @returns 命中的规则名；零命中返回 `null`
 */
function entryVerdict(p: string): string | null {
  if (isLogSegment(p)) return "log/logs 路径段（运行期日志目录）";
  if (isNonExampleEnv(p)) return "非 .example 的 .env.*（开发者本机状态，含明文凭证）";

  if (isCertOrKeyMaterial(p)) {
    // 证书/私钥只允许出现在 keys/ 之下；keys/ 之内则要闭集内的文件名
    if (!p.startsWith("keys/")) return "keys/ 之外的证书/私钥材料";
    if (!AUDITED_PKI_FILES.includes(p.slice("keys/".length))) {
      return "keys/ 下闭集外的文件（只许带那套已入库的自签测试 PKI）";
    }
  }

  if (p.startsWith("cfg/") && !AUDITED_CFG.has(p)) {
    return "cfg/ 下闭集外的文件（含密码/名单或运行期账本）";
  }

  if (isSourceTree(p)) return "src/ scripts/ tests/ 源码目录";

  if (p.startsWith("node_modules/") && !p.startsWith(AUDITED_VENDOR_PREFIX)) {
    return "node_modules 下闭集外的依赖";
  }

  const top = p.split("/")[0];
  const isDirEntry = p.endsWith("/");
  if (isDirEntry) return "目录条目（发行 zip 只收文件，不收目录占位）";
  if (!AUDITED_TOP_LEVEL.has(top) && !AUDITED_TOP_LEVEL.has(`${top}/`) && !AUDITED_EXECUTABLE.test(top)) {
    return "闭集外的顶层条目";
  }

  return null;
}

/** 收集全部命中的规则 */
function verdictsOf(paths: readonly string[]): string[] {
  return paths.flatMap((p) => {
    const hit = entryVerdict(p);
    return hit ? [`${p} —— ${hit}`] : [];
  });
}

// ── 产物清单：整个文件只读一次 ──

interface ZipBundle {
  /** zip 文件名（basename） */
  file: string;
  archive: ZipArchive;
}

const zipFiles = fs.existsSync(DIST)
  ? fs.readdirSync(DIST)
      .filter((f) => f.startsWith("proxy-v") && f.endsWith(".zip"))
      .sort()
  : [];

const bundles: ZipBundle[] = zipFiles.map((f) => ({ file: f, archive: readZip(path.join(DIST, f)) }));

const built = bundles.length > 0;

/** 仓库 `keys/` 的文件名清单（zip 里 keys/ 条目的上游） */
const repoKeyFiles = fs.existsSync(path.join(ROOT, "keys"))
  ? fs.readdirSync(path.join(ROOT, "keys")).sort()
  : [];

const pkgVersion = (
  JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as { version: string }
).version;

/** `build:pkg` 应当产出的五个 zip（标签集与 `package-dist.mjs` 的两个目标表一致） */
const EXPECTED_ZIPS = [
  `proxy-v${pkgVersion}-win-x64.zip`,
  `proxy-v${pkgVersion}-linux-x64.zip`,
  `proxy-v${pkgVersion}-macos-x64.zip`,
  `proxy-v${pkgVersion}-node16.zip`,
  `proxy-v${pkgVersion}-node22.zip`,
];

/** 二进制 zip 的标签后缀 → zip 内可执行文件名（`binaryMap` 那张表的内容） */
const BINARY_ZIP_EXECUTABLE: Array<[string, string]> = [
  ["-win-x64.zip", "proxy-win.exe"],
  ["-linux-x64.zip", "proxy-linux"],
  ["-macos-x64.zip", "proxy-macos"],
];

describe("standalone zip 内容护栏（build:pkg 发行物）", () => {
  describe("覆盖面（产物缺失时的降级面，必须看得见）", () => {
    it("报出本档此刻实际覆盖到哪一层 + 每个 zip 的条目数", () => {
      if (!built) {
        process.stderr.write(
          "zip 护栏：⚠️ dist/ 下零个 proxy-v*.zip → 第 1–4 档（真实 zip 清单）已跳过，" +
            "只剩静态不变式 + 判据自检；先跑 pnpm build:pkg 再看本档\n",
        );
      } else {
        for (const b of bundles) {
          process.stderr.write(`zip 护栏：${b.file} —— ${b.archive.entries.length} 个条目\n`);
        }
      }

      expect(true).toBe(true);
    });

    it("每个 zip 都能被解析成非空清单（空清单会让零命中恒真）", () => {
      if (!built) return;
      expect(bundles.length).toBeGreaterThan(0);
      for (const b of bundles) {
        expect(b.archive.entries.length, `${b.file} 条目数为 0`).toBeGreaterThan(0);
      }
    });
  });

  describe("判据自检（防「探测器写坏了导致所有负向断言恒绿」）", () => {
    // 脏条目逐条对应今天真实存在的**危险形状**，不是凭空编的
    const dirtySamples = [
      "log/2026-09-23-15.jsonl",
      "log/usage.jsonl",
      ".env.development",
      ".env.production",
      ".env.local",
      "dist/.env.production",
      "server.key", // 私钥落在顶层
      "cfg/keys/ca.key", // 证书材料落在 keys/ 之外
      "keys/", // 目录占位条目
      "keys/prod.key", // keys/ 闭集外的新增私钥
      "keys/server.pem", // keys/ 闭集外的另一种私钥编码
      "cfg/usage/usage.db", // 运行期账本
      "cfg/usage/usage.jsonl", // 运行期账本
      "cfg/accounts.json", // cfg/ 闭集外的账号表
      "src/cli.ts",
      "scripts/package-dist.mjs",
      "tests/unit/zip-contents.test.ts",
      "node_modules/dotenv/lib/main.js",
      "extra-notes.md", // 闭集外的顶层
    ];

    it.each(dirtySamples)("能抓住 %s", (sample) => {
      expect(entryVerdict(sample)).not.toBeNull();
    });

    it("每条规则各被至少一个样本触发（没有写了却没人验的规则）", () => {
      const ruleNames = [
        "log/logs 路径段（运行期日志目录）",
        "非 .example 的 .env.*（开发者本机状态，含明文凭证）",
        "keys/ 之外的证书/私钥材料",
        "keys/ 下闭集外的文件（只许带那套已入库的自签测试 PKI）",
        "cfg/ 下闭集外的文件（含密码/名单或运行期账本）",
        "src/ scripts/ tests/ 源码目录",
        "node_modules 下闭集外的依赖",
        "目录条目（发行 zip 只收文件，不收目录占位）",
        "闭集外的顶层条目",
      ];
      const triggered = new Set(
        dirtySamples.map((s) => entryVerdict(s)).filter((v): v is string => v !== null),
      );
      for (const rule of ruleNames) {
        expect([...triggered].some((t) => t.endsWith(rule)), `规则从未被样本触发：${rule}`).toBe(true);
      }
    });

    it("合法样本零命中（判据没有宽到把正常产物也咬掉）", () => {
      const clean = [
        ".env.example",
        "README.zh-CN.md",
        "README.en.md",
        "USAGE.zh-CN.md",
        "USAGE.en.md",
        "app.js",
        "package.json",
        "proxy-win.exe",
        "proxy-linux",
        "proxy-macos",
        "cfg/users.json.example",
        "cfg/acl.json.example",
        "cfg/users.json",
        "cfg/acl.json",
        "keys/ca.crt",
        "keys/ca.key",
        "keys/ca.srl",
        "keys/client.crt",
        "keys/client.key",
        "keys/server.crt",
        "keys/server.key",
        "node_modules/node-sqlite3-wasm/dist/node-sqlite3-wasm.js",
        "node_modules/node-sqlite3-wasm/dist/node-sqlite3-wasm.wasm",
        "node_modules/node-sqlite3-wasm/package.json",
      ];
      expect(verdictsOf(clean)).toEqual([]);
    });

    it("每个真实 zip 的名字零违规（判据自检之外，真清单也过同一套判据）", () => {
      if (!built) return;
      for (const b of bundles) {
        expect(verdictsOf(b.archive.entries.map((e) => e.name)), b.file).toEqual([]);
      }
    });
  });

  describe.skipIf(!built)("1 零命中：zip 清单里不许出现的形状", () => {
    it("全部 zip 的条目名零违规", () => {
      for (const b of bundles) {
        expect(verdictsOf(b.archive.entries.map((e) => e.name)), b.file).toEqual([]);
      }
    });

    it("keys/ 条目逐条与仓库同名文件逐字节相同（抓「把正式证书掉进 keys/ 后静默分发」）", () => {
      // 这条是 `addDir` 无过滤递归的**唯一**兜底：`package-dist.mjs` 与 `build.mjs` 两处都不筛选，
      // 所以「谁进了 zip」这件事的真相源只能是**字节比对**。改动 build/package 两个脚本都绕不开它。
      for (const b of bundles) {
        const keyEntries = b.archive.entries.filter((e) => e.name.startsWith("keys/"));
        expect(keyEntries.length, `${b.file} 零个 keys/ 条目`).toBeGreaterThan(0);
        for (const e of keyEntries) {
          const onDisk = path.join(ROOT, "keys", e.name.slice("keys/".length));
          expect(fs.existsSync(onDisk), `${e.name} 在仓库 keys/ 里不存在：那是仓库外的东西，不许分发`).toBe(
            true,
          );
          expect(
            b.archive.bytes(e.name).equals(fs.readFileSync(onDisk)),
            `${b.file} 的 ${e.name} 与仓库 keys/ 下的同名文件内容不同`,
          ).toBe(true);
        }
      }
    });

    it("cfg/users.json 与 cfg/acl.json 是空骨架（闭集里的两个例外也不许夹带真实数据）", () => {
      for (const b of bundles) {
        const users = b.archive.bytes("cfg/users.json").toString("utf8");
        expect(users, `${b.file} 的 cfg/users.json 不是空数组`).toBe("[]\n");

        const acl = JSON.parse(b.archive.bytes("cfg/acl.json").toString("utf8")) as unknown;
        // 收**数组本身**而不是数组元素：空名单的元素集恒为空，判据落到元素上就永远验不到东西
        const lists: unknown[] = [];
        const walk = (node: unknown): void => {
          if (Array.isArray(node)) lists.push(node);
          else if (node && typeof node === "object") Object.values(node).forEach(walk);
        };
        walk(acl);
        expect(lists.length, `${b.file} 的 cfg/acl.json 结构里一个名单都没有`).toBeGreaterThan(0);
        expect(
          lists.every((v) => (v as unknown[]).length === 0),
          `${b.file} 的 cfg/acl.json 里有非空名单`,
        ).toBe(true);
      }
    });
  });

  describe.skipIf(!built)("2 正向：包不许被收空 / 命名约定不许被悄悄改掉", () => {
    it("五个发行 zip 齐全（build:pkg 的五个目标一个都不能少）", () => {
      expect(zipFiles).toEqual([...EXPECTED_ZIPS].sort());
    });

    it(".env.example 在每个 zip 里", () => {
      for (const b of bundles) {
        expect(b.archive.entries.map((e) => e.name), b.file).toContain(".env.example");
      }
    });

    it(".env.example 里带齐五个驱动键 + 账本目录键（改名或拼错即红）", () => {
      const required = [
        "AUTH_USERS_DRIVER=",
        "AUTH_USERS_DB=",
        "ACL_DRIVER=",
        "QUOTA_USAGE_DRIVER=",
        "QUOTA_USAGE_DIR=cfg/usage",
      ];
      for (const b of bundles) {
        const text = b.archive.bytes(".env.example").toString("utf8");
        for (const key of required) {
          expect(text, `${b.file} 的 .env.example 缺 ${key}`).toContain(key);
        }
      }
    });

    it("keys/ 条目闭集：不多不少那套已入库的自签测试 PKI", () => {
      for (const b of bundles) {
        const names = b.archive.entries
          .filter((e) => e.name.startsWith("keys/"))
          .map((e) => e.name.slice("keys/".length))
          .sort();
        expect(names, b.file).toEqual([...AUDITED_PKI_FILES].sort());
      }
    });

    it("仓库 keys/ 自身也钉在这个闭集上（往里丢正式证书会在 zip 之外先红）", () => {
      // 这是 zip 判据的**上游**：`build.mjs` 无过滤地把仓库 keys/ 整目录镜像进 dist/keys/。
      // 上游多出的文件会一路走到每一个 zip，所以要在上游就钉住。
      expect(repoKeyFiles).toEqual([...AUDITED_PKI_FILES].sort());
    });

    it("二进制包带自己的可执行文件、Node 包带 app.js 与最小 package.json", () => {
      for (const b of bundles) {
        const names = b.archive.entries.map((e) => e.name);
        // 标签 → 可执行文件名的映射是 `binaryMap` 那张表的内容，按后缀取表项而不是从文件名里
        // 切字符串（`proxy-v5.2.0-…` 里第一个 `-` 在版本号上，切出来的标签是错的）
        const binary = BINARY_ZIP_EXECUTABLE.find(([suffix]) => b.file.endsWith(suffix));
        if (binary) {
          expect(names, `${b.file} 缺可执行文件 ${binary[1]}`).toContain(binary[1]);
        } else {
          expect(names, b.file).toContain("app.js");
          expect(names, b.file).toContain("package.json");
          expect(names, b.file).toContain(`${AUDITED_VENDOR_PREFIX}dist/node-sqlite3-wasm.wasm`);
        }
      }
    });

    it("node16 与 node22 的 app.js 字节相同 —— 有意的双标签约定，不是异常", () => {
      const node16 = bundles.find((b) => b.file.endsWith("-node16.zip"));
      const node22 = bundles.find((b) => b.file.endsWith("-node22.zip"));
      expect(node16).toBeDefined();
      expect(node22).toBeDefined();
      if (!node16 || !node22) return;

      const pick = (b: ZipBundle): ZipEntry => {
        const e = b.archive.entries.find((x) => x.name === "app.js");
        if (!e) throw new Error(`${b.file} 里没有 app.js`);
        return e;
      };

      const a = pick(node16);
      const c = pick(node22);
      expect(a.size, "两个标签的 app.js 长度不同，双标签约定被破坏了").toBe(c.size);
      expect(a.crc, "两个标签的 app.js CRC 不同，双标签约定被破坏了").toBe(c.crc);
    });

    it("中英文 README 与使用指南齐全", () => {
      for (const b of bundles) {
        const names = b.archive.entries.map((e) => e.name);
        for (const doc of ["README.zh-CN.md", "README.en.md", "USAGE.zh-CN.md", "USAGE.en.md"]) {
          expect(names, `${b.file} 缺 ${doc}`).toContain(doc);
        }
      }
    });
  });

  describe("3 静态不变式：package-dist.mjs 的源码面（不依赖打包产物）", () => {
    it("零 .env.development / .env.production / .env.local 的 addFile（只允许 .env.example）", () => {
      // 注释已被 codeOnly 剥掉 —— 这里点名的正是**代码面**：某个拷贝里带上这三个名字，
      // 就会把开发者本机的明文上游凭证分发出去
      expect(/development|production|local/.test(packDistSource)).toBe(false);
    });

    it("cfg 空骨架是无条件写入：addCommonAssets 里写 cfg/*.json 的两处零 existsSync 守卫", () => {
      // 与 `pack-contents.test.ts` 对 `build.mjs` 的同类断言同源：`!existsSync` 守卫保住的
      // 恰恰是它本要防的那份文件（`dist/cfg/users.json` 若曾被真实数据污染就永不刷新）
      const at = packDistSource.indexOf("function addCommonAssets(");
      expect(at).toBeGreaterThanOrEqual(0);
      const body = packDistSource.slice(at, packDistSource.indexOf("function addWasmDriver(", at));
      expect(body).toContain('Buffer.from("[]\\n"), "cfg/users.json"');
      expect(body).toContain('"cfg/acl.json"');
      expect(body).toMatch(/zip\.addBuffer\(/);
      // 守卫只允许出现在 envExample / cfgDir / keysDir 上，绝不落在 cfg/*.json 上
      const guards = [...body.matchAll(/existsSync\(([^)]*)\)/g)].map((m) => m[1]);
      expect(guards.length, "addCommonAssets 里零 existsSync 守卫，形状变了需复核").toBeGreaterThan(0);
      for (const guard of guards) {
        expect(guard).not.toContain("users.json");
        expect(guard).not.toContain("acl.json");
      }
    });

    it("addDir 的调用点闭集：只许那两个已审计目标 + addDir 自身的递归调用", () => {
      // `addDir` 是**无过滤递归**：给它一个仓库自有的目录，就等于把那个目录此刻的**全部**内容
      // 分发出去，而清单的真相源随即消失（这正是 keys/ 那条字节比对存在的原因）。
      // 闭集钉住调用点 ⇒ 新增一个 addDir 目标必须红，逼人显式复核那个目录里有什么。
      const audited = new Set([
        'addDir(zip, keysDir, "keys");',
        "addDir(zip, full, path.join(zipBase, f));",
        'addDir(zip, fs.realpathSync(pkgDir), path.join("node_modules", "node-sqlite3-wasm"));',
      ]);
      const found = packDistSource
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("addDir(") && line.endsWith(");"));
      expect(found.length, "零个 addDir 调用点，形状变了需复核").toBeGreaterThan(0);
      expect(found.filter((line) => !audited.has(line))).toEqual([]);
    });

    it("keys/ 仍走 addDir(zip, keysDir, \"keys\") 这个已审计形状", () => {
      // 一旦它被换成带扩展名过滤的循环，这条会红：那是**有意的收紧**，需要同步复核
      // readme 的目录树与 `.env.example` 的 TLS_KEY 缺省还成不成立，而不是默默生效
      expect(packDistSource).toContain('addDir(zip, keysDir, "keys");');
    });

    it("build.mjs 把仓库 keys/ 无过滤镜像进 dist/（故 zip 侧必须靠字节比对兜底）", () => {
      // 这是 zip 里 keys/ 条目的**上游**，且它同样是整目录镜像。断言「今天无 filter」，
      // 是在记录那条必须由 zip 判据兜住的理由；哪天加了 filter，这条会提醒人复核 dist/keys 的形状。
      const at = buildSource.indexOf("fs.cpSync(keysSrc, keysDest, {");
      expect(at).toBeGreaterThanOrEqual(0);
      const call = buildSource.slice(at, buildSource.indexOf("});", at));
      expect(call).toContain("recursive: true");
      expect(call, "keys 拷贝带了 filter，dist/keys 的形状变了，需复核 zip 侧判据").not.toContain("filter");
    });
  });
});
