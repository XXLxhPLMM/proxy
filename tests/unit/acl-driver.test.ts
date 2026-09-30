/**
 * `ACL_DRIVER` 接线的**牙齿**：注册一个自定义名单驱动 → `ACL_DRIVER=<自定义名>` 真的被装配使用。
 *
 * @description
 * **它为什么必须有牙齿**：驱动名是**开放集合**（`@/datasource/driver.ts`），所以「配了
 * `ACL_DRIVER=mysql` 到底读的是不是 mysql」这件事**没有类型系统兜底**，只有一条运行期判据：
 * 配置里那个字符串真的被拿去查了注册表。一个没有牙齿的接线（字段存在、装配点写死 `json`）
 * 与「完全没接线」在**所有其它测试下表现完全一致**——测试全绿，而 `ACL_DRIVER=whatever`
 * 静默按 json 跑。那是「配置说了一套、系统做了另一套」且零信号。
 *
 * ## 判据形状：让「用错了驱动」在行为面上可见
 *
 * 判定类用例都给出**同一个目标主机在两种驱动下的相反结果**（自定义档拒、json 档放行），
 * 于是「装配点忽略了 `aclDriver`」立刻表现为断言失败，而不是「读起来一样」。
 *
 * ### 变异测试实测（判据有牙齿的证据）
 *
 * 两个装配点**各自**独立成钉，故做了三次变异：
 *
 * | 变异 | 变红 |
 * | --- | --- |
 * | `aclSourceFor` 忽略 `locator.driver()`、恒取 `"json"` | 7 档（判定期 + 经同一条解析的启动期） |
 * | `loadConfig` 里的 `aclDriver` 恒取 `"json"` | 启动期 3 档 |
 * | 拆掉 `createFileAccessControl` 里的 `aclSourceFor(aclLocator)` | 1 档（「未注册驱动装配即抛错」） |
 *
 * 第 1 行的红法是**行为面**的：目标主机拿到 `{allowed:true}` 而不是 `source:"global"` 的拒绝，
 * 且「未注册驱动装配即抛错」不抛（`expect(...).toThrow()` 失败）。
 * 第 1 行与第 2 行的红集**不等**：判定期那条路径不经过 `loadConfig`，反之亦然——所以两行判据
 * 缺一不可，合并会漏掉「两个装配点各读各的」这种分裂（第 1 行杀不掉的正是第 2 行独有的
 * 「`ACL_DRIVER` 经 env 生效」与「启动期错误文案点名驱动」那几档）。
 * 若哪天它们不再随接线断裂而红，说明判据锚到了恒真的形状（例如只断言「注册成功」而不断言
 * 「装配真的用了它」），必须把锚改回行为面。
 *
 * ## 两层形状，别在测试里混用
 *
 * - **数据源层**（`aclSourceFor` / `readAcl` / `loadAcl` / `hasConfiguredAcl`）吃 `AclLocator`：
 *   两个闭包，**不含配置键名**。本档直接手搓闭包，**不经 `aclLocatorFor`** —— 那样会顺带把
 *   「装配层翻译配置」这件事也测了，而那不是本档要证明的（`ConfigAccessor` 的接线由
 *   `src/config/acl-locator.ts` 自己负责）。
 * - **判定装配层**（`createFileAccessControl`）吃 `ConfigAccessor`：它同时要账号表接线，
 *   而那份也是从 accessor 翻出来的。
 *
 * 每例一份**独立**接线：`aclSourceFor` 按 `(接线, 驱动名)` 记忆实现器，共用一条会让**上一例的
 * 实现器泄漏进下一例**——那会让断言测到的是「上一例留下的缓存」而不是「本例的接线」。
 *
 * ## 装配点有**两个**
 *
 * `core/access-control.ts:createFileAccessControl`（判定期）与 `config/load.ts`（启动期强校验）。
 * 只钉前者的话，「启动期校验走了 json 档而运行期走了自定义档」这种分裂不会被发现。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  aclSourceFor,
  EMPTY_ACL,
  hasAclSourceDriver,
  listAclSourceDrivers,
  registerAclSource,
  resolveAclSource,
  validateAcl,
  type AclConfig,
  type AclLocator,
  type AclReadOptions,
  type AclSource,
} from "@/datasource/acl/index.js";
import type { JsonFileRead } from "@/utils/json-file/index.js";
import { createFileAccessControl } from "@/core/access-control.js";
import { ConfigStore, configAccessorFromStore, loadConfig, type ConfigAccessor } from "@/config/index.js";
import { blockAfter, codeOnly, codeOf, sourceOf } from "../helpers/source-scan.js";

/** 自定义驱动名。刻意不像任何内置档，防止「恰好命中内置分支」的假绿。 */
const CUSTOM = "unit-test-custom";

/** 两条驱动对同一主机的相反判定：判定类用例都拿它做对照。 */
const DENIED_HOST = "banned-by-custom.example.com";

const CUSTOM_ACL: AclConfig = {
  clientIp: { whitelist: [], blacklist: [] },
  target: { whitelist: [], blacklist: [DENIED_HOST] },
  upstream: { whitelist: [], blacklist: [] },
};

/** 实现器工厂的记账：证明「装配点真的问过注册表」，而不是只断言最终判定值。 */
interface Probe {
  factoryCalls: number;
  readCalls: number;
  startupCalls: number;
}

function newProbe(): Probe {
  return { factoryCalls: 0, readCalls: 0, startupCalls: 0 };
}

/**
 * 假实现器：一份写死的名单 + 一次调用计数
 * @description 每次 `read` 返回**同一个** `AclConfig` 对象（与真实实现器「内容未变即同一份
 * 快照」的语义一致），否则判定层的编译缓存因每次新对象而永不命中，用例就变成在测缓存。
 */
function fakeSource(probe: Probe, startupError?: string): AclSource {
  const locator = (): string => "unit-test://acl";
  return {
    driver: CUSTOM,
    locator,
    read(options?: AclReadOptions): JsonFileRead<AclConfig> {
      probe.readCalls += 1;
      options?.onEvent?.({ type: "reloaded", label: "unit-test", path: locator() });
      return { value: CUSTOM_ACL, path: locator(), exists: true };
    },
    async readStartup(): Promise<JsonFileRead<AclConfig>> {
      probe.startupCalls += 1;
      return {
        value: startupError ? EMPTY_ACL : CUSTOM_ACL,
        path: locator(),
        exists: startupError === undefined,
        error: startupError,
      };
    },
  };
}

/** 注册自定义驱动并返回退订闭包（退订后注册表回到出厂状态） */
function register(probe: Probe, startupError?: string): () => void {
  return registerAclSource(CUSTOM, () => {
    probe.factoryCalls += 1;
    return fakeSource(probe, startupError);
  });
}

let dir = "";

/** 一份**独立**的配置 store（记忆表按接线分槽，故每例的装配互不影响） */
function storeWith(patch: { aclDriver?: string; aclFile?: string }): ConfigStore {
  return new ConfigStore(patch);
}

/** 配置 store 侧的 accessor（判定装配层吃它） */
function accessorOf(store: ConfigStore): ConfigAccessor {
  return configAccessorFromStore(store);
}

/** 由同一份 store 手搓一条接线（数据源层吃它；**不经 `aclLocatorFor`**，理由见文件头） */
function locatorOf(store: ConfigStore): AclLocator {
  return Object.freeze({
    driver: () => store.get("aclDriver"),
    path: () => store.get("aclFile"),
  });
}

/** 写一份**除 `other.example.com` 外全放行**的名单文件：json 档读它必然放行 `DENIED_HOST` */
function writePermissiveJson(name: string): string {
  const p = path.join(dir, `${name}.json`);
  fs.writeFileSync(p, JSON.stringify({ target: { blacklist: ["other.example.com"] } }));
  return p;
}

/** 独立的 configDir（`loadConfig` 在这个 cwd 下解析 FIELDS 的路径缺省，不落在仓库里） */
function tempCwd(tag: string): string {
  return fs.mkdtempSync(path.join(dir, `${tag}-cwd-`));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "acl-driver-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// ① 判定期装配：`ACL_DRIVER=<自定义名>` 真的换了实现器
// ---------------------------------------------------------------------------

describe("createFileAccessControl：`ACL_DRIVER` 真的决定用哪个实现器", () => {
  it("自定义驱动拒的 host 被拒；同一份名单文件在 json 档下同一个 host 放行", () => {
    const probe = newProbe();
    const off = register(probe);
    try {
      const file = writePermissiveJson("permissive");

      // 对照组：json 档读同一份文件 → 放行（黑名单里没有它）
      const jsonAccess = createFileAccessControl(
        accessorOf(storeWith({ aclDriver: "json", aclFile: file })),
      );
      expect(jsonAccess.checkTarget({ host: DENIED_HOST })).toEqual({ allowed: true });

      // 实验组：自定义驱动 → 拒绝，且 `source:"global"` 说明走的是全局名单那一层
      const customAccess = createFileAccessControl(
        accessorOf(storeWith({ aclDriver: CUSTOM, aclFile: file })),
      );
      expect(customAccess.checkTarget({ host: DENIED_HOST })).toEqual({
        allowed: false,
        reason: "blacklist",
        source: "global",
      });
      expect(probe.factoryCalls).toBeGreaterThanOrEqual(1);
      expect(probe.readCalls).toBeGreaterThanOrEqual(1);
    } finally {
      off();
    }
  });

  it("三个判定方法共用同一个驱动（换驱动同时换掉 clientIp / target / upstream 三组）", () => {
    const off = registerAclSource(
      CUSTOM,
      () => ({
        driver: CUSTOM,
        locator: () => "unit-test://acl",
        read: () => ({
          value: {
            clientIp: { whitelist: [], blacklist: ["198.51.100.7"] },
            target: { whitelist: [], blacklist: [DENIED_HOST] },
            upstream: { whitelist: [], blacklist: ["direct.example.com"] },
          },
          path: "unit-test://acl",
          exists: true,
        }),
        readStartup: async () => ({
          value: EMPTY_ACL,
          path: "unit-test://acl",
          exists: false,
        }),
      }),
    );
    try {
      const access = createFileAccessControl(accessorOf(storeWith({ aclDriver: CUSTOM })));
      expect(access.checkClient({ client: "198.51.100.7" })).toEqual({
        allowed: false,
        reason: "blacklist",
      });
      expect(access.checkTarget({ host: DENIED_HOST })).toEqual({
        allowed: false,
        reason: "blacklist",
        source: "global",
      });
      expect(access.checkRoute({ host: "direct.example.com" })).toEqual({
        direct: true,
        reason: "blacklist",
      });
    } finally {
      off();
    }
  });

  it("未注册的驱动名在**装配时**抛错并列出全部已注册项（绝不静默回落到 json 档）", () => {
    const config = accessorOf(storeWith({ aclDriver: "no-such-acl-driver" }));
    expect(() => createFileAccessControl(config)).toThrow(/no-such-acl-driver/);
    expect(() => createFileAccessControl(config)).toThrow(/json/);
  });
});

// ---------------------------------------------------------------------------
// ② 启动期装配：`config/load.ts` 的强校验也走同一个驱动
// ---------------------------------------------------------------------------

describe("loadConfig：启动期强校验走 `ACL_DRIVER` 指定的实现器", () => {
  it("自定义驱动的启动期读取被真正调用（`ACL_DRIVER` 经 env 生效）", async () => {
    const probe = newProbe();
    const off = register(probe);
    try {
      const context = await loadConfig({
        env: { ACL_DRIVER: CUSTOM },
        envFiles: [],
        argv: [],
        cwd: tempCwd("ok"),
      });
      expect(context.config.aclDriver).toBe(CUSTOM);
      expect(probe.startupCalls).toBe(1);
    } finally {
      off();
    }
  });

  it("自定义驱动的启动期错误让启动失败，且报错文案点名驱动而不是 ACL_FILE", async () => {
    const probe = newProbe();
    const off = register(probe, "自定义档的启动期错误");
    try {
      await expect(
        loadConfig({ env: { ACL_DRIVER: CUSTOM }, envFiles: [], argv: [], cwd: tempCwd("bad") }),
      ).rejects.toThrow(/ACL_DRIVER=unit-test-custom.*自定义档的启动期错误/);
      expect(probe.startupCalls).toBe(1);
    } finally {
      off();
    }
  });

  it("未注册的驱动名让 `loadConfig` 直接失败（不会退化成「名单缺失 = 空名单 = 全放行」）", async () => {
    await expect(
      loadConfig({
        env: { ACL_DRIVER: "no-such-acl-driver" },
        envFiles: [],
        argv: [],
        cwd: tempCwd("unknown"),
      }),
    ).rejects.toThrow(/no-such-acl-driver/);
  });

  it("内置 `json` 档的启动期坏内容仍中止启动（fail-closed 未因接线而松掉）", async () => {
    const cwd = tempCwd("json-bad");
    const file = path.join(cwd, "bad-acl.json");
    // 条目带端口 = 非法（名单条目不支持端口）
    fs.writeFileSync(file, JSON.stringify({ target: { blacklist: ["example.com:8080"] } }));
    await expect(
      loadConfig({ env: { ACL_FILE: file }, envFiles: [], argv: [], cwd }),
    ).rejects.toThrow(/ACL_FILE=.*格式非法/);
  });
});

// ---------------------------------------------------------------------------
// ③ 注册表原语：开放集合的判据是「有没有注册」，不是「名字在不在枚举里」
// ---------------------------------------------------------------------------

describe("名单驱动注册表", () => {
  it("内置 `json` 恒在已注册列表里（构造时写入，不靠谁被 import 到）", () => {
    expect(listAclSourceDrivers()).toContain("json");
    expect(hasAclSourceDriver("json")).toBe(true);
  });

  it("注册后可列出、退订后消失；退订幂等", () => {
    const off = register(newProbe());
    expect(listAclSourceDrivers()).toContain(CUSTOM);
    expect(hasAclSourceDriver(CUSTOM)).toBe(true);
    off();
    off();
    expect(hasAclSourceDriver(CUSTOM)).toBe(false);
  });

  it("重名且未给 override 抛错（不静默替换）", () => {
    const probe = newProbe();
    const off = register(probe);
    try {
      expect(() => registerAclSource(CUSTOM, () => fakeSource(probe))).toThrow(/已注册/);
    } finally {
      off();
    }
  });

  it("覆盖之后，先前那个注册方的退订不删当前值（退订只删自己写的那一项）", () => {
    const probe = newProbe();
    const offFirst = register(probe);
    const offSecond = registerAclSource(CUSTOM, () => fakeSource(probe), { override: true });
    offFirst();
    expect(hasAclSourceDriver(CUSTOM)).toBe(true);
    offSecond();
    expect(hasAclSourceDriver(CUSTOM)).toBe(false);
  });

  it("未注册驱动 resolve 抛错并列出全部已注册项", () => {
    expect(() => resolveAclSource("nope")).toThrow(/json/);
  });
});

// ---------------------------------------------------------------------------
// ④ 记忆表：只记「哪个驱动」，绝不记「哪份数据」
// ---------------------------------------------------------------------------

describe("aclSourceFor 的记忆边界", () => {
  it("同一条接线恒返回同一个实现器（下游的节流缓存与编译缓存才命中）", () => {
    const locator = locatorOf(storeWith({ aclDriver: "json" }));
    expect(aclSourceFor(locator)).toBe(aclSourceFor(locator));
  });

  it("换驱动拿到另一个实现器（记忆按 `(接线, 驱动名)` 分槽）", () => {
    const probe = newProbe();
    const off = register(probe);
    try {
      const store = storeWith({ aclDriver: "json" });
      const locator = locatorOf(store);
      const json = aclSourceFor(locator);
      store.set("aclDriver", CUSTOM);
      expect(aclSourceFor(locator)).not.toBe(json);
      expect(probe.factoryCalls).toBe(1);
    } finally {
      off();
    }
  });

  it("实现器每次现取位置，故热改名单路径在下一次读即生效（位置不记忆）", () => {
    const first = path.join(dir, "one.json");
    const second = path.join(dir, "two.json");
    fs.writeFileSync(first, "{}");
    fs.writeFileSync(second, "{}");
    const store = storeWith({ aclDriver: "json", aclFile: first });
    const locator = locatorOf(store);
    const source = aclSourceFor(locator);
    expect(source.locator()).toBe(first);
    store.set("aclFile", second);
    // 同一个实例、位置变了：记忆里只有「哪个驱动」，路径永远是现取的
    expect(aclSourceFor(locator)).toBe(source);
    expect(source.locator()).toBe(second);
  });
});

// ---------------------------------------------------------------------------
// ⑤ 形状校验与端口无关：换驱动换不掉「什么算合法名单」
// ---------------------------------------------------------------------------

describe("形状校验只有一份，与驱动无关", () => {
  it("实现器**只调用**那一个 validateAcl，从不自己实现一份", () => {
    // 判据是「实现器里**没有第二份实现**」，而不是「只有一处调用」——读路径
    // （`readJsonCached(…, validateAcl, …)`）与写路径（`write()` 落盘前那次）**各调一次**同一个
    // 函数，而那正是「一份判据」的正确形态：写之前不校验才是真正的漏洞（形状错的内容会落盘，
    // 要等到下一个请求周期才发现）。把计数判据改成「不许有本地定义」，才是这条不变量的形状。
    const code = codeOf("datasource", "acl", "json-source.ts");
    expect(code, "实现器里不许另定义一份校验").not.toMatch(
      /(function|const|let|var)\s+validateAcl\b/,
    );
    // 反向：它必须**从那一个模块**取判据（不是自己写、也不是从别处再引一份）
    expect(code).toMatch(/import\s*\{[^}]*\bvalidateAcl\b[^}]*\}\s*from\s*"\.\/validate\.js"/);
    // 反向：校验模块零 IO（不许自己读文件 —— 那会让「一份判据」变两份）
    expect(codeOnly(codeOf("datasource", "acl", "validate.ts"))).not.toContain("node:fs");
    expect(validateAcl({ target: { blacklist: ["192.168.*.*"] } })).toBeUndefined();
  });

  it("读路径恰好一处：形状校验挂在 readJsonCached 的校验位上", () => {
    // 判据形状是「校验必须是**交给 readJsonCached 的那个函数引用**」，不是计数。
    // ⚠️ 这里刻意**不**去 `blockAfter(source, "public read(")` 切函数体再数出现次数：
    // 那个锚点后面第一个 `{` 是形参默认值 `options: AclReadOptions = {}` 的花括号，
    // 于是切出来的是空对象的 `{}`，计数恒为 0 —— 一条恒为 0 的断言比没有断言更坏。
    // 同理**不**对全文数出现次数：本文件有三个使用点（读侧传引用、启动期调用、写前调用），
    // 数错一个就变成「为了对上而改数」，而那条断言的牙齿本来就不在计数上（真牙齿是上面那条
    // 「不许有本地定义」）。逐个点名，三个使用点各自的形状都被钉住。
    const source = sourceOf(path.join("datasource", "acl", "json-source.ts"));
    // ① 读侧：**传引用**给节流读取层的校验位
    expect(source).toContain("readJsonCached(options.path ?? this.resolveLocator(), validateAcl");
    // ② 启动期：直接调用（不进热加载缓存，故自己判一次）
    expect(source).toContain("const value = validateAcl(JSON.parse(content) as unknown);");
    // ③ 写前：先判再落盘（见下一条断言的次序）
    expect(source).toContain("const validated = validateAcl(next);");
  });

  it("写路径也经同一个 validateAcl：非法内容抛错、绝不落盘", () => {
    // 这是「一份判据」的**另一半**：读侧判一次不够，写侧也得判一次。判据形状是「write() 体内
    // 出现 validateAcl(」——若哪天改成「信任调用方已校验」，本条立刻红，而那正是「写进去了、
    // 下一个请求周期才发现读不出来」的来源。
    const source = codeOf("datasource", "acl", "json-source.ts");
    const writeBody = blockAfter(source, "public write(next: AclConfig)");
    expect(writeBody).toContain("validateAcl(");
    expect(writeBody).toMatch(/throw new Error/);
    // 校验必须在写盘之前（顺序反了就等于没校验）
    expect(writeBody.indexOf("validateAcl(")).toBeLessThan(writeBody.indexOf("writeJsonAtomic("));
  });

  it("数据源层不认识 `ConfigAccessor`（接线只有两个闭包，故可脱离代理单独使用）", () => {
    for (const rel of [
      ["datasource", "acl", "types.ts"],
      ["datasource", "acl", "registry.ts"],
      ["datasource", "acl", "json-source.ts"],
    ]) {
      const code = codeOf(...rel);
      expect(code, `${rel.join("/")} 不得认识 ConfigAccessor`).not.toContain("ConfigAccessor");
      expect(code, `${rel.join("/")} 不得 import @/config/index.js`).not.toContain(
        "@/config/index.js",
      );
    }
    // 唯一允许的 `@/config/...` 是条目规则那个第二出口
    expect(codeOf("datasource", "acl", "validate.ts")).toContain("@/config/files/rules/index.js");
  });
});