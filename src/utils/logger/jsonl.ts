/**
 * @fileoverview JSONL 落盘子系统（小时轮转 + 在途登记）
 * @module utils/logger/jsonl
 * @description
 * `impl.ts` 的落盘通道的全部 IO 能力都收在这里：文件名轮转、目录/文件权限、
 * appendFile 提交，以及跨实例共享的在途写集合。
 *
 * 职责：
 * - `toHourlyFile`：`YYYY-MM-DD-HH.jsonl` 小时轮转
 * - `persistLine`：mkdir 0700 + appendFile 0600 + 在途登记，**永不抛**
 * - `flushPendingWrites`：等齐**模块级**共享集合里的全部在途 appendFile
 *
 * 不负责：
 * - 不决定「这条日志要不要落盘」（等级门控在 `impl.ts`）
 * - 不做序列化/字段识别（文本层在 `sanitize.ts`），不碰等级表
 *
 * 本模块**不从 `index.ts` 导出**：它是 `impl.ts` 的私有实现面，
 * 对外只需要「能落盘」与「能等齐」，不需要知道文件叫什么。
 */

import fs from "node:fs";
import path from "node:path";

/**
 * 在途落盘集合：模块级、全实例共享（含 child 与其他 prefix），`flushPendingWrites()` 据此等齐所有 appendFile
 * @description 必须是模块级而非实例级：`child()` 派生出的子 logger 各自持有自己的
 * `fileBase`，若按实例登记，父 logger 的 `flush()` 会漏掉子 logger 的写入。
 */
const pendingWrites = new Set<Promise<void>>();

/**
 * 小时轮转：目录/无扩展名则 join，带文件名只取 dirname；按小时切分防单文件膨胀
 * @description 落盘为 JSONL（每行一个 JSON 对象），扩展名随之改为 `.jsonl`。
 * @param base - 落盘基址（目录，或带文件名的路径）
 * @returns 本小时实际写入的文件路径
 * @example toHourlyFile("log") // => "log/2026-09-26-14.jsonl"
 */
export function toHourlyFile(base: string): string {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hour = String(d.getHours()).padStart(2, "0");
  const name = `${year}-${month}-${day}-${hour}.jsonl`;
  if (!path.extname(base) || base === "log" || base === "logs") {
    return path.join(base, name);
  }
  return path.join(path.dirname(base), name);
}

/**
 * 等齐在途落盘后 resolve（模块级集合共享，child/其他实例的写入也在内）
 * @description 条目均已吞错，本函数不会 reject。
 * `process.exit` 会截断在途 appendFile：显式退出路径须先 await，正常事件循环退出无需调用。
 */
export async function flushPendingWrites(): Promise<void> {
  await Promise.allSettled([...pendingWrites]);
}

/**
 * 提交一行 JSONL 文本（串行化交给调用方，本函数只管 IO）
 * @description 静默吞错：日志故障不拖垮主流程（路径/时间/mkdir/append 失败均忽略），
 * 保证 `logger.*` 永不抛。
 * @param base - 落盘基址，经 `toHourlyFile` 换算为小时文件
 * @param line - 已带换行符的单行 JSONL 文本
 */
export function persistLine(base: string, line: string): void {
  // 静默吞错：日志故障不拖垮主流程（序列化/mkdir/append 失败均忽略）
  try {
    const file = toHourlyFile(base);
    try {
      const dir = path.dirname(file);
      if (!fs.existsSync(dir)) {
        // 0700：日志含审计行（鉴权失败、转发目标），目录不应对其他用户开放
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
    } catch {
      // ignore mkdir errors
    }
    const write = fs.promises
      .appendFile(file, line, { encoding: "utf8", mode: 0o600 })
      .catch(() => {
        // ignore persist errors
      });
    pendingWrites.add(write);
    void write.then(() => {
      pendingWrites.delete(write);
    });
  } catch {
    // ignore any persist-time error (path/时间等)，保证 logger.* 永不抛
  }
}
