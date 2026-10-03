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
- `src/app/` — 应用状态层：跨帧状态、键位、鼠标分派、宽高跟踪（`resize`）
- `src/cli.tsx` — 组合根：唯一的宿主采集面 + 退出边界（`@/` → 本包 `src/`）
- `tests/` — vitest 档（`pnpm test:tui`），含两档**假 TTY 真渲染**
- `dist/` — **产物** `cli.js`（ESM）；只有 `pnpm build:tui` 会重建它

## 四条不可破的事实

- **产物必须是 ESM**：`ink` 有一句顶层 `await import`，esbuild 的 `cjs` 输出表达不了 —— ⚠️ 卡的是**输出格式**，不是「Ink 不能 bundle」。⚠️ 故入口判据是 `import.meta.url` 与 `process.argv[1]` 的 `file:` URL **逐字相等**（没有 `require.main` 可用；不相等就落空成「什么也不做、退出码 0」）。
- **端点契约是手抄的弱耦合**（对面可能跑着旧版本服务端）：路径集合归根仓 `tests/unit/manager-tui-contract.test.ts` 两侧目录**现列**、从源码文本现取再比，字段形状归 `src/api/wire.ts`。⚠️ **加端点必须同时改 `src/api/endpoints/` 下与服务端同名的那个模块文件**（护栏只比集合，不看你怎么分文件）。
- **`packages: "external"` 是选择不是要求**（免得产物拖上只在 `DEV` 下干活的 peer `react-devtools-core`）；改回 bundle 是正当演进，但要当选择来改。
- ⚠️ **动了本包 `src/` 必须 `pnpm build:tui`**（或 `build:all`）：根 `pnpm build` 不碰 `dist/cli.js` ⇒ 四条全绿是**假信号**；**别为此加单测**，test 在 build **之前**。

**人工验收（单测测不到的一半）**：`pnpm dev:tui` 后在真终端里手验**鼠标上报**、**退出后终端是否干净**（屏幕恢复 / 光标可见 / 鼠标能拖选粘贴）与**改窗口大小（拉宽拉窄终端）**—— Ink 自己会重排它手里那**上一帧**，而应用必须按**新的**高宽重排一帧新的；`tests/input.test.ts` 那一档只验得「resize 之后屏上那一帧按新尺寸重排了」，真终端上还得看有没有闪一帧旧布局、有没有卡住；端到端从**临时 cwd** 起控制面，⚠️ 别在仓库根起：
`cd <临时目录> && MANAGER_ENABLED=true MANAGER_PORT=18080 MANAGER_TOKEN=… AUTH_ENABLED=false PROXY_PROTOCOL=http node <repo>/dist/app.js`

⚠️ **右键那一半在很多终端里压根到不了**：Windows Terminal 与一批终端在右键时弹出**自己的**菜单，
并且**不把那次按下转发给应用** —— 那一层在终端模拟器里，本包管不着（见 `src/terminal/AGENTS.md`
那一节）。故「侧边栏空白处右键 = 新开会话」「右键某一项 = 关掉它」必须**记成一个「取决于终端」的
功能**，不许当它是到处都能用的入口；会话的新建与关闭因此各有第二条路（`/new` 与 `Ctrl+X`）。
⚠️ 同一条推论适用于**手验清单**：右键那两条在 Windows Terminal 上**验不了**，别把它记成「功能坏了」——
先确认你那个终端发不发 `ESC[<2;…M`。

⚠️ **悬停那一枚「✕」在按 CJK 宽度渲染的终端里会差一列**：`✕`（U+2715）的 East Asian Width 是
**Ambiguous**，而按一列算的 `string-width` 与按两列画的终端对它给不同答案（理由与缓解见
`src/view/geometry.ts` 的 `SESSION_CLOSE_COLUMNS`）。手验时要把侧边栏**拖到最窄**
（`SIDEBAR_MIN_WIDTH`）看一眼那一行会不会宽出一列。
