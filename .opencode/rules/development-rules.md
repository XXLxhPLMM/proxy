# 开发规则

> 项目级强制规则，AI 与人工开发均需遵守。

## 1. 包管理 - 统一使用 pnpm

### 1.1 强制要求

- 本项目 **唯一** 包管理器为 **pnpm**，禁止使用 `npm` / `yarn` / `cnpm` / `bun` 安装依赖。
- 锁文件以 `pnpm-lock.yaml` 为准，`package-lock.json` / `yarn.lock` 不应出现在仓库中（已由 `.gitignore` / `.npmignore` 排除，若存在请删除）。
- CI、Dockerfile、脚本、文档中的安装/运行命令必须使用 `pnpm`。

### 1.2 常用命令对照

| 场景         | 执行命令                                                                          |
| ------------ | --------------------------------------------------------------------------------- |
| 安装全部依赖 | `pnpm install`                                                                    |
| 添加生产依赖 | `pnpm add <pkg>`                                                                  |
| 添加开发依赖 | `pnpm add -D <pkg>`                                                               |
| 移除依赖     | `pnpm remove <pkg>`                                                               |
| 执行脚本     | `pnpm <script>` / `pnpm run <script>`（如 `pnpm build`、`pnpm dev`、`pnpm lint`） |
| 更新依赖     | `pnpm update`                                                                     |
| 校验锁文件   | `pnpm install --frozen-lockfile`（CI 中使用）                                     |

> 项目 `package.json` 中的 `scripts` 已全部基于 `pnpm` 编写（如 `pnpm build && pnpm start:dev`），直接使用 `pnpm dev` / `pnpm build` 即可。

### 1.3 环境要求

- Node.js >= 22（`pkg` 目标为 `node22-*`，见 `package.json#pkg.targets`）
- pnpm >= 9（推荐 `pnpm@10`，通过 `corepack enable` 启用）
- 建议执行 `corepack prepare pnpm@latest --activate` 固定版本

### 1.4 AI 协作约束

- 生成、修改任何涉及依赖安装的代码/文档/脚本时，必须输出 `pnpm` 命令，不得给出 `npm install` 示例。
- 若检测到仓库中存在 `package-lock.json` / `yarn.lock`，需提示用户删除并执行 `pnpm install` 重新生成 `pnpm-lock.yaml`。
- 修改 `package.json` 后必须同步执行 `pnpm install` 更新锁文件。

## 2. 环境与构建

- 构建产物 `dist/` 不提交，由 `pnpm build`（`node build.mjs` + esbuild）生成。
- 环境变量通过 `--env-file` 加载（`.env` / `.env.development` / `.env.production` 等），不要硬编码。

## 3. 提交规范

- 提交前执行 `pnpm lint` 保证通过。
- 涉及依赖变更的提交需同时包含 `package.json` + `pnpm-lock.yaml`。

## 4. AI 协作 - 意见响应规范

- 用户提出意见/修改建议时，AI 必须先给出明确判断：**是否认同 + 理由 + 替代建议（如有）**，再执行修改；禁止不经评估直接改代码。
- 评估需基于工程原则（单一职责、可测试性、配置收敛、最小惊讶）与项目现状，给出 1-2 句专业结论。

## 5. AI 人格 - 工程辩论

- AI 需具备顶级工程师人格：有主见、敢反驳、直言不讳，以事实和工程原则为依据，不做无脑迎合。
- 允许与用户就技术方案进行激烈辩论，相互骂醒以求最优解，但保持对事不对人、底线尊重。
- 用户明确授权时，AI 可使用犀利/带脏字的口吻回击，目的为提升讨论张力，而非人身攻击。

## 6. 常量收敛 - 正则与魔术值必须进 constants.ts（上下文强制预读）

- 背景：`src/utils/constants.ts` 默认不在上下文（常驻上下文仅 `AGENTS.md` + `rules/*.md`，见 `.opencode/opencode.jsonc#instructions`），极易写出重复字面量。
- 禁止在 `src/` 调用点手写正则字面量（`/.../`、`new RegExp`）与具备协议/业务语义的魔术字符串/数字；一律收敛到 `src/utils/constants.ts`，调用点只引用常量。
- “类似常量文件里的情况”判定（满足任一即算类似，必须进 constants）：
  1. 复用性：在 ≥2 处使用，或可预见会被复用；
  2. 协议语义：承载 HTTP/SOCKS/RFC 语义（版本、状态行、状态码、原因短语、头名/头值、auth scheme、分隔符 CRLF、响应模板、二进制版本号/命令/地址类型/应答码等）；
  3. 脆弱性：写错会导致互通失败/安全绕过（鉴权前缀尾空格、挑战头值、目标 URL 判定等）；
  4. 性能：热路径可预编译/预拼装（`RE_*`、`Buffer.from([...])`、`HTTP_*`）避免重复构造。
- 上下文强制预读（解决 util 不进上下文）：凡涉及正则/协议字符串/状态码/二进制模板，动手前必须 `Read src/utils/constants.ts` 全文确认是否已有可用常量；无现有常量才新增，新增只加 `constants.ts`，不在调用点临时定义。
- 正则专项：必须以 `RE_*` 命名预编译导出并附注释（用途/匹配示例/flag 说明）；需动态拼接的一律经 `build*()` 函数构造。
- 例外（可不进 constants）：仅单函数一次性、纯本地无协议语义的琐碎字面量（如 `join(",")` 的 `","`、临时 split 分隔符、log 文案、测试断言期望值）。一旦复用即刻提升为常量。
- `constants.ts` 保持零依赖纯值定义，禁止从其他模块 import。
