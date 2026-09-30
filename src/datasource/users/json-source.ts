/**
 * @fileoverview 账号表的 **JSON 档**：读 `cfg/users.json`
 * @module datasource/users/json-source
 * @description
 * 整个后端是「一个文件 + 一份形状校验」：`readJsonCached` 负责节流 / 缓存 / 四态事件，
 * `validateAuthUsers` 负责「什么是合法账号」。它**不认任何配置键**——路径由构造期传入的闭包
 * 现取，于是本档既能被配置层装配，也能被一个只想读账号表的库调用方直接造出来。
 *
 * ## 为什么写必然是「读-改-整文件重写」
 *
 * 文本文件没有「就地改一列」这回事。原子性靠 `.tmp` + `rename`；Windows 上 `rename` 不能覆盖
 * 已存在文件，故先删旧文件再 rename——那两步之间有一个极短的窗口，**并发写会互相覆盖**。
 * 这不是本层能修的：它就是「用文本文件当数据库」的固有代价，也正是 `sqlite` 档存在的理由。
 */

import { readJsonCached, writeJsonAtomic, type JsonFileRead } from "@/utils/json-file/index.js";
import { normalizeOne, toAccountDoc, validateAuthUsers } from "./validate.js";
import type { AccountListOptions, AccountSource, AuthAccount, PathResolver } from "./types.js";
import { BUILTIN_ACCOUNT_DRIVERS } from "../driver.js";
import { writeSkeletonIfMissing } from "../ensure-target.js";

/** 账号表空值（文件缺失时的兜底；**冻结只读哨兵**） */
const EMPTY_ACCOUNTS: readonly AuthAccount[] = Object.freeze([]);

/** JSON 实现器：读 `cfg/users.json` */
export class JsonAccountSource implements AccountSource {
  public readonly kind = BUILTIN_ACCOUNT_DRIVERS.json;

  public constructor(private readonly resolvePath: PathResolver) {}

  public list(options: AccountListOptions = {}): JsonFileRead<AuthAccount[]> {
    return readJsonCached(this.resolvePath(), validateAuthUsers, {
      label: "用户账号文件",
      fallback: EMPTY_ACCOUNTS as AuthAccount[],
      force: options.force,
      maxBytes: 1024 * 1024,
      onEvent: options.onEvent,
      // 缺失即物化成 `[]`（语义与 fallback 逐字相同，故读结果零变化）：「配了 json 档却连
      // 空文件都没有」会让运维看不出档位有没有生效，而 `[]` 本身就是这一档的合法内容。
      onMissing: (file) => {
        writeSkeletonIfMissing(file, "[]\n");
      },
    });
  }

  /**
   * 写入（`upsert`）：读整表 → 替换/追加同名项 → 整表重写
   * @description 文本文件没有「就地改一列」这回事，故写**必然**是「读-改-整份重写」。原子性靠
   * `@/utils/json-file:writeJsonAtomic`（`.tmp` + `rename`；Windows 上 `rename` 不能覆盖已存在
   * 目标，故先删再 rename——那两步之间有一个极短的窗口，**并发写会互相覆盖**）。这不是本层能修
   * 的：它就是「用文本文件当数据库」的固有代价，也正是 `sqlite` 档存在的理由。
   */
  public put(account: AuthAccount): AuthAccount {
    const normalized = normalizeOne(account);
    const current = this.list({ force: true }).value;
    const next = current.filter((a) => a.username !== normalized.username);
    next.push(normalized);
    // ⚠️ 写的是**磁盘形态**（`toDoc`），不是归一化对象：`expiresAt` 必须是带偏移的 ISO 串，
    // 写 epoch 会让这份文件在**下一次读**时被 `normalizeAccountExpiry` 判非法。
    writeJsonAtomic(
      this.resolvePath(),
      next.map((a) => JSON.parse(toAccountDoc(a)) as unknown),
    );
    return normalized;
  }

  public delete(username: string): void {
    const current = this.list({ force: true }).value;
    const next = current.filter((a) => a.username !== username);
    if (next.length === current.length) {
      return;
    }
    writeJsonAtomic(this.resolvePath(), next);
  }
}

