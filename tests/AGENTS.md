# tests — 本地测试服务器

`tests/` 当前只保留独立的 HTTP 测试源站；V5 的单元/集成测试、Vitest 配置、测试 helpers、裸 Node 客户端和压测器已移除。

## 保留内容

- `http-test-server.mjs`：基于 `node:http` + `node:cluster` 的本地吞吐测试服务器。
- 唯一命令入口：`pnpm test:server`。
- 不读取 `src/`，不依赖 Vitest，也不需要先执行 build。

## 使用约定

- CLI 参数优先于 `TEST_*` 环境变量，再使用默认值。
- Agent 不自行启动常驻测试服务器；由用户按需启动并在验证后自行停止。
- 该服务器只提供测试源站，不验证代理内核行为、鉴权/ACL 判定或插件装配。
