/**
 * @fileoverview 访问控制名单的 **JSON 文件实现器**（`ACL_FILE` 背后那份数据）
 * @module datasource/acl/json-source
 * @description
 * 名单的出厂格式：一个 JSON 文件、三组名单。选它作默认档的理由与账号表 json 档同一条 ——
 * **运维能手改、能 diff、能进版本库**，而「名单配错了」这件事必须当场看得见。
 *
 * ## 节流 / 缓存 / 四态事件**刻意复用** `@/utils/json-file`，不自己写一份
 *
 * 判定每连接都要读名单，于是「读」必须是廉价的：`readJsonCached` 用 mtime 节流（默认 1s）
 * + 内容快照身份复用解决这件事。而**另开一个调用点会造成两份节流缓存、两份解析、两套坏文件
 * 处理并互相污染同一缓存键**（缓存键是 `label + path`，两个调用点必然撞上）——
 * 外部表现是「日志说名单没变、判定却换了」，那是最难查的一类症状。
 * 纪律的变异测试（断言本文件全文 `readJsonCached` 恰好一处）见
 * `../../../tests/unit/acl-configured.test.ts`。
 *
 * ## 坏内容永不接管
 *
 * 非法内容 → `error` + **沿用上一份有效值**。名单是**放行 / 拒绝**的判据，
 * 「手滑写坏一行」绝不能等价于「全放行」——那是一次配置事故变成一次安全事故。
 * 真正读不到（文件缺失 / 统计错误）才回退空名单，且空名单 = 不拦任何请求 = 部署者的显式意图。
 */

import fs from "node:fs";
import { BUILTIN_ACL_DRIVERS } from "@/datasource/driver.js";
import { readJsonCached, type JsonFileRead } from "@/utils/json-file/index.js";
import { EMPTY_ACL, type AclConfig, type AclReadOptions, type AclSource } from "./types.js";
import { validateAcl } from "./validate.js";

/** 读取的大小上限：1MiB。名单是三组字符串数组，1MiB 已经远超任何真实部署的量级。 */
const MAX_FILE_BYTES = 1024 * 1024;

/**
 * @description 缓存键的 `label` 段。**与账号表的「用户账号文件」刻意不同名**：
 * 同名会让两个数据源在「路径恰好相同」时共用一份缓存条目，而它们的回退值类型不同。
 */
const LABEL = "访问控制名单文件";

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 名单的 JSON 文件实现器
 * @description 定位串由闭包现取而不是构造期烤死：名单路径是 runtime 相位（可热改），
 * 烤死会让「换个名单文件」静默失效——而那正是它**看起来生效了、实际没换**的那类故障。
 */
export class JsonAclSource implements AclSource {
  public readonly driver = BUILTIN_ACL_DRIVERS.json;

  public constructor(private readonly resolveLocator: () => string) {}

  public locator(): string {
    return this.resolveLocator();
  }

  public read(options: AclReadOptions = {}): JsonFileRead<AclConfig> {
    return readJsonCached(options.path ?? this.resolveLocator(), validateAcl, {
      label: LABEL,
      fallback: EMPTY_ACL,
      force: options.force,
      maxBytes: MAX_FILE_BYTES,
      onEvent: options.onEvent,
    });
  }

  /**
   * 启动期强校验：直接异步读一次，**不进热加载缓存、不触发观察面**
   * @description 启动那一刻「上一份有效值」不存在，所以坏内容在这里只能变成 `error` 让启动失败，
   * 绝不能沿用（那会让一份写坏的文件悄悄配出一个「不拦任何请求」的代理）。缺失 = 空名单不算错。
   */
  public async readStartup(): Promise<JsonFileRead<AclConfig>> {
    const filePath = this.resolveLocator();
    try {
      const content = await fs.promises.readFile(filePath, "utf8");
      if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
        return {
          value: EMPTY_ACL,
          path: filePath,
          exists: true,
          error: `文件超过 ${MAX_FILE_BYTES} 字节上限`,
        };
      }

      const value = validateAcl(JSON.parse(content) as unknown);
      if (value === undefined) {
        return {
          value: EMPTY_ACL,
          path: filePath,
          exists: true,
          error: "格式非法（字段缺失、类型不符或存在未知键）",
        };
      }
      return { value, path: filePath, exists: true };
    } catch (error) {
      if (isMissingFile(error)) {
        return { value: EMPTY_ACL, path: filePath, exists: false };
      }
      return { value: EMPTY_ACL, path: filePath, exists: false, error: errorMessage(error) };
    }
  }
}