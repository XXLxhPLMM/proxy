/**
 * @fileoverview 宿主告警面的唯一改写处：把 `node:sqlite` 那一条 `ExperimentalWarning` 从 stderr 上摘掉，其余一条不漏
 * @description 目录其余文件零 `process.*`；这一个文件是那条纪律在宿主边界上的**唯一**例外（stderr 是宿主的）
 */

// ⚠️ 判据**同时**看 `name` 与消息：`ExperimentalWarning` 另有别的来源，全吞等于替别人做决定
function isSqliteWarning(warning: Error): boolean {
  return warning.name === "ExperimentalWarning" && /SQLite/i.test(warning.message);
}

/**
 * 装上过滤器；返回一个**幂等**的撤销（组合根的退出路径调它）
 */
export function installSqliteWarningFilter(): () => void {
  const before = process.listeners("warning") as ((warning: Error) => void)[];
  process.removeAllListeners("warning");
  const forward = (warning: Error): void => {
    if (isSqliteWarning(warning)) return;
    // ⚠️ 转发给**装上之前**就在的那批：事后第三方自己挂的监听器一条都不该被摘掉
    for (const listener of before) listener.call(process, warning);
  };
  process.on("warning", forward);
  let released = false;
  return (): void => {
    // ⚠️ 幂等靠**先清标记**：重复 remove/on 会把默认打印器挂回去又摘下来，最后一条 warning 的去向随调用序漂
    if (released) return;
    released = true;
    process.removeListener("warning", forward);
    for (const listener of before) process.on("warning", listener);
  };
}