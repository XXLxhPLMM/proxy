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
 *    这不是理论风险：本仓真实踩过 —— 一条 `// …外网 ws.postman-echo.com:443…` 的处置记录里
 *    带了反引号，朴素引号扫描会把注释内容吞成「字符串字面量」，凭空造出一条违规命中。
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
 *   B 层抓的是 A 层看不见的形态：**host 作为本地 helper 的实参**（本仓真实踩过的那档 wss
 *   就是 `wssViaConnect(port, "ws.postman-echo.com", 443)` —— 文本上与名单条目无法区分，
 *   只能靠「必须申报」这道人工闸门）。
 */
import fs from "node:fs";
import path from "node:path";
import { codeOnly } from "./source-scan.js";

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
  /** 相对仓库根，如 `tests/unit/acl.test.ts` */
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

const TESTS_DIR = path.join(__dirname, "..");

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
 * 公网 host 白名单：**逐文件**申报，每条必须写清「为什么它不会出网」
 *
 * @description
 * 形态刻意按**文件**聚合而不是按 (file, host) 逐条列：本仓的公网字面量高度聚集
 * （`acl.test.ts` 里 11 个 host 全是名单条目），逐条写会把理由抄 11 遍，
 * 而理由其实是同一个事实 —— 「这些 host 全都只是**被解析/被比较的字符串**」。
 * 断言仍按 (file, host) 集合比对，所以「在已豁免文件里新加一个 host」照样变红。
 */
export const PUBLIC_HOST_ALLOWLIST: ReadonlyArray<{ file: string; hosts: string[]; reason: string }> = [
  {
    file: "tests/unit/acl-rule-host.test.ts",
    hosts: ["1.2.3.4", "11.0.0.1", "a.b.a.com", "a.com", "example.com", "nota.com", "other.com", "www.example.com", "x.a.com"],
    reason: "名单条目**语法**层：裸域 vs `*.` 后缀、尾点、IDN/下划线、CIDR 条目全是待解析的字符串字面量；parseHostRule/hostMatches 只做归一与比较，不建立任何连接。",
  },
  {
    file: "tests/unit/acl-rule-ip.test.ts",
    hosts: ["1.2.3.4", "1.2.3.5", "11.0.0.0", "11.0.0.1", "300.1.1.1"],
    reason: "同上（IP 侧）：CIDR / v4-mapped / 越界 octet（300.1.1.1）都是待解析的条目字面量，判定是纯字符串与位运算。",
  },
  {
    file: "tests/unit/acl.test.ts",
    hosts: ["1.2.3.4", "8.8.8.8", "9.9.9.9", "a.com", "ads.example.net", "b.com", "c.com", "evil.com", "example.com", "good.com", "other.com", "secret.a.com", "sub.a.com", "x.evil.com"],
    reason: "全局名单条目 + checkClientIp/checkTargetHost 的**纯函数入参**（8.8.8.8 只是喂给名单判定的字符串）；判定是字符串比较，不拨号。",
  },
  {
    file: "tests/unit/auth-users.test.ts",
    hosts: ["1.2.3.4", "a.com", "ads.io", "b.com", "corp.com", "evil.com", "example.com", "mple.com"],
    reason: "users.json 里账号的 acl 名单条目（ads.io / corp.com / a.com…）与 CIDR 条目：校验器只读文件做形状校验，不建链。`mple.com` 是**畸形 host 负向输入**的尾巴 —— 原文是含 IDN 字符的 exämple.com（必须被判非法），扫描器的 label 字符集不含非 ASCII，故只匹到 mple.com 这一段。",
  },
  {
    file: "tests/unit/auth.test.ts",
    hosts: ["example.com"],
    reason: "鉴权失败日志与事件载荷里的目标 host 占位符，纯字符串。",
  },
  {
    file: "tests/unit/config-access.test.ts",
    hosts: ["example.com"],
    reason: "configAccessorFromStore 的配置读取用例：目标 host 是 store 里的配置值，不触发任何连接。",
  },
  {
    file: "tests/unit/config-loader.test.ts",
    hosts: ["proxy.example.com"],
    reason: "UPSTREAM_URL 的校验/拆项用例：只消费显式 env/argv 做字符串拆解，从不拨号。",
  },
  {
    file: "tests/unit/connector-open.test.ts",
    hosts: ["c.name"],
    reason: "**非 host 文本**：字符串内容是形如 `c.name` 的方法名，出现在源码级断言的被查文本里。因 TLD 表收录 `name` 而被命中 —— 这是口径的已知误报类，显式豁免而不是把 `name` 从 TLD 表删掉（那会给真实公网 TLD 开后门）。",
  },
  {
    file: "tests/unit/core-event-bridge.test.ts",
    hosts: ["1.2.3.4", "203.0.113.7", "example.com"],
    reason: "事件载荷的 client/target host 占位符（203.0.113.7 是 RFC 5737 文档用 IP）；只断言载荷字段值。",
  },
  {
    file: "tests/unit/dialer-protocol-boundary.test.ts",
    hosts: ["sub.name"],
    reason: "**非 host 文本**：与 connector-open 同因 —— 字符串内容是待断言的源码文本（`sub.name`），因 TLD 表收录 `name` 被命中。",
  },
  {
    file: "tests/unit/error-boundary.test.ts",
    hosts: ["example.com"],
    reason: "错误路径用例构造的 host 占位符。",
  },
  {
    file: "tests/unit/event-hub.test.ts",
    hosts: ["example.com"],
    reason: "事件 context 的 target host 占位符。",
  },
  {
    file: "tests/unit/ip.test.ts",
    hosts: ["1.1.1.1", "192.0.2.43", "2.2.2.2", "3.3.3.3", "4.4.4.4", "5.5.5.5", "9.9.9.9", "example.com"],
    reason: "地址提取/归一函数的**入参**（x-forwarded-for 头、authority、括号 IPv6 形态）；192.0.2.43 是 RFC 5737 文档 IP。全是字符串处理。",
  },
  {
    file: "tests/unit/log-events.test.ts",
    hosts: ["1.2.3.4", "evil.com", "example.com"],
    reason: "结构化日志行的 host/IP 占位符（[ip-denied] / [target-denied] 等文本断言）。",
  },
  {
    file: "tests/unit/logger.test.ts",
    hosts: ["1.2.3.4"],
    reason: "日志记录里的 client host 占位符。",
  },
  {
    file: "tests/unit/pipe-event.test.ts",
    hosts: ["example.com"],
    reason: "PipeEvent 类型级契约用例里的 target host 占位符。",
  },
  {
    file: "tests/unit/proxy-helpers.test.ts",
    hosts: ["a.com", "a.example.com", "evil.com", "example.com", "mple.com"],
    reason: "转发辅助函数（目标解析 / 自环判定 / peerTarget / 桥接）的**入参字符串**；真连接一律打 127.0.0.1 的空闲端口。`mple.com` 同上，是**含空格的畸形 host 负向输入**（exa mple.com，必须被判非法）的尾巴。",
  },
  {
    file: "tests/unit/proxy-runtime.test.ts",
    hosts: ["context.store"],
    reason: "**非 host 文本**：字符串内容是断言用的属性路径文本 `context.store`，因 TLD 表收录 `store` 被命中。",
  },
  {
    file: "tests/unit/self-loop.test.ts",
    hosts: ["example.com"],
    reason: "自环判定（通配监听 / localhost 等价 / v4-mapped）的 host 入参，纯字符串比较。",
  },
  {
    file: "tests/unit/user-acl-merge.test.ts",
    hosts: ["198.51.100.5", "203.0.113.9", "ads.io"],
    reason: "users.json 个人名单条目（ads.io）与 IP 条目（198.51.100.5 / 203.0.113.9 是 RFC 5737 文档 IP）；合流判定是纯函数。",
  },
  {
    file: "tests/unit/user-quota.test.ts",
    hosts: ["a.com", "ads.io", "corp.com"],
    reason: "账号表里的 acl 名单条目（ads.io / corp.com / a.com）；校验与配额判定都是纯函数。",
  },
  {
    file: "tests/integration/forward-tunnel-guard.test.ts",
    hosts: ["example.com"],
    reason: "裸 net.Server 转发器入口手搓的**伪 req**：`url` / `headers.host` / `rawHeaders` 是喂给被测代码的入参文本，真实连接打的是本机空闲端口。",
  },
  {
    file: "tests/integration/http-forward-contract.test.ts",
    hosts: ["example.com"],
    reason: "手写请求行里的 absolute-form URL 与 Host 头 —— 本档锁的是**出站字节**（absolute-form 保留、Host 按 §5.4 回写），桩在 127.0.0.1 上，example.com 只是线上文本，从不解析。",
  },
  {
    file: "tests/integration/http-proxy-forward-socks.test.ts",
    hosts: ["example.com"],
    reason: "伪 req 的 Host 头 / url 字段（同上：入参文本，真实目标是本机桩端口）。",
  },
  {
    file: "tests/integration/http-proxy-upstream-protocol.test.ts",
    hosts: ["example.com"],
    reason: "请求行 URL 与 `upstream-ok:<url>` 回显断言；明文 SOCKS5 上游桩在**本机** serve 这个 target，example.com 不被解析。",
  },
  {
    file: "tests/integration/upstream-matrix.test.ts",
    hosts: ["example.com"],
    reason: "只出现在 **absolute-form（http 请求）** 档：上游是本机 http/https 服务器，只回 `upstream-ok:`，不解析该 host；「→502」档在自签 TLS 握手失败处就短路。**所有 CONNECT 档的目标都是 `127.0.0.1:<空闲端口>`**（已逐条核对），故无一条会真出网。",
  },
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
