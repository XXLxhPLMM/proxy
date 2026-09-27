# src/config/schema/ — 文件与路径说明

- `fields.ts` — 字段定义类型 `FieldDef`、字段元数据表 `FIELDS` 与按相位分组的键集合。
- `parse.ts` — 字符串到标量的解析原语（字符串 / 数字 / 枚举 / 布尔）。
- `validate.ts` — 字段范围校验与 auth 组合校验的函数集合。
- `upstream-url.ts` — `UPSTREAM_URL` 字段契约：scheme 映射表、解析与拆项写入。
- `index.ts` — 本层出口：`FIELDS`、`keysByPhase`、`FieldDef`、三个校验函数、`toBoolean`。

相关路径：`../types.ts:AppConfig`、`../store.ts:defaults`、`../normalize/upstream.ts`（拆项编排调用方）、`../sources/`（字段值来源）、`../normalize/`（副本归一）、`.env.example`、`tests/setup-env.ts:CONFIG_ENV_KEYS`、`@/utils/constants/index.js`（缺省端口常量）、`@/core/types/proxy.js`（协议联合，type-only）。

`upstream-url.ts` 以相对路径被 `../normalize/upstream.ts` 与单测引用，`schema/index.ts` 的出口列表里没有它。

相关测试：`tests/unit/config-loader.test.ts`、`tests/unit/quota-config-fields.test.ts`、`tests/unit/traffic-ledger.test.ts`。
