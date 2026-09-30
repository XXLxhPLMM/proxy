/**
 * @fileoverview 数据源目标的**物化**原语：目标不存在就把它造出来
 * @module datasource/ensure-target
 * @description
 * 「配了驱动却在磁盘上零证据」是本层最贵的一种失败形态：`.env` 里写着
 * `AUTH_USERS_DRIVER=sqlite`，进程正常起来、日志干净，而 `users.db` 永远不出现——
 * 运维没有任何东西可看，只能靠猜。根因是共用的读层对「文件缺失」一律短路回退
 * （`@/utils/json-file` 分支 ③），那条规则对 json 档成立（缺失 = 没配），
 * 对 DB 却不成立（缺失 = 还没建表，而建表本该由驱动自己做）。
 *
 * ## 三条不变量（破了就是新事故，故写在这里而不是散在调用点）
 *
 * 1. **永不覆盖**：`flag: "wx"` 独占创建。已存在的文件、并发两个进程同时物化、
 *    运维手改过的内容——一律原样保留。这条是**安全**约束：物化绝不能变成「用空骨架
 *    覆盖真配置」，那会把一次「文件被误删」放大成「账号表被清空」。
 * 2. **绝不抛**：只读文件系统、无权限、路径是目录……这些部署**今天能跑**
 *    （缺失按「空」处理），加了物化之后不许变成起不来。故全部错误吞掉并返回布尔，
 *    调用方据此（最多）发一条事件，可见性交给读层本来就会发的 `missing` 事件。
 * 3. **不在热路径**：只从读层的「缺失」分支调用，而那个分支本身被节流去重
 *    （同一次缺失只调一次），故稳态零 IO。
 *
 * ## 「删除文件」不再是「清空配置」的手段
 *
 * 物化之后，运维删掉 `users.json` / `acl.json` 会在下一次读取时被重建成空骨架。
 * **语义仍然等价**（缺失的语义本来就是「空」，重建的也是「空」），但磁盘上的观感变了：
 * 「我删了名单文件」不再留下「文件不存在」这个证据。这个取舍是「让配置可见」这一侧的代价，
 * 写在这里是为了下一个人不必重新推导。
 *
 * @module
 */

import fs from "node:fs";
import path from "node:path";

/**
 * 目标文件不存在时写入给定骨架内容（**永不覆盖**、**失败不抛**）
 * @description sqlite 档**不用**这个原语：建表语句是各数据源自己的真相源
 * （`users/sqlite-source.ts:CREATE_ACCOUNTS_TABLE`），由那个源自己建表再关掉，
 * 免得这里再抄一份 DDL——两份 DDL 就是「两档形状漂移」的发生地。
 * @param file - 目标文件绝对路径
 * @param content - 骨架内容（调用方给，语义等价于「该文件不存在时的读结果」）
 * @returns `true` = 本次调用创建了文件；`false` = 已存在或创建失败（两种都不该是错误）
 */
export function writeSkeletonIfMissing(file: string, content: string): boolean {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // `wx` = 写 + 独占：文件已存在时抛 EEXIST，于是「已存在」天然退化成「什么都不做」，
    // 并发物化（多进程 / 多 worker 同启）也只会成功一个。
    fs.writeFileSync(file, content, { encoding: "utf8", flag: "wx" });
    return true;
  } catch {
    return false;
  }
}
