/**
 * @fileoverview 台账的**落盘**面：读、写、以及给界面看的那份打码形态
 * @module ledger/store
 * @description
 * 三件事，且只有这三件：把磁盘上的字节读成一份 {@link ./validate.ts:validateLedger} 判过的台账、
 * 把一份台账原子地写回磁盘、把一条 {@link ./types.ts:Target} 变成**可以放心显示**的形态。
 *
 * ## ⚠️ token 是**明文**落盘的 —— 这是结论，不是疏忽
 * @description
 * 先说清代价：`MANAGER_TOKEN` 等价于主机上的 root shell（控制面能读全量配置、增删账号与名单），
 * 而本目录把它逐字写进 `targets.json`。所以：
 *
 * - **绝不进日志、绝不进错误文案、绝不进任何快照**：本文件的判据与文案里没有一处引用 token 的
 *   内容（连「token 为空」这条都只说「为空」），打码形态由 {@link redactTarget} 一处给出。
 * - **不加密**：加密需要一个「能解开它的密钥」，而这个密钥要么硬编码在程序里（等于没加密），要么
 *   存在同一台机器上（与明文同一条攻击路径，还多一个密钥可丢）。**加密在这里买不到安全性，只会
 *   买到一个新的失败模式**（密钥轮换 / 迁移 / 丢失）。
 * - **不接 OS keychain**：`keytar` 之类要原生依赖，而本包刻意只依赖 `ink` / `react` / `string-width`
 *   三个纯 JS 依赖（`build.mjs` 的 `packages: "external"` 决定了第三方不进 bundle，native 依赖等于
 *   一次跨平台构建事故）。代价是这个选择会随平台的 keychain 成熟而过时，故写在这里。
 * - **真正的防线是三样**：文件 `0600` + 目录 `0700`（POSIX，本模块做得到就做）+ **位置约定**
 *   （`~/.config/proxy-tui/`，一个用户自己的配置目录，与被代理服务的工作目录无关）。这与本仓
 *   `cfg/users.json` 里明文存账号密码是**同一条纪律**，理由也同源：那份文件的处置力在「谁能读这
 *   台机器上的这个用户目录」，不在「文件里有没有密文」。
 *
 * ## 原子性的真实边界（**别把它当事务**，推导见 `src/utils/json-file/write.ts` 文件头）
 * @description
 * `.tmp` + `rename` 保证**读侧永不看到半份内容**：POSIX 的 `rename` 对同目录内原子。Windows 的
 * `rename` **不能覆盖已存在的目标**（`EPERM` / `EEXIST`），故先 `rmSync` 再 `rename` —— 那两步之间
 * 有一个**极短的「文件不存在」窗口**，而 {@link readLedger} 在那个窗口里会把缺失读成「首次启动，空
 * 台账」。本模块**不去碰**那个窗口（去掉 `rmSync` 会在 POSIX 上换成另一个方向的窗口：旧内容还在而
 * 新内容已就位，那更糟，因为读侧会把**旧的**台账当成最新的继续用）。
 *
 * **并发写会互相覆盖**：两个 TUI 进程同时读-改-重写时，后落盘的那份不含前一份的改动。本包是交互式
 * 单进程工具，「两个人同时改同一份台账」是运维场景而不是常态，故这个契约只在这里写明，不做锁。
 *
 * ## ⚠️ 读**绝不**造文件
 * @description
 * {@link readLedger} 碰不到写路径：看一眼配置不该在磁盘上留下一个「刚才我看了一眼」的痕迹（那条
 * 痕迹会让下一次「文件是否存在」这个判断失去意义）。写只由 {@link writeLedger} 发生，而它只在真要
 * 存东西时被调。
 *
 * 本模块零 console、零 `process.*`。
 *
 * @module
 */

import fs from "node:fs";
import path from "node:path";
import { LedgerError, validateLedger } from "./validate.js";
import type { Ledger, Target } from "./types.js";

/**
 * 打码后的 token 占位符
 * @description 固定长度、零信息量。⚠️ **绝不**返回「前 4 位 + 星号」那种形态：短 token 的前 4 位
 * 加上「长度有限」这一事实，足以让穷举空间小到几次尝试 —— 那不是打码，是把密钥的有效长度砍掉一半。
 */
export const REDACTED_TOKEN = "••••";

/**
 * 可以放心显示的端点
 * @description 与 {@link Target} 同形，**除了** `token`：那一位是 {@link REDACTED_TOKEN} 或空串。
 * 做成一个独立类型（而不是把 `Target` 的 `token` 标成 `string` 假装两回事）是为了让「界面拿到的
 * 东西」与「真凭据」在类型上就分得开 —— 两者的区别不该只靠一条注释。
 */
export interface TargetView extends Omit<Target, "token"> {
  /**
   * 台账里有凭据时恒为 {@link REDACTED_TOKEN}；**空串保持空串**（不是星号）
   * @description 「没配」与「配了但不给你看」是两种不同的事实，渲染成同一个值等于让用户看不出
   * 自己配的东西到底有没有被读进来（与 `src/ops/report.ts` 的同一条纪律）。
   */
  readonly token: string;
}

/** 落盘的权限位：目录只给属主、文件只给属主读写（POSIX） */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** 「这个路径不存在」的那一类 errno（不是所有读失败都是「不存在」，故只看这一个码） */
function isMissing(err: unknown): boolean {
  return (
    typeof err === "object" && err !== null && (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/**
 * 能收紧就收紧，收紧不了不拦人
 * @description
 * POSIX 上这一步才是「token 只有我能读」的实际执行者；在 Windows 上 `chmod` 只映射到只读位，
 * 基本是个成功的空操作 —— 那里靠的是**用户的 ACL**，不是本模块。
 *
 * ⚠️ **失败一律吞掉**：权限位会被 mount 选项、容器卷、别人的目录挡住，而它们挡住的是「加固」而
 * 不是「功能」。为一个加固动作失败就拒绝启动，是把一条可降级的防线变成硬依赖 —— 那会让人转而
 * `chmod 777` 绕开它。
 */
function harden(target: string, mode: number): void {
  try {
    fs.chmodSync(target, mode);
  } catch {
    // 加固失败不拦人：理由见本函数说明
  }
}

/**
 * 读台账
 * @description
 * - **文件不存在 ⇒ 空台账**。这不是错，是首次启动（`version: 1` / `selected: null` / 无端点），
 *   且本函数**不**因此创建那个文件。
 * - **存在但 parse / 校验失败 ⇒ 抛 {@link LedgerError} `unreadable`**。⚠️ **绝不**降级成空台账：
 *   界面上「重新加一遍」会拿这份空台账覆盖掉那份好的，而丢的是控制面管理员凭据（见文件头）。
 *
 * @param file - 台账文件路径（由 {@link ./path.ts:targetsPath} 给出）
 * @returns 规范形态的台账（`baseUrl` 已归一，见 {@link ./validate.ts:validateLedger}）
 * @throws {LedgerError} `unreadable`：文件读不出来 / 不是 JSON / 形状不对
 */
export function readLedger(file: string): Ledger {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (isMissing(err)) return { version: 1, selected: null, targets: [] };
    rejectUnreadable(`台账文件读不出来：${file}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    rejectUnreadable(`台账文件不是合法 JSON：${file}`);
  }
  try {
    return validateLedger(parsed);
  } catch (err) {
    if (err instanceof LedgerError) {
      rejectUnreadable(`台账形状不对（${file}）：${err.message}`);
    }
    rejectUnreadable(`台账形状不对（${file}）：${String(err)}`);
  }
}

/** 抛一个 `unreadable` 档的 {@link LedgerError}，并让控制流分析在该处收窄成 `never` */
function rejectUnreadable(message: string): never {
  throw new LedgerError("unreadable", message);
}

/**
 * 写台账（原子）
 * @description
 * 落盘的字节**一定是校验过的形态**：本函数先跑一遍 {@link validateLedger} 并写它返回的那份，故
 * 「落盘 = 校验过的字节」对台账恒成立（与 `src/utils/json-file` 那条纪律同源）。顺带的实际效果是
 * 手改乱的 `baseUrl` 在下一次写盘时被归一。
 *
 * 次序不是随意的：**先 `chmod` 再 `rename`**。反过来（先 rename 再 chmod）会留一个「文件已是 0644
 * 且 token 已在里面」的窗口，而那正是权限位唯一的作用所保护的东西。
 *
 * @param file - 台账文件路径（父目录不存在则建）
 * @param ledger - 要存的台账
 * @throws {LedgerError} `unreadable`：给定的那份不是合法台账（此时磁盘一个字节都没动）
 */
export function writeLedger(file: string, ledger: Ledger): void {
  const checked = validateLedger(ledger);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  harden(dir, DIR_MODE);

  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(checked, undefined, 2)}\n`, "utf8");
  try {
    harden(tmp, FILE_MODE);
    try {
      fs.renameSync(tmp, file);
    } catch {
      // Windows 的 rename 不能覆盖已存在的目标；先删再 rename 是那一侧的等价替换（代价见文件头）
      fs.rmSync(file, { force: true });
      fs.renameSync(tmp, file);
    }
  } finally {
    // 成功时是空操作（tmp 已被 rename 走）；失败时收掉那份**含明文 token**的半成品，
    // 而不是把它留在目录里等人（或备份程序）捡走
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * 给界面看的那份端点
 * @description
 * 唯一的打码出口，故「界面拿到的 token 从哪来」这个问题只有一个答案。**绝不**返回半截明文
 * （理由见 {@link REDACTED_TOKEN}）。
 *
 * @param target - 真端点
 * @returns token 被打码的同形对象
 */
export function redactTarget(target: Target): TargetView {
  const { token, ...rest } = target;
  return { ...rest, token: token === "" ? "" : REDACTED_TOKEN };
}
