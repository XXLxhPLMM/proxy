import { describe, expect, it, vi } from "vitest";
import { logJsonFileEvent } from "@/config/json-file-log.js";

/**
 * 事件 → 日志呈现层断言：拦截 notice 防止写进仓库 log/（见 tests/AGENTS.md 测试不落盘）
 * cluster 下每个 worker 独立热加载、各打一行，行必须带 pid 与版本字段（mtimeMs/size）
 */
describe("config/json-file-log 事件呈现", () => {
  it("每行带 pid；reloaded/recovered/error 带 mtimeMs+size，missing 无版本字段", () => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    const event = (value: Parameters<typeof logJsonFileEvent>[0]) => logJsonFileEvent(value, logger);

    event({
      type: "reloaded",
      label: "访问控制名单文件",
      path: "acl.json",
      mtimeMs: 111,
      size: 22,
    });
    event({ type: "missing", label: "访问控制名单文件", path: "acl.json" });
    event({
      type: "recovered",
      label: "访问控制名单文件",
      path: "acl.json",
      mtimeMs: 333,
      size: 44,
    });
    event({
      type: "error",
      label: "访问控制名单文件",
      path: "acl.json",
      error: "格式非法",
      mtimeMs: 555,
      size: 66,
    });

    expect(logger.info).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledTimes(2);
    const [reloaded, recovered] = logger.info.mock.calls;
    const [missing, failed] = logger.warn.mock.calls;
    expect(reloaded[0]).toContain("已热加载");
    expect(reloaded[1]).toMatchObject({ pid: process.pid, mtimeMs: 111, size: 22 });
    expect(missing[0]).toContain("文件消失");
    expect(missing[1]).toEqual({ pid: process.pid });
    expect(recovered[0]).toContain("已恢复");
    expect(recovered[1]).toMatchObject({ pid: process.pid, mtimeMs: 333, size: 44 });
    expect(failed[0]).toContain("读取失败");
    expect(failed[1]).toMatchObject({ pid: process.pid, mtimeMs: 555, size: 66 });
  });
});
