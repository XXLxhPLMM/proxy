---
description: 检查工作区和暂存区，智能生成符合规范的提交信息并完成提交
agent: general
---

# git-commit

你是一个 Git 提交助手。根据当前工作区和暂存区状态，智能生成提交信息并完成提交。

用户补充输入：$ARGUMENTS

## 执行流程（严格按顺序）

### 1. 检查状态
并行执行以下命令收集信息：
- `git status`
- `git diff --cached --stat`（已暂存）
- `git diff --stat`（未暂存）
- `git diff --cached`（已暂存详细 diff，非截断时查看）
- `git log --oneline -10`（参考历史提交风格）
- `git branch --show-current`（当前分支）

### 2. 判断策略
- **情况 A：暂存区有内容**（`git diff --cached --stat` 有输出）→ 直接基于**暂存区**的 diff 生成提交信息并提交，**不要**再 `git add` 工作区文件。
- **情况 B：暂存区为空但工作区有变更**（`git diff --stat` 或 `git status` 显示 modified/untracked/deleted）→ 先将工作区变更添加到暂存区，再生成提交信息并提交：
  - 优先 `git add <具体文件>`，若文件过多或用户无明确筛选则 `git add -A`
  - 对于 `deleted` 文件用 `git rm` 已处理则无需额外操作
  - 添加后再次 `git diff --cached --stat` 确认
- **情况 C：工作区和暂存区均干净** → 直接告知“无可提交内容”，结束流程。

### 3. 生成提交信息
基于 diff 内容、变更文件、历史提交风格和用户输入 `$ARGUMENTS`（若有则作为提交意图补充）生成提交信息，必须遵循下方的 **提交信息规范**。

### 4. 执行提交
- 用 `git commit -m "<message>"` 提交（若需多行正文，用 `git commit -m "subject" -m "body"`）
- 提交后执行 `git status` 验证结果
- **禁止**自动 `git push`，除非用户在 `$ARGUMENTS` 中明确要求推送
- 若提交失败（如 hooks 拦截），分析错误并修复后重试

## 提交信息规范（Conventional Commits）

格式：
```
<type>(<scope>): <subject>

[optional body]

[optional footer: BREAKING CHANGE / Closes #xxx]
```

### Type 类型（必选其一）

| type | 含义 | 示例场景 |
|------|------|----------|
| feat | 新功能 | 新增代理模式、新增配置项 |
| fix | 修复 bug | 修复代理转发失败、修复内存泄漏 |
| docs | 文档变更 | 更新 README、补充注释 |
| style | 代码格式 | 格式化、分号、空格，不影响逻辑 |
| refactor | 重构 | 重命名、拆分模块，无功能变更 |
| perf | 性能优化 | 减少内存占用、提升转发速度 |
| test | 测试 | 新增/修改测试用例 |
| build | 构建系统 | 修改 build.mjs、esbuild 配置 |
| ci | 持续集成 | 修改 .cnb.yml、GitHub Actions |
| chore | 杂项 | 更新依赖、调整 .gitignore |
| revert | 回滚 | 回滚某次提交 |

### Scope 作用域（可选，推荐）

根据本项目可用：`proxy`, `server`, `client`, `manager`, `config`, `deps`, `build`, `docs`, `docker`

### Subject 主题行规则
- 使用祈使句、动词开头，小写开头，不超过 72 字符
- 中文项目可用中文，但推荐英文以保持与历史一致（本项目历史为英文）
- 末尾不加句号

### 标准示例（直接可用）

```bash
# 1. 新功能
feat(server): add SOCKS5 proxy support

# 2. 修复
fix(proxy): handle ECONNRESET on upstream disconnect

# 3. 文档
docs(readme): update proxy mode usage guide

# 4. 重构
refactor(manager): extract auth logic into standalone module

# 5. 性能
perf(server): reuse TCP connections for intermediary mode

# 6. 构建
build: migrate from webpack to esbuild

# 7. 杂项/依赖
chore(deps): bump esbuild to 0.25.0

# 8. 带正文和 BREAKING CHANGE
feat(config): redesign proxy config schema

Migrate config file from flat structure to nested `proxy.server` and `proxy.client` sections.
Old `.env` keys remain compatible via deprecated alias with warning.

BREAKING CHANGE: `PROXY_PORT` renamed to `PROXY_SERVER_PORT`

# 9. 回滚
revert: revert feat(client): add UDP relay

This reverts commit 3decfad.

# 10. 中文示例（若团队约定中文）
fix(代理): 修复 HTTP 代理请求头丢失问题
feat(管理端): 新增流量统计面板
```

### 反面示例（禁止）
```
- fix bug  # 缺少具体描述
- update  # 无 type
- feat: 新增功能。  # 末尾句号
- WIP  # 无意义
```

## 注意事项
- 提交信息必须真实反映 diff 内容，禁止臆造未修改的功能
- 若 diff 涉及多类变更（feat + fix），拆成多次提交或选用最主要的 type，并在 body 中说明
- 保持与 `git log --oneline -10` 的历史风格一致
- 用户输入 `$ARGUMENTS` 若包含明确的 subject（如“修复登录接口”），优先采纳并规范化为 `fix(xxx): ...`
