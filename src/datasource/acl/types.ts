/**
 * @fileoverview 访问控制名单的数据源**端口**：名单形状 + 「整份名单怎么读」的契约
 * @module datasource/acl/types
 * @description
 * 三组名单语义：clientIp 只收 IP/CIDR，按 TCP 对端地址判定；target 收 IP/CIDR/域名/`*.域名`，
 * 按客户端请求的 host 字符串匹配、不做 DNS；upstream 条目语法同 target，但动作相反
 * （命中 = 直连，不交上游）。
 *
 * ## 端口只承诺「读整份名单」这一件事
 *
 * 名单是**一份文档、一次判定**的量：不按条目查、不增量读、不写回。故端口上**没有**单条查询、
 * 没有写方法、没有事务——加上去就是给「一份文档」发明数据库语义。
 *
 * 两条读路径的分工是硬约定，**不得合并**：
 * - `read()` 是判定期热路径（mtime 节流 + 内容快照身份复用 + 四态事件）；
 * - `readStartup()` 是启动期强校验（**直接读一次**：不进热加载缓存、不发观察事件），
 *   因为启动那一刻「上一份有效值」根本不存在，坏内容必须让启动失败而不是回退成空名单。
 * 把它们合成一条会让启动期校验要么污染热加载缓存、要么失去 fail-closed 语义。
 *
 * ## 端口不认识配置
 *
 * 实现器由工厂 `(locator) => source` 造，**吃的是「定位串闭包」这个平值**，不是 `ConfigAccessor`。
 * 装配层（`@/config/acl-locator.ts`）把配置翻译成 `AclLocator` 两个闭包再传进来，于是本层可以脱离
 * 「起一个代理」被单独使用（读一份名单做别的用途），而数据从哪来由装配层注入。
 * @see ./registry.ts 注册表与装配读面
 */

import type { DataSourceDriver } from "@/datasource/driver.js";
import type { JsonFileEvent, JsonFileRead } from "@/utils/json-file/index.js";

export interface AclList {
  whitelist: string[];
  blacklist: string[];
}

export interface AclConfig {
  clientIp: AclList;
  target: AclList;
  /** client 模式路由名单（命中动作 = 直连，不交上游） */
  upstream: AclList;
}

/** 空名单（只读哨兵，位置缺失或该组缺省时使用） */
const EMPTY_LIST: AclList = { whitelist: [], blacklist: [] };

/** 空 ACL（只读哨兵，数据缺失或非法时回退） */
export const EMPTY_ACL: AclConfig = {
  clientIp: EMPTY_LIST,
  target: EMPTY_LIST,
  upstream: EMPTY_LIST,
};

/**
 * 名单读取的选项
 * @param force - 跳过节流强制重读（诊断用）
 * @param path - **本次读的位置**，覆盖实现器 locator 现取的值。
 *   ⚠️ 它是「读这个位置」而不是「换个后端」，故自定义驱动可以按自己的定位语义解释它
 *   （对 json 档就是文件路径）；传了它本实现器**不进**任何记忆表。
 * @param onEvent - 状态迁移观察面（`error` / `missing` / `recovered` / `reloaded`）；缺省零副作用
 */
export interface AclReadOptions {
  readonly force?: boolean;
  readonly path?: string;
  readonly onEvent?: (event: JsonFileEvent) => void;
}

/**
 * 访问控制名单的**数据源端口**
 * @description 判定层（`core/access-control.ts`）只经这一个形状拿名单，故「名单从哪来」
 * 在判定层**不可见**——换驱动不影响任何判定语义。
 */
export interface AclSource {
  /** 本实现器对应的驱动名（诊断与 banner 用；**不参与任何判据**） */
  readonly driver: DataSourceDriver;
  /**
   * 本实现器**此刻**的定位串（json 档 = 绝对路径）。
   * @description 是方法而不是字段：定位串可以随配置热改（runtime 相位），
   * 构造期烤死会让「换个名单文件」静默失效。
   */
  locator(): string;
  /** 判定期读整份名单（节流 + 缓存 + 四态事件）；语义：缺失 = 空名单且不算错误，坏内容保留上一份有效值并给出 `error` */
  read(options?: AclReadOptions): JsonFileRead<AclConfig>;
  /** 启动期强校验（直接读一次，不进热加载缓存、不发观察事件）；坏内容必须给 `error` 让启动失败 */
  readStartup(): Promise<JsonFileRead<AclConfig>>;
}

/** 一个驱动名对应的实现器工厂（吃定位串闭包，不吃配置访问器） */
export type AclSourceFactory = (locator: () => string) => AclSource;

/**
 * 名单装配所需的**接线**（本层与配置层之间唯一的形状）
 * @description 两个闭包、**不含任何配置键名**：数据源层一旦认识 `ConfigAccessor`（或 `get("aclFile")`
 * 这种键），「不启动代理、单独用一个数据源」那条路就在类型上不成立了。键名归
 * `@/config/acl-locator.ts` 那一个模块。
 */
export interface AclLocator {
  /** 当前驱动名（现读：`ACL_DRIVER` 是 startup 相位，但装配面一律现取） */
  readonly driver: () => DataSourceDriver;
  /** 当前数据位置（现读：路径字段可热改） */
  readonly path: () => string;
}