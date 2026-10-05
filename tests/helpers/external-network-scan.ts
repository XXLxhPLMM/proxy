/**
 * 「测试零外网依赖」源码级护栏的公共工具（扫描器 + 公网 host 白名单）
 *
 * @description
 * 这份工具住在 `tests/helpers/`（**不在**扫描范围内），原因只有一个：**避免自指**。
 * 白名单里必须逐条写出被豁免的公网 host 字面量（`example.com`、`1.2.3.4`…），
 * 若这张表放在被扫描的目录里，扫描器会把自己的白名单当成违规命中 —— 那是纯自噬。
 * 于是分工与 `source-scan.ts` 一致：**文本面在 helper，行为面（断言）在 `unit/` 的档里**。
 *
 * ── 扫描口径（三条，缺一条就得出错误结论）────────────────────────────
 * 1. **先 `codeOnly` 去注释**（复用 `source-scan.ts` 的同一份实现，字面量与行号口径完全一致）。
 *    注释里点名被禁 host 是在**描述这条不变量本身**，把它纳入断言就成了自我否定。
 *    这不是理论风险：处置记录里的反引号（如 `// …外网 ws.postman-echo.com:443…`）会让朴素引号
 *    扫描把注释内容吞成「字符串字面量」，凭空造出一条违规命中。
 * 2. **只在字符串字面量内部匹配 host**。成员访问（`entry.name` / `log.info` / `context.store`）
 *    与 host 在语法上无法区分（`name`/`store`/`at` 都是真实 TLD），靠字面量边界把前者剔掉。
 *    残留的误报（字符串里恰好写着 `c.name` 这种**非 host 文本**）走白名单豁免并写明理由，
 *    **不靠缩小 TLD 表来让噪声消失** —— 那等于给「漏检公网 TLD」开后门。
 * 3. **公网**的定义：顶级域不在 RFC 2606/6761 保留集（`test`/`example`/`invalid`/`localhost`/`local`/`onion`）
 *    之内；IPv4 需排除回环 / 私网 / 链路本地 / 组播 / 越界 octet。`example.com` **算公网**
 *    （它在 `.com` 之下、真的可解析，是本仓最可能意外拨出去的那个 host）。
 *
 * ── 两条断言面（为什么要两层）────────────────────────────────────────
 * - **A 层（钉死拨号位，零白名单）**：建链原语（`net.connect` / `tls.connect` / `http[s].request` /
 *   `fetch` / `dns.*` …）的**实参里不许出现公网 host 字面量**。这层有牙齿、不需要豁免。
 * - **B 层（普查 + 显式申报）**：`tests/{unit,integration,library}/**` 里出现的每一个公网 host
 *   字面量，都必须能在白名单里找到**同 file + 同 host** 的条目并附理由；反向也断言
 *   （白名单里不许有已失效条目），否则这张表会腐烂成「什么都往里塞」的黑洞。
 *   B 层抓的是 A 层看不见的形态：**host 作为本地 helper 的实参**（形如
 *   `wssViaConnect(port, "ws.postman-echo.com", 443)` —— 文本上与名单条目无法区分，
 *   只能靠「必须申报」这道人工闸门）。
 *
 * ── 白名单纪律（本档锁的：这张表不许变成黑洞）────────────────────────
 * - **按目标目录主题分片住在 `public-hosts/`**：测试目录正在按主题重组，这张表会被多个
 *   agent 并发改不同主题 —— 单文件必冲突。分片粒度就是**目标目录名**，每个 agent 只碰
 *   自己那一片；本文件只负责按固定顺序拼接（那片地图在 `tests/helpers/AGENTS.md`）。
 * - **双向断言，缺一头就烂**：未申报即红，**豁免失效也红**。只有前半句时，表会单调增长成
 *   「什么都往里塞」的黑洞；只有后半句时，删了引用的条目会永远挂着假装还在豁免。
 * - **每条 `reason` 必须回答「它为什么不会建链」**，门槛是可机械判的（非空白长度下限）。
 *   「测试用」「不会真的连」这类废话一律不算理由。
 * - **形态按 `file` 聚合，比对按 `(file, host)` 集合**：理由常常是同一个事实（本仓的公网字面量
 *   高度聚集，`acl.test.ts` 里十几个 host 全是名单条目），逐条抄一遍理由只会抄到腐烂；
 *   但**集合比对**保证「在已豁免文件里新加一个 host」照样变红。
 * - **零公网字面量的文件不建条目**：建了会被判 stale。一个旧文件拆成多个新文件时**按新文件
 *   分组**，于是一条会裂成多条（也可能是零条）。
 * - **重复的 `(file, host)` 对也红**：表里同一对出现两次说明有人复制粘贴，放任会掩盖真实的
 *   第二个引用。
 *
 * ── 三档「扫描器必须自证看得见东西」（防假绿）────────────────────────
 * 本 helper 只负责**造出可量的素材**，具体数字与断言住在 `unit/meta/no-external-network.test.ts`
 * （本档自己是被扫描对象，数字写在断言档才不会被口径改动带着漂）。三档各自的素材出口是：
 * 1. **扫描范围** → `scannedFiles()`：断言侧拿它证明「范围非空、覆盖三个目录、**不含**
 *    `helpers/` 与 `manual/`」。路径写错会让整档永远为空断言，这条是它的下界。
 * 2. **拨号位下界** → `scanDialSites()` **返回每一个调用点**（不只是违规的那些），这样断言侧
 *    能报出「仓内建链点远多于 N 处 + 覆盖 ≥3 种原语」两个下界。A 层一旦扫不出东西就成空断言。
 * 3. **判别正确性** → `SELF_CHECK` + `LITERAL_PROBES`：前者逐条钉「必须判成公网 / 必须不判成
 *    公网」，后者钉 `publicHostsIn` 在**真实请求行**形态上的逐条结果。样本刻意住在这里（不被扫描），
 *    断言档自己一个公网 host 字面量都不许有——否则 B 面会把这档判成未申报。
 */
import fs from "node:fs";
import path from "node:path";
import { codeOnly, TESTS_DIR } from "./source-scan.js";
import { UNIT_ADMIN_HOST_REFS } from "./public-hosts/unit-admin.js";
import { UNIT_CONFIG_HOST_REFS } from "./public-hosts/unit-config.js";
import { UNIT_CORE_HOST_REFS } from "./public-hosts/unit-core.js";
import { UNIT_CORE_ACCESS_CONTROL_HOST_REFS } from "./public-hosts/unit-core-access-control.js";
import { UNIT_CORE_FORWARD_HOST_REFS } from "./public-hosts/unit-core-forward.js";
import { UNIT_CORE_HELPERS_HOST_REFS } from "./public-hosts/unit-core-helpers.js";
import { UNIT_CORE_IDENTITY_HOST_REFS } from "./public-hosts/unit-core-identity.js";
import { UNIT_DATASOURCE_ACL_HOST_REFS } from "./public-hosts/unit-datasource-acl.js";
import { UNIT_DATASOURCE_USERS_HOST_REFS } from "./public-hosts/unit-datasource-users.js";
import { UNIT_MANAGER_HOST_REFS } from "./public-hosts/unit-manager.js";
import { UNIT_META_HOST_REFS } from "./public-hosts/unit-meta.js";
import { UNIT_OPS_HOST_REFS } from "./public-hosts/unit-ops.js";
import { UNIT_PACKAGING_HOST_REFS } from "./public-hosts/unit-packaging.js";
import { UNIT_RUNTIME_HOST_REFS } from "./public-hosts/unit-runtime.js";
import { UNIT_UTILS_HOST_REFS } from "./public-hosts/unit-utils.js";
import { LIBRARY_HOST_REFS } from "./public-hosts/library.js";
import { INTEGRATION_ACL_HOST_REFS } from "./public-hosts/integration-acl.js";
import { INTEGRATION_FORWARD_CONTRACT_HOST_REFS } from "./public-hosts/integration-forward-contract.js";
import { INTEGRATION_FORWARD_FLAT_HOST_REFS } from "./public-hosts/integration-forward-flat.js";
import { INTEGRATION_FORWARD_OHR_HOST_REFS } from "./public-hosts/integration-forward-ohr.js";
import { INTEGRATION_UPSTREAM_HOST_REFS } from "./public-hosts/integration-upstream.js";

/** 被扫描的目录（相对 `tests/`）。`helpers/`、`manual/`、`perf/` **不在**范围内：前者是本工具自身，后者按设计就该打真网络。 */
export const SCAN_DIRS = ["unit", "integration", "library"] as const;

/** RFC 2606 / 6761 保留顶级域：永不可能解析到公网，故不算「公网 host」 */
const RESERVED_TLDS = new Set(["test", "example", "invalid", "localhost", "local", "onion"]);

/**
 * 精选公共 TLD 表
 *
 * @description
 * 用固定表而不是「任意 ≥2 位字母」：后者会把 `acl.json` / `events.push` / `user.id` 全判成 host。
 * 表不必全 —— 命中不到的新 TLD 只会让某个真实公网 host 逃过扫描（漏检），
 * 而过宽的表只会多出白名单条目（噪声），两者都该在补表时显式决定，不该由默认行为承担。
 */
const PUBLIC_TLDS = [
  "com", "net", "org", "edu", "gov", "mil", "int", "info", "biz", "name", "pro", "mobi", "asia", "tel",
  "io", "dev", "app", "ai", "sh", "gg", "to", "tv", "cc", "ws", "cloud", "online", "site", "tech", "store",
  "blog", "news", "live", "me", "co", "xyz", "top", "icu", "vip", "work", "link", "click",
  "us", "uk", "ca", "au", "nz", "de", "fr", "es", "it", "nl", "be", "ch", "at", "se", "no", "fi", "dk", "ie",
  "pl", "cz", "sk", "pt", "gr", "hu", "ro", "bg", "hr", "lt", "lv", "ee", "ru", "ua", "tr", "il", "cn", "jp",
  "kr", "tw", "hk", "sg", "in", "id", "th", "my", "ph", "vn", "br", "mx", "ar", "cl", "za",
] as const;

const HOST_PATTERN = new RegExp(
  String.raw`(?:\d{1,3}\.){3}\d{1,3}|[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.(?:${PUBLIC_TLDS.join("|")})\b`,
  "gi",
);

/** 判断一个 host 形态是否算「公网」（口径 3） */
export function isPublicHost(raw: string): boolean {
  const host = raw.toLowerCase().replace(/^\*\./, "").replace(/\.$/, "");
  if (host === "" || host === "localhost") return false;
  const tld = host.slice(host.lastIndexOf(".") + 1);
  if (RESERVED_TLDS.has(tld)) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    const octets = host.split(".").map(Number);
    if (!octets.every((n) => n >= 0 && n <= 255)) return true; // 越界 octet：不是有效 IP，按可疑形态处理
    const [a, b] = octets as [number, number, number, number];
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 192 && b === 168) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 169 && b === 254) return false;
    return true;
  }
  return true;
}

/** 切出代码里所有字符串字面量的内容（单趟，跳过转义） */
function literalSpans(code: string): string[] {
  const spans: string[] = [];
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const start = i + 1;
      i++;
      while (i < code.length && code[i] !== ch) i += code[i] === "\\" ? 2 : 1;
      spans.push(code.slice(start, i));
      i++;
      continue;
    }
    i++;
  }
  return spans;
}

/** 把字面量内容替换成等长空格（用于「在代码里找调用点，但不让字面量干扰」的场合） */
function maskLiterals(code: string): string {
  const out = code.split("");
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < code.length && code[j] !== ch) j += code[j] === "\\" ? 2 : 1;
      for (let k = i + 1; k < j; k++) if (out[k] !== "\n") out[k] = " ";
      i = j + 1;
      continue;
    }
    i++;
  }
  return out.join("");
}

/** 一段文本（字符串字面量内容）里出现的公网 host，去重后小写返回 */
export function publicHostsIn(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(HOST_PATTERN)) {
    if (isPublicHost(m[0])) found.add(m[0].toLowerCase());
  }
  return [...found].sort();
}

/** 建链原语：出现在这些调用的**实参**里的公网 host，就是「真的要出网」 */
const DIAL_PRIMITIVES = [
  "net.createConnection",
  "net.connect",
  "tls.connect",
  "tls.createSecureContext",
  "http.request",
  "https.request",
  "http.get",
  "https.get",
  "fetch",
  "dns.lookup",
  "dns.resolve",
  "dns.promises.lookup",
] as const;

export interface HostRef {
  /** 相对仓库根，如 `tests/unit/datasource/acl/validate.test.ts` */
  file: string;
  host: string;
}

export interface DialSite {
  file: string;
  /** 命中的建链原语，如 `net.connect` */
  primitive: string;
  /** 该调用实参里出现的公网 host（空数组 = 只打了本机/变量） */
  hosts: string[];
  /** 该调用的实参原文（截断后），用于失败时贴现场 */
  snippet: string;
}

/**
 * 取出一次建链调用里**真正会被拨号的**那个 host 字面量
 *
 * @description
 * 口径必须精确到「拨号位」，不能退化成「实参里出现的一切字面量」—— 那会立刻产生假阳性：
 * `http.request({ host: "127.0.0.1", port, headers: { Host: "example.com" } })` 里
 * `Host` 是 **HTTP 头**（线上文本），`host` 才是**连接目标**。用大小写敏感地只认
 * Node 选项键 `host` / `hostname`（小写）正好把两者分开。
 *
 * 两种调用形态分别处理：
 * - **选项对象**（`net.connect({...})` / `tls.connect({...})` / `http.request({...}, cb)`）：
 *   只取**顶层**的 `host` / `hostname` 键值字面量（顶层扫描，不下沉进嵌套对象）。
 * - **位置参数**（`net.connect(port, host, cb)`）：取全部位置参数字面量。这类形态里
 *   不存在 header 概念，「全取」是安全的；`port` 位置通常传变量，传字面量的就是 host。
 *
 * **刻意不纳入**：`servername`（SNI 是 TLS 名字，不产生外呼）、`headers.Host`（线上文本）。
 * 它们若真写了公网 host，由 B 层（全量普查 + 必须申报）兜住 —— 两层分工是刻意的。
 */
function dialHostLiterals(args: string): string[] {
  const trimmed = args.trim();
  if (!trimmed.startsWith("{")) {
    // 位置参数形态：取全部字面量
    const hosts: string[] = [];
    for (const literal of literalSpans(args)) hosts.push(...publicHostsIn(literal));
    return hosts;
  }
  // 选项对象形态：顶层扫描 host / hostname 键
  const masked = maskLiterals(args);
  const hosts: string[] = [];
  let depth = 0;
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i] as string;
    if (c === "{" || c === "[" || c === "(") {
      depth++;
      continue;
    }
    if (c === "}" || c === "]" || c === ")") {
      depth--;
      continue;
    }
    if (depth !== 1) continue;
    // 顶层标识符：只认小写 host / hostname（大小写敏感 = 天然排除 HTTP 头 `Host`）
    if (!/^[A-Za-z_$]/.test(c)) continue;
    let j = i;
    while (j < masked.length && /[A-Za-z0-9_$]/.test(masked[j] as string)) j++;
    const key = masked.slice(i, j);
    let k = j;
    while (k < masked.length && /\s/.test(masked[k] as string)) k++;
    if (masked[k] !== ":") {
      i = j - 1;
      continue;
    }
    if (key === "host" || key === "hostname") {
      let v = k + 1;
      while (v < masked.length && /\s/.test(masked[v] as string)) v++;
      const q = masked[v];
      if (q === '"' || q === "'" || q === "`") {
        // 从原文里切出这个字面量的内容（masked 里它已被空格替换）
        let e = v + 1;
        while (e < args.length && args[e] !== q) e += args[e] === "\\" ? 2 : 1;
        hosts.push(...publicHostsIn(args.slice(v + 1, e)));
      }
    }
    i = j - 1;
  }
  return [...new Set(hosts)].sort();
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** 被扫描的全部文件（相对仓库根，排序后返回） */
export function scannedFiles(): string[] {
  const files: string[] = [];
  for (const dir of SCAN_DIRS) {
    const full = path.join(TESTS_DIR, dir);
    if (!fs.existsSync(full)) continue;
    for (const f of walk(full)) files.push(path.relative(path.join(TESTS_DIR, ".."), f).split(path.sep).join("/"));
  }
  return files.sort();
}

/** B 层素材：每个文件里出现的公网 host 引用（已去注释、只在字面量内匹配） */
export function scanPublicHostRefs(): HostRef[] {
  const refs: HostRef[] = [];
  for (const file of scannedFiles()) {
    const code = codeOnly(fs.readFileSync(path.join(TESTS_DIR, "..", file), "utf8"));
    const hosts = new Set<string>();
    for (const literal of literalSpans(code)) {
      for (const host of publicHostsIn(literal)) hosts.add(host);
    }
    for (const host of [...hosts].sort()) refs.push({ file, host });
  }
  return refs;
}

/**
 * A 层素材：全部建链调用点及其实参里的公网 host
 *
 * @description
 * 返回**每一个**调用点（不只是违规的那些），这样断言侧能报出一个真实下界来证明
 * 「扫描器看得见东西」—— 否则 A 面就成了一条永远为空的空断言。
 */
export function scanDialSites(): DialSite[] {
  const sites: DialSite[] = [];
  for (const file of scannedFiles()) {
    const code = codeOnly(fs.readFileSync(path.join(TESTS_DIR, "..", file), "utf8"));
    const masked = maskLiterals(code);
    for (const primitive of DIAL_PRIMITIVES) {
      let from = 0;
      for (;;) {
        const at = masked.indexOf(primitive, from);
        if (at < 0) break;
        from = at + primitive.length;
        // 只认紧跟其后的调用括号（`net.connect(`），避免命中 `net.connect` 字样后跨表达式取窗
        let open = from;
        while (open < masked.length && /\s/.test(masked[open] as string)) open++;
        if (masked[open] !== "(") continue;
        // 圆括号配对取实参原文（在 masked 上配对 → 天然跳过嵌套字面量里的括号）
        let depth = 0;
        let i = open;
        for (; i < masked.length; i++) {
          const c = masked[i] as string;
          if (c === "(") depth++;
          else if (c === ")") {
            depth--;
            if (depth === 0) break;
          }
        }
        const args = code.slice(open + 1, i);
        const hosts = new Set(dialHostLiterals(args));
        sites.push({ file, primitive, hosts: [...hosts].sort(), snippet: args.trim().slice(0, 160) });
      }
    }
  }
  return sites;
}

/** A 层违规项：实参里带公网 host 的建链调用（**零白名单**） */
export function scanDialTargets(): DialSite[] {
  return scanDialSites().filter((s) => s.hosts.length > 0);
}

/**
 * 公网 host 白名单的一行：**按文件**申报，一行可以带多个 host
 *
 * @description
 * 形态刻意按**文件**聚合而不是按 (file, host) 逐条列：本仓的公网字面量高度聚集
 * （名单那几档里一份文件能带一整屏 host，全是名单条目），逐条写会把同一个理由抄一遍又一遍，
 * 而理由其实是同一个事实 —— 「这些 host 全都只是**被解析/被比较的字符串**」。
 * 断言仍按 (file, host) 集合比对，所以「在已豁免文件里新加一个 host」照样变红。
 */
export interface PublicHostEntry {
  /** 相对仓库根、`/` 分隔，如 `tests/unit/datasource/acl/validate.test.ts` */
  file: string;
  hosts: string[];
  /** 为什么这些字面量不会建链（断言侧只卡长度 ≥ 10，但那句话必须真的有信息） */
  reason: string;
}

/**
 * 公网 host 白名单：按**目标目录主题**分片，逐片住在 `public-hosts/` 下
 *
 * @description
 * 拼接顺序固定（unit → library → integration 的主题字母序），断言只按集合比对
 * （`no-external-network.test.ts` 的三对双向断言都过 `Set`），故顺序不影响判定；
 * 顺序写死只是为了让 diff 里「谁动了哪一片」一眼可见。
 * 纪律与「为什么按文件聚合」见 {@link PublicHostEntry}。
 */
export const PUBLIC_HOST_ALLOWLIST: readonly PublicHostEntry[] = [
  ...UNIT_ADMIN_HOST_REFS,
  ...UNIT_CONFIG_HOST_REFS,
  ...UNIT_CORE_HOST_REFS,
  ...UNIT_CORE_ACCESS_CONTROL_HOST_REFS,
  ...UNIT_CORE_FORWARD_HOST_REFS,
  ...UNIT_CORE_HELPERS_HOST_REFS,
  ...UNIT_CORE_IDENTITY_HOST_REFS,
  ...UNIT_DATASOURCE_ACL_HOST_REFS,
  ...UNIT_DATASOURCE_USERS_HOST_REFS,
  ...UNIT_MANAGER_HOST_REFS,
  ...UNIT_META_HOST_REFS,
  ...UNIT_OPS_HOST_REFS,
  ...UNIT_PACKAGING_HOST_REFS,
  ...UNIT_RUNTIME_HOST_REFS,
  ...UNIT_UTILS_HOST_REFS,
  ...LIBRARY_HOST_REFS,
  ...INTEGRATION_ACL_HOST_REFS,
  ...INTEGRATION_FORWARD_CONTRACT_HOST_REFS,
  ...INTEGRATION_FORWARD_FLAT_HOST_REFS,
  ...INTEGRATION_FORWARD_OHR_HOST_REFS,
  ...INTEGRATION_UPSTREAM_HOST_REFS,
];

/** 白名单摊平成 (file, host) 对，便于与扫描结果做集合比对 */
export function allowlistPairs(): HostRef[] {
  return PUBLIC_HOST_ALLOWLIST.flatMap(({ file, hosts }) =>
    hosts.map((host) => ({ file, host: host.toLowerCase() })),
  );
}

/**
 * 扫描器自检样本（防「扫描器坏了所以全绿」）
 *
 * @description
 * 样本刻意放在**本 helper**（不被扫描）而不是断言档里：断言档是被扫描对象，
 * 在里面写真公网 host 会把自己判成违规。
 */
export const SELF_CHECK = {
  /** 必须被判成公网 */
  mustFlag: [
    "example.com",
    "ws.postman-echo.com",
    "1.2.3.4",
    "8.8.8.8",
    "*.evil.com",
    "ads.io",
  ] as const,
  /** 必须**不**被判成公网（回环 / 私网 / RFC 保留 TLD / 成员访问形态） */
  mustNotFlag: [
    "127.0.0.1",
    "localhost",
    "0.0.0.0",
    "10.1.2.3",
    "192.168.1.1",
    "172.16.0.1",
    "169.254.1.1",
    "in.test",
    "blocked.test",
    "client-host.example",
  ] as const,
} as const;

/**
 * 「整段文本」级探针：验证 `publicHostsIn` 在**真实请求行**形态上的行为
 *
 * @description
 * 同样刻意搬进 helper：`no-external-network.test.ts` 本身是被扫描对象，
 * 它若自带 `GET http://example.com/…` 这样的字面量，B 面会把它判成「未申报的公网 host」。
 * 这不是巧合而是**设计**：断言档必须与被断言的仓一样干净。
 */
export const LITERAL_PROBES: ReadonlyArray<{ text: string; expect: string[] }> = [
  { text: "GET http://example.com/abs HTTP/1.1", expect: ["example.com"] },
  { text: "CONNECT ws.postman-echo.com:443 HTTP/1.1", expect: ["ws.postman-echo.com"] },
  { text: "CONNECT 127.0.0.1:8080 HTTP/1.1", expect: [] },
  { text: "Host: client-host.example\r\n", expect: [] },
  { text: "SOCKS5 ATYP=0x01 dst=203.0.113.9:443", expect: ["203.0.113.9"] },
];
