# packages/tui/ — `@b-hole/proxy-tui`（控制面终端控制台）

独立 pnpm 包：回答「怎么在终端里驱动**别的机器上**那个控制面」。机制细节归各目录 `AGENTS.md` 与源码文件头；拆包的三条理由见根 `AGENTS.md`「两个包」一节。

## 地图

- `src/api/` — 控制面 HTTP **契约**（本包对线上契约的全部声明，**零 IO**）：端点表（`endpoints/` 下按服务端模块分段，装配成一条平表）/ 线格式 / 逐字段判据
- `src/utils/` — **工具面**（会动手的那一半）：唯一拨号点 / 两处 `字符串 → URL` 变换 / 失败三档词汇 / 收窄组合子
- `src/cmd/` — 命令表（`specs`）+ 值语法 + 分词 + 建议 + 补全 + 面板
- `src/exec/` — 一条命令 → 若干行 + 一组副作用（`run` / `rows` / `failures` / `echo`）
- `src/log/` — 一组条目 → 一组行（摊平 / 视口 / 环形缓冲 / 凭据掩码）
- `src/view/` — 界面层：`geometry.ts`（坐标的唯一真相）+ `components/` + `layout.tsx`
- `src/ledger/` — 本机台账：端点的存盘、校验、接线、探活
- `src/terminal/` — 会往 stdout 写控制序列的那一半：SGR 鼠标上报 + 全屏接管
- `src/ui/` — 排版与着色的判据（纯函数、零 IO）
- `src/app/` — 应用状态层：跨帧状态、键位、鼠标分派
- `src/cli.tsx` — 组合根：唯一的宿主采集面 + 退出边界（`@/` → 本包 `src/`）
- `tests/` — vitest 档（`pnpm test:tui`），含两档**假 TTY 真渲染**
- `dist/` — **产物** `cli.js`（ESM）；只有 `pnpm build:tui` 会重建它

## 四条不可破的事实

- **产物必须是 ESM**：`ink` 有一句顶层 `await import`，esbuild 的 `cjs` 输出表达不了 —— ⚠️ 卡的是**输出格式**，不是「Ink 不能 bundle」。
- **端点契约是手抄的弱耦合**（对面可能跑着旧版本服务端）：路径集合归根仓 `tests/unit/manager-tui-contract.test.ts` 两侧目录**现列**、从源码文本现取再比，字段形状归 `src/api/wire.ts`。⚠️ **加端点必须同时改 `src/api/endpoints/` 下与服务端同名的那个模块文件**（护栏只比集合，不看你怎么分文件）。
- **`packages: "external"` 是选择不是要求**（免得产物拖上只在 `DEV` 下干活的 peer `react-devtools-core`）；改回 bundle 是正当演进，但要当选择来改。
- ⚠️ **动了本包 `src/` 必须 `pnpm build:tui`**（或 `build:all`）：根 `pnpm build` 不碰 `dist/cli.js` ⇒ 四条全绿是**假信号**；**别为此加单测**，test 在 build **之前**。

**人工验收（单测测不到的一半）**：`pnpm dev:tui` 后在真终端里手验**鼠标上报**与**退出后终端是否干净**（屏幕恢复 / 光标可见 / 鼠标能拖选粘贴）；端到端从**临时 cwd** 起控制面，⚠️ 别在仓库根起：
`cd <临时目录> && MANAGER_ENABLED=true MANAGER_PORT=18080 MANAGER_TOKEN=… AUTH_ENABLED=false PROXY_PROTOCOL=http node <repo>/dist/app.js`
