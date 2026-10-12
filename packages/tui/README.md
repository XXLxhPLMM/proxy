# @b-hole/proxy-tui

`@b-hole/proxy-tui` 的包体积为 `~16KB`（依赖走 npm 自动安装），`proxy-tui` 命令即全局入口。

## 安装

全局安装（自动带上所有依赖，含 `node-sqlite3-wasm`）：

```bash
npm install -g @b-hole/proxy-tui
# 或
pnpm add -g @b-hole/proxy-tui
```

## 用法

```bash
proxy-tui
```

启动后进入多控制面终端控制台，交互逻辑见主仓库文档。

## 环境要求

- **Node >= 22.13**（推荐）：使用内置 `node:sqlite` 档，启动最快；
- **Node 16–22.12**：自动降级到 `node-sqlite3-wasm` 档，功能相同但启动稍慢。⚠️ 本包的地板**比主仓库低**（下限见本包 `package.json` 的 `engines`，主仓库那份只管服务端），两档驱动都随包发布，装了即有。
  - 若本地库是旧版内置档用 `journal_mode = WAL` 创建的，首次启动会告警、自动把旧库备份为 `data.db.wal-journal-incompatible-bak` 并以兼容模式重建。

库文件默认落点：`~/.config/swain-proxy/tui/db/data.db`（可被 `--db-path` 覆盖，具体见主仓库配置项）。

## 开发

```bash
pnpm build   # 编译 dist/cli.js
pnpm dev     # build --dev && 启动
```
