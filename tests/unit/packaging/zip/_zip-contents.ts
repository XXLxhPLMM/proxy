import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { REPO_ROOT } from "../../../helpers/source-scan.js";

/**
 * zip 通道四档共用的面：发行 zip 的清单、产物存在性、闭集常量
 *
 * @description
 * **读真实 zip 的 central directory，不是重跑 `package-dist.mjs`**：
 * central directory 里就有每个条目的名字 / 未压缩长度 / CRC-32 / 数据偏移，**判据本身不需要解压**。
 * 只有要断言内容的那几个小条目（`cfg/*.json` / `keys/*` / `.env.example`）才惰性 inflate ——
 * 二进制包里那个 77MB 的可执行文件绝不能为了算 md5 而解出来。
 * ⚠️ 不重跑打包脚本是硬要求：`package-dist.mjs` 开头会 `unlinkSync` 掉全部 `proxy-v*.zip`，
 * 「为了拿清单而跑一遍」会**先删掉现有产物**，把「读现成产物」变成「重建产物」。
 *
 * ## 闭集常量为什么**独立写一遍**而不是从产物表推导
 * 判据的价值在「新增一个产物必须红，逼人写清它为什么可以分发」。若改成从 `scripts/pkg-binaries.mjs`
 * 推导，闭集就跟着产物表一起变宽，那道闸门自动打开，恰好等于没有闸门。故 `payload.test.ts`
 * 的收敛档反过来断言「两份列表相等」—— 任何一侧单独改动都会红，逼人同时复核两侧。
 *
 * ## 为什么抛错而不是返回空清单
 * 找不到 EOCD / 签名不对 / 出现 ZIP64 时**抛错**：返回空清单会让「零违规」那条断言变成恒真
 * （通用规则见根 `AGENTS.md`「写护栏时」）。本仓最大的单条目 77MB，远不到 ZIP64 门槛；
 * 真到那天会在这里响，而不是悄悄少读几个条目。
 */

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_ZIP64_EOCD_LOCATOR = 0x07064b50;

export interface ZipEntry {
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

export interface ZipBundle {
  /** zip 文件名（basename） */
  file: string;
  archive: ZipArchive;
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

// ── 产物清单：整个进程只读一次 ──

const distDir = path.join(REPO_ROOT, "dist");
const zipFiles = fs.existsSync(distDir)
  ? fs
      .readdirSync(distDir)
      .filter((f) => f.startsWith("proxy-v") && f.endsWith(".zip"))
      .sort()
  : [];

export const bundles: ZipBundle[] = zipFiles.map((f) => ({
  file: f,
  archive: readZip(path.join(distDir, f)),
}));

/**
 * `build:pkg` 留下的 stamp 读在哪
 *
 * @description
 * stamp 由 `scripts/build-pkg.mjs` 写进 `node_modules/.cache/proxy-build-pkg.stamp`，而它描述的
 * 五个 zip 全在 `dist/` 里 —— 两处不同目录是下面那个门控判据的由来。`build.mjs` 只删 `dist/`，
 * 带不走 `node_modules`（整个被 `.gitignore` 忽略）。
 *
 * **读不出内容时按「没构建过」处理**（等价于「构建面不可核 ⇒ 不许在此之上放行」），不抛错 ——
 * 抛错会把整档变成收集失败而不是可读的红。
 */
const STAMP_PATH = path.join(REPO_ROOT, "node_modules", ".cache", "proxy-build-pkg.stamp");

/** stamp 的内容（无法解析时为 `null`，此时 `built` 为 `false`） */
export interface PkgBuildStamp {
  /** 仓库 `package.json` 的 `version`（zip 文件名里的那个标签） */
  version: string;
  /** 六个二进制的 `dist/` 下文件名（由 `scripts/pkg-binaries.mjs` 那张表推导） */
  binaries: string[];
  /** 逐次 pkg 调用（`入口@target`） */
  pkgCalls?: string[];
  /** 写入时刻（ISO-8601，只为让人看得见，不参与任何判据） */
  at?: string;
}

export const stamp: PkgBuildStamp | null = (() => {
  if (!fs.existsSync(STAMP_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(STAMP_PATH, "utf8")) as PkgBuildStamp;
  } catch {
    return null;
  }
})();

/**
 * 四档的门控：**发行 zip 的审计面此刻在不在**（stamp 可解析 **且** `dist/` 下至少一个 zip 在场）
 *
 * @description
 * ⚠️ 它答的是「清单此刻可不可判」，不是「历史上跑没跑过 `build:pkg`」：stamp 住在
 * `node_modules/.cache/`，而 `build.mjs` 的第一步是无条件 `rmSync(dist)`，带不走它。收尾顺序
 * `lint → typecheck → test → build` 里 `build` 排在 `test` 之后，于是**跑过 `build:pkg` 又跑过
 * `pnpm build`** 的工作树上 stamp 活着而 zip 归零 —— 那一刻说「构建过」等于让「跑过 `pnpm build`」
 * 冒充「跑过 `build:pkg`」，而门里那批 `for (const b of bundles)` 形状的断言在零产物时是
 * **零次迭代的通过**（不是红，是根本没判任何东西）。
 *
 * **判据取 `bundles.length > 0` 而不是「五个 zip 全在」**：后者会把「只少了几个」与「标签对不上
 * （`stamp.version` 落后于 `package.json`）」一并降级成静默跳过，而这两者的牙齿恰好在
 * `manifest.test.ts` 的「五个发行 zip 齐全」那条上（它对着目录读，不看这个门控）。
 * 只有**零产物**这一个状态关门，其余异常状态仍由真断言红。
 *
 * 关门**不是静默**：零产物时下面那行 `process.stderr.write` 报出成因与补救动作。
 */
export const built = stamp !== null && bundles.length > 0;

if (stamp !== null && bundles.length === 0) {
  const { at, version } = stamp;
  process.stderr.write(
    `zip 护栏：🔴 有 build:pkg 的 stamp（构建于 ${at ?? "未记时刻"}，version ${version}）` +
      "但 dist/ 下零个 proxy-v*.zip —— pnpm build 清空过 dist/（build.mjs 第一步 rmSync(dist)，" +
      "带不走 node_modules/.cache 里的 stamp），zip 清单那几档已降级跳过；重跑 pnpm build:pkg 才有清单可判\n",
  );
}

export const pkgVersion = (
  JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as { version: string }
).version;

/** `build:pkg` 应当产出的五个 zip（标签集与 `package-dist.mjs` 的两个目标表一致） */
export const EXPECTED_ZIPS = [
  `proxy-v${pkgVersion}-win-x64.zip`,
  `proxy-v${pkgVersion}-linux-x64.zip`,
  `proxy-v${pkgVersion}-macos-x64.zip`,
  `proxy-v${pkgVersion}-node16.zip`,
  `proxy-v${pkgVersion}-node22.zip`,
];

/**
 * 发行 zip 允许出现的可执行文件名（**闭集**：6 个，来自 `./pkg-binaries.mjs` 的展平表）
 *
 * @description
 * ⚠️ **刻意不 import `scripts/pkg-binaries.mjs`**：见本文件头「闭集常量为什么独立写一遍」。
 *
 * **CLI 的二进制也在闭集里**（`proxy-cli-*` 那三个）：它们是 `package-dist.mjs` 明确要装的东西。
 * ⚠️ 这一档曾经只列了服务端那三个，而它当时是绿的 —— 因为二进制**从来没构建成功过**
 * （`pkg.scripts` 的 `{path,name}` 写法让 pkg 每次抛错，而 `build-pkg.mjs` 的 catch 把失败降级成
 * 一行 warn，退出码仍是 0）。闸门只在产物真出现时才会被触发，这正是它需要单独一档收敛断言的原因。
 */
export const AUDITED_EXECUTABLE_NAMES = new Set([
  "proxy-win.exe",
  "proxy-linux",
  "proxy-macos",
  "proxy-cli-win.exe",
  "proxy-cli-linux",
  "proxy-cli-macos",
]);

/** 唯一允许整包进 zip 的第三方依赖（Node 16–22 的 SQLite 驱动，见 `addWasmDriver` 的理由段） */
export const AUDITED_VENDOR_PREFIX = "node_modules/node-sqlite3-wasm/";

/**
 * 仓库 `keys/` 自带的那套**故意入库**的自签测试 PKI 的文件名
 *
 * @description 两档都用它：负向判据用它判「`keys/` 下闭集外的文件」，正向档用它判闭集不多不少。
 * 分成两份会让两道牙一起变松，故只许这一份。
 */
export const AUDITED_PKI_FILES = [
  "ca.crt",
  "ca.key",
  "ca.srl",
  "client.crt",
  "client.key",
  "server.crt",
  "server.key",
];