/**
 * @fileoverview `proxy-cli usage ...`：配额账本读面的呈现
 * @module admin/usage
 * @description
 * 本文件**只做三件事**：读一次账本（`@/ops` 的 `readUsage`）、排成表、把两条必须说的提醒打到
 * 诊断通道。**排序在这一侧**（按已用量降序是给人看的编排，`Map` 本身的迭代顺序不是语义）。
 *
 * ## 为什么「不能清账」那段话属于这一侧
 *
 * 那两句提醒（读数有多新 / 为什么清不了账）是**呈现层的责任**：账本数据本身不知道有人在终端上
 * 读它。但理由的**推导**在 `../ops/usage.ts` 文件头，**一个字都没搬走**——理由是数据的事实，
 * 措辞才是界面的话。
 *
 * @module
 */

import { readUsage, usageFor, type OpsSources } from "@/ops/index.js";
import type { AdminCommand } from "./args.js";
import { formatBytes, renderTable, type AdminIo } from "./out.js";

/** `proxy-cli usage ...` 的执行面 */
export async function runUsageCommand(
  io: AdminIo,
  sources: OpsSources,
  command: Extract<AdminCommand, { kind: "usage" }>,
): Promise<void> {
  const reading = await readUsage(sources);
  for (const error of reading.errors) {
    io.warn(`账本有问题：${error}`);
  }

  if (command.name !== undefined) {
    const usage = usageFor(reading, command.name);
    io.write(
      renderTable(
        ["用户名", "窗口", "已用（双向合计）"],
        [[command.name, usage.windowKey, formatBytes(usage.total)]],
      ),
    );
    io.warn(
      `这是账本此刻记着的数；运行中的代理判定读它自己的进程内镜像，最多落后 ${reading.lagMs}ms。`,
    );
    return;
  }

  const rows = [...reading.usage.entries()]
    .sort((a, b) => b[1].total - a[1].total)
    .map(([user, usage]) => [user, usage.windowKey, formatBytes(usage.total)]);
  io.write(
    rows.length === 0
      ? "(账本当前窗口没有任何计量记录)"
      : renderTable(["用户名", "窗口", "已用（双向合计）"], rows),
  );
  io.warn(
    `这是账本此刻记着的数。运行中的代理判定读的是它自己的进程内镜像，最多落后 ${reading.lagMs}ms；` +
      "本工具不能清账——从第二个进程删账本里的行对运行中的代理无效（它的镜像按 max 合并，见 usage 模块文件头）",
  );
}