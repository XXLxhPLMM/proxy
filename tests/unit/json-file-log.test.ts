import { afterEach, describe, expect, it, vi } from "vitest";
import { logJsonFileEvent } from "@/config/json-file-log.js";
import { Logger } from "@/utils/logger.js";

/**
 * 事件 → 日志呈现层断言：拦截 notice 防止写进仓库 log/（见 tests/AGENTS.md 测试不落盘）
 * cluster 下每个 worker 独立热加载、各打一行，行必须带 pid 与版本字段（mtimeMs/size）
 */
describe("config/json-file-log 事件呈现", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("每行带 pid；reloaded/recovered/error 带 mtimeMs+size，missing 无版本字段", () => {
    const spy = vi.spyOn(Logger.prototype, "notice").mockImplementation(() => {});

    logJsonFileEvent({
      type: "reloaded",
      label: "访问控制名单文件",
      path: "acl.json",
      mtimeMs: 111,
      size: 22,
    });
    logJsonFileEvent({ type: "missing", label: "访问控制名单文件", path: "acl.json" });
    logJsonFileEvent({
      type: "recovered",
      label: "访问控制名单文件",
      path: "acl.json",
      mtimeMs: 333,
      size: 44,
    });
    logJsonFileEvent({
      type: "error",
      label: "访问控制名单文件",
      path: "acl.json",
      error: "格式非法",
      mtimeMs: 555,
      size: 66,
    });

    expect(spy).toHaveBeenCalledTimes(4);
    const [reloaded, missing, recovered, failed] = spy.mock.calls;
    expect(reloaded[1]).toContain("已热加载");
    expect(reloaded[2]).toMatchObject({ pid: process.pid, mtimeMs: 111, size: 22 });
    expect(missing[1]).toContain("文件消失");
    expect(missing[2]).toEqual({ pid: process.pid });
    expect(recovered[1]).toContain("已恢复");
    expect(recovered[2]).toMatchObject({ pid: process.pid, mtimeMs: 333, size: 44 });
    expect(failed[1]).toContain("读取失败");
    expect(failed[2]).toMatchObject({ pid: process.pid, mtimeMs: 555, size: 66 });
  });
});
