/**
 * @fileoverview JSON 配置的**原子整份重写**原语（`.tmp` + `rename`）
 * @module utils/json-file/write
 * @description
 * 读侧有 `@/utils/json-file` 那套节流 / 缓存 / 四态事件，写侧只有**这一个**原语：文本文件没有
 * 「就地改一列」这回事，故任何写必然是「读-改-整份重写」，而整份重写必须**要么全成、要么全不成**。
 * 账号表（`@/datasource/users/json-source.ts`）与访问控制名单（`@/datasource/acl/json-source.ts`）
 * 都用它，两处各抄一份的后果是「A 档的原子性比 B 档强一点」这种没人能一眼看出的漂移。
 *
 * ## 原子性的真实边界（**别把它当事务**）
 *
 * `.tmp` + `rename` 保证的是**读侧永不看到半份内容**：POSIX 的 `rename` 对同目录内是原子的，
 * 读侧要么拿到旧 inode、要么拿到新 inode。Windows 的 `rename` **不能覆盖已存在的目标**
 * （`EPERM` / `EEXIST`），故这里先 `rmSync` 再 `rename`——两步之间有一个**极短的「文件不存在」
 * 窗口**，而读侧那个窗口里会把「缺失」当成合法状态（缺失 = 空配置）。
 *
 * ⚠️ **这仍是「用文本文件当数据库」的固有代价，不是本原语能修的东西**，也正是 sqlite 档存在的
 * 理由。原语**不去碰**那个窗口（去掉 `rmSync` 会在 POSIX 上换成另一个方向的窗口：旧内容短暂
 * 还在，而新内容已经就位 —— 那更糟，因为读侧会把**旧的**名单当成最新的继续用）。
 *
 * **并发写会互相覆盖**：两个进程同时读-改-重写时，后落盘的那份不含前一份的改动。这条对调用方
 * 是**必须知道的契约**（读-改-写不是事务），故 `AccountSource.put` 与 `AclSource.write` 的注释里
 * 都点了名。
 *
 * ## 为什么这一层归 `@/utils`
 *
 * 它是纯 fs 机制：不知道账号、不知道名单、不知道任何配置键。骨架物化（`writeSkeletonIfMissing`）
 * 在 `@/datasource/ensure-target.ts` 而不是这里，理由是**骨架内容是业务知识**（缺失 = 空表 vs
 * 缺失 = 还没建表，两种含义不同），而「怎么把一段文本原子地放上磁盘」不是。
 */

import fs from "node:fs";
import path from "node:path";

/**
 * 整份重写一个 JSON 文件：`.tmp` + `rename`（**建父目录**，故「配了个还不存在的路径」能成功）
 * @description
 * 收的是**磁盘形态**（未归一化的 `unknown`）而不是业务对象：落盘的每一个字节都必须是读侧
 * 形状校验判的那份形态。调用方**必须先校验再写**——本函数不做任何校验，它只是「把这段字节
 * 原子地放上去」。
 *
 * 缩进 2 + 尾换行：与仓库里 `cfg/users.json` / `cfg/acl.json` 的形态一致。这个后端存在的首要
 * 理由就是「运维能手改、能 diff、能进版本库」，那么它写出来的文件就必须是人能读、能 diff 的形态。
 * 一台机器的 JSON 档被脚本改过之后，那份文件长什么样，决定了运维下次还认不认得它。
 *
 * @param file - 目标文件绝对路径（父目录不存在则建）
 * @param value - **磁盘形态**的 JSON 值
 * @throws 写入 / rename 失败时原样抛出（调用方据此决定退出码；**不静默**）
 * @example writeJsonAtomic("/srv/proxy/cfg/acl.json", { target: { whitelist: ["example.com"] } })
 */
export function writeJsonAtomic(file: string, value: unknown): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, undefined, 2)}\n`, "utf8");
  try {
    fs.renameSync(tmp, file);
  } catch {
    // Windows 的 rename 不能覆盖已存在的目标；先删再 rename 是那一侧的等价原子替换。
    fs.rmSync(file, { force: true });
    fs.renameSync(tmp, file);
  }
}
