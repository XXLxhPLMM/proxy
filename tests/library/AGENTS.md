# tests/library — 库消费方视角（1 个文件）

## 路径说明

`entry.test.ts` —— **只 import 包入口**（`@b-hole/proxy` 或构建出的 `lib/`），**不碰任何内部路径**。它证明的是「外部调用方看得见的那一面」，与 `unit/` / `integration/` 证明的东西正交。

## 硬约定

- **零外网**、**不落盘**（判据见 `tests/AGENTS.md`）。
- ⚠️ **它覆盖的是仓内入口，不是 npm 包**。发布前的 `pnpm pack` + 外部临时项目安装 tarball 烟测**必须手动跑一次**（`files` 白名单、`scripts/` 不在 `files` 里所以没有 root `postinstall`、README 被 npm 强制包含——这三条只有真装一遍才验得到）。见根 `AGENTS.md`「已裁决的 git 状态」一节。

## 决策清单

1. **只从包入口 import** — 否掉「顺手引内部路径方便断言」— 一引就证明了「外部调用方也拿得到内部件」，而那正是出口膨胀要防的反面。内部行为由 `unit/` 各管。
2. **明确断言「不导出」的那几个符号**（`get` / `getAll` / `set` / `defaultConfigStore` / `globalConfigAccessor`）— 「没导出」是**决策**（配置状态只有 `ConfigStore`），决策就得有护栏，否则下一个人图方便加个 re-export 不会有任何东西变红。
3. **断言「零 import 期副作用」用静态依赖扫描 + 行为观测**（import 后不写文件、不注册监听）— 光断言「能 import」不够：那个模块完全可以在顶层偷偷做点事。
4. **断言零副作用时把「静态 re-export 了落盘模块」与「import 期就在落盘」分开验** — `event-log.ts` 的模块加载只创建函数定义与一张 `Record` 字面量表，绑定**只在 `createProxyRuntime(...).start()` 里**发生，而默认 logger 是 noop。三件事（静态导出 / 绑定时机 / 默认 logger）任一为真都会让「import 期零落盘」成立，所以断言要能分辨它们。
