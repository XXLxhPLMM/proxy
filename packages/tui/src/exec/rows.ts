/** @fileoverview 控制面回的东西 → 结果区的那些行（表格一律经 `planColumns` 排好版；⚠️ 服务端的限定语逐字上屏，一个字都不改写） */

import type {
  AclBody,
  AccountBody,
  ChangeBody,
  ConfigBody,
  ConfigKeyBody,
  StatusBody,
  UsageBody,
  UsageOneBody,
  UsersBody,
} from "@/api/index.js";
import { COMMAND_PREFIX, COMMAND_SPECS, findSpec } from "@/cmd/index.js";
import type { LogRow } from "@/log/index.js";
import { ACL_LISTS } from "@/utils/index.js";
import {
  EM_DASH,
  MASKED,
  UNLIMITED,
  bytes,
  duration,
  isoOrNull,
  onOff,
  planColumns,
  uptime,
  type CellValue,
  type ColumnSpec,
} from "@/ui/index.js";

/** 一张表：把 {@link planColumns} 的产物**拍平成字符串**塞进 {@link LogRow}；⚠️ 本层**一个字节的宽度都不自己算** */
function table(
  specs: readonly ColumnSpec[],
  rows: readonly (readonly CellValue[])[],
  width: number,
): LogRow {
  const plan = planColumns(specs, rows, width);
  const right: number[] = [];
  for (let i = 0; i < plan.columns.length; i += 1) {
    if (plan.columns[i]?.align === "right") right.push(i);
  }
  return {
    kind: "table",
    head: plan.columns.map((column) => column.header),
    rows: plan.rows,
    right,
  };
}

/** `config` 的 `value`（`unknown`）→ 一格文本；⚠️ 本包**不许猜**服务端配置 schema 的类型，对象与数组一律 `JSON.stringify` 铺开 */
/** 本包**只有这一处**把配置值渲染出来，这里就是那唯一的判据 */
function configValue(value: unknown): string {
  if (value === undefined) return EM_DASH;
  if (typeof value === "string") return value;
  if (value === null || typeof value === "object") return JSON.stringify(value) ?? EM_DASH;
  return String(value);
}

/** `config` 的「来源」那一格；⚠️ **`fileOrigin` 为 `undefined` 的含义是「不在任何 env 文件里」**，⚠️ 刻意**不写「来自缺省」** */
function originCell(key: ConfigKeyBody): string {
  if (key.fileOrigin !== undefined) return key.fileOrigin;
  if (key.fromEnv) return "宿主env";
  if (key.fromArgv) return "CLI";
  return "不在 env 文件";
}

/** 账号的「配额」那一格（⚠️ `bytes === 0` 是**不限量**，不是除零也不是「零字节」） */
function quotaCell(account: AccountBody): string {
  const quota = account.quota;
  if (quota === undefined) return `${UNLIMITED}（未配）`;
  const size = quota.bytes === 0 ? UNLIMITED : bytes(quota.bytes);
  return quota.window === undefined ? size : `${size} / ${quota.window}`;
}

/** 账号的个人名单条数（判定在代理的 personal 层，与全局名单是两类语义） */
function personalCell(account: AccountBody): string {
  const white = account.acl?.target.whitelist.length ?? 0;
  const black = account.acl?.target.blacklist.length ?? 0;
  return `白${String(white)}/黑${String(black)}`;
}

/** 列表与详情共用的一格「到期」（服务端两种形态都给，两种都显示，不替操作者选一种） */
function expiresCell(account: AccountBody): string {
  if (account.expiresAt === undefined) return EM_DASH;
  return `${isoOrNull(account.expiresAtIso)}（${String(account.expiresAt)}）`;
}

/** `host:port`；任一为 `null` 就是「没有这个数」，**不拿 0 冒充** */
function listenCell(host: string | null, port: number | null): string {
  if (host === null || port === null) return EM_DASH;
  return `${host}:${String(port)}`;
}

/** `status` 的三个小节：进程 / 数据面 / 账本与名单 */
export function statusRows(body: StatusBody): readonly LogRow[] {
  const data = body.data;
  return [
    { kind: "head", text: "进程" },
    { kind: "kv", key: "pid", value: String(body.process.pid) },
    { kind: "kv", key: "node", value: body.process.node },
    { kind: "kv", key: "平台", value: body.process.platform },
    { kind: "kv", key: "cwd", value: body.process.cwd },
    { kind: "kv", key: "进程已跑", value: uptime(body.process.uptimeMs) },
    { kind: "head", text: "数据面" },
    { kind: "kv", key: "模式", value: body.proxy.mode },
    { kind: "kv", key: "协议", value: body.proxy.protocol ?? EM_DASH },
    { kind: "kv", key: "监听", value: listenCell(body.proxy.host, body.proxy.port) },
    { kind: "kv", key: "running", value: onOff(body.proxy.running) },
    // ⚠️ cluster master 的 `uptimeMs` 是 `null`，`uptime` 给 `—`（不宣称「它刚起来」）
    { kind: "kv", key: "数据面已跑", value: uptime(body.proxy.uptimeMs) },
    { kind: "head", text: "账本与名单" },
    { kind: "kv", key: "配置目录", value: data.configDir },
    {
      kind: "kv",
      key: "env 文件",
      value: data.envFiles.length === 0 ? EM_DASH : data.envFiles.join(" / "),
    },
    { kind: "kv", key: "账号表", value: `${data.accounts.driver}  ${data.accounts.path}` },
    { kind: "kv", key: "名单", value: `${data.acl.driver}  ${data.acl.path}` },
    // ⚠️ **只有 `dir`**：服务端刻意不给文件名（给了就要造一个数据源），本层不许拼一个出来
    { kind: "kv", key: "用量账本", value: `${data.usage.driver}  ${data.usage.dir}` },
    { kind: "kv", key: "鉴权", value: `${onOff(data.auth.enabled)} / ${data.auth.type}` },
    { kind: "kv", key: "配额重置", value: String(data.quotaResetHour) },
    { kind: "kv", key: "缺省窗口", value: data.defaultQuotaWindow },
    { kind: "kv", key: "写盘间隔", value: duration(data.flushIntervalMs) },
    // ⚠️ 逐字，**不改写也不替服务端判断该不该显示**（cluster master 的 `running: false` 是正常的）
    { kind: "note", text: body.runningMeans },
  ];
}

/** `config`（不带键名）：一张键值表；⚠️ **按服务端给的顺序**呈现（它自己按相位分组，本层不重排），且空集**必须出文案** */
export function configTable(body: ConfigBody, width: number): readonly LogRow[] {
  if (body.keys.length === 0) {
    return [
      { kind: "note", text: `控制面没有报出任何配置键（共 ${String(body.summary.total)} 个）` },
    ];
  }
  const specs: readonly ColumnSpec[] = [
    { header: "key", width: "flex", min: 8 },
    { header: "value", width: "flex", min: 8 },
    { header: "来源", width: "auto", min: 6 },
    { header: "重启", width: 4, min: 4 },
  ];
  const rows = body.keys.map((key) => [
    key.key,
    // ⚠️ 打码是服务端的决定：只按它给的 `secret` 标志渲染
    key.secret ? MASKED : configValue(key.value),
    originCell(key),
    onOff(key.restartRequired),
  ]);
  return [
    table(specs, rows, width),
    {
      kind: "note",
      text: `共 ${String(body.keys.length)} 个键（其中 ${String(body.summary.secrets.length)} 个是密钥，已打码）`,
    },
  ];
}

/** `config <键名>`：一条一个键值对（值可能很长，塞进一格表格会被切） */
export function configOne(key: ConfigKeyBody): readonly LogRow[] {
  return [
    { kind: "head", text: key.key },
    { kind: "kv", key: "值", value: key.secret ? MASKED : configValue(key.value) },
    { kind: "kv", key: "来源", value: originCell(key) },
    { kind: "kv", key: "相位", value: key.phase },
    { kind: "kv", key: "重启", value: onOff(key.restartRequired) },
    { kind: "kv", key: "宿主env", value: onOff(key.fromEnv) },
    { kind: "kv", key: "argv", value: onOff(key.fromArgv) },
  ];
}

/** `users` 的列（⚠️ 定值列是**承诺**：`disabled` 有 8 个字符，切成 `dis…` 的表头读不出是什么开关） */
const USER_SPECS: readonly ColumnSpec[] = [
  { header: "username", width: "flex", min: 10 },
  { header: "密码", width: 4, min: 4 },
  { header: "disabled", width: 8, min: 8 },
  { header: "到期", width: 24, min: 24 },
  { header: "配额", width: "auto", min: 8 },
  { header: "个人名单", width: "auto", min: 8 },
];

/** `users`：按 username **升序**（要的是确定性 —— 同一份数据两次渲染出同一个顺序才能对照着看） */
export function userRows(body: UsersBody, width: number): readonly LogRow[] {
  if (body.accounts.length === 0) {
    return [{ kind: "note", text: "账号表是空的（user add <用户名> 建第一个账号）" }];
  }
  const sorted = [...body.accounts].sort((a, b) =>
    a.username < b.username ? -1 : a.username > b.username ? 1 : 0,
  );
  return [
    table(
      USER_SPECS,
      sorted.map((account) => [
        account.username,
        onOff(account.password.set),
        onOff(account.disabled),
        expiresCell(account),
        quotaCell(account),
        personalCell(account),
      ]),
      width,
    ),
    { kind: "note", text: `共 ${String(sorted.length)} 个账号` },
  ];
}

/** `usage` 的三段限定（⚠️ `sideEffect` 与 `note` **逐字**，一个字都不改） */
function usageQualifiers(reading: {
  readonly lagMs: number;
  readonly sideEffect: string;
  readonly note: string;
}): readonly LogRow[] {
  return [
    // 人读形态与原值**都**给：人读那一份用来判断严重性，原值那一份用来对账
    {
      kind: "kv",
      key: "账本可能滞后",
      value: `${duration(reading.lagMs)}（${String(reading.lagMs)} ms）`,
    },
    { kind: "note", text: reading.sideEffect },
    { kind: "note", text: reading.note },
  ];
}

/** 账本读失败的旁路（**逐条**显示，不合并成一句） */
function usageErrors(messages: readonly string[]): readonly LogRow[] {
  return messages.map((message) => ({ kind: "note", text: message }));
}

/** `usage`（全量） */
export function usageRows(body: UsageBody, width: number): readonly LogRow[] {
  const specs: readonly ColumnSpec[] = [
    { header: "用户", width: "flex", min: 8 },
    { header: "窗口", width: "auto", min: 6 },
    { header: "已用", width: "auto", min: 8, align: "right" },
  ];
  const head: readonly LogRow[] =
    body.usage.length === 0
      ? [{ kind: "note", text: "账本此刻没有记录任何用户的用量" }]
      : [
          table(
            specs,
            body.usage.map((one) => [one.user, one.windowKey, bytes(one.total)]),
            width,
          ),
        ];
  return [...head, ...usageErrors(body.errors), ...usageQualifiers(body)];
}

/** `usage <用户名>`：单条（⚠️ `usage` 字段是**一个对象**不是数组，见 `@/api/wire.js:SHAPES.usageOne`） */
export function usageOneRows(body: UsageOneBody): readonly LogRow[] {
  return [
    { kind: "head", text: `用户 ${body.usage.user}` },
    { kind: "kv", key: "窗口", value: body.usage.windowKey },
    { kind: "kv", key: "已用", value: bytes(body.usage.total) },
    // ⚠️ 单条是**对账**的场合，给精确字节数（`@/ui/format.ts:bytes` 文件头指明的那一处）
    { kind: "kv", key: "精确字节", value: String(body.usage.total) },
    ...usageErrors(body.errors),
    // ⚠️ 限定取**这一次**的读：详情是另一次请求，它自带的 `lagMs` 才是那个数的归属
    ...usageQualifiers(body),
  ];
}

/** `acl`：一张表，**归属写在同一行上**（组与方向两列紧挨着条目列） */
export function aclRows(body: AclBody, width: number): readonly LogRow[] {
  const cells: CellValue[][] = [];
  // ⚠️ 组名**逐字用服务端给的键**（`clientIp` / `target` / `upstream`），本层不做大小写折算：
  // `ACL_LISTS` 那份清单是**HTTP 入参**用的名字（`clientip`），拿它去索引响应体是两份词汇混用
  for (const [group, lists] of Object.entries(body.acl)) {
    for (const list of ACL_LISTS) {
      for (const entry of lists[list]) cells.push([group, list, entry]);
    }
  }
  if (cells.length === 0) {
    return [{ kind: "note", text: "六份名单都是空的（没有白名单条目，也没有黑名单条目）" }];
  }
  const specs: readonly ColumnSpec[] = [
    { header: "组", width: "auto", min: 6 },
    { header: "方向", width: "auto", min: 6 },
    { header: "条目", width: "flex", min: 10 },
  ];
  return [table(specs, cells, width), { kind: "note", text: `共 ${String(cells.length)} 条` }];
}

/** 一次写的结果（账号写与名单写共用这一个形状）；⚠️ 「已改 / 没动」是**本层唯一的本地判断**（`changed: false` **是成功**，渲染成错误会让操作者以为操作没成） */
/** ⚠️ `effective` **只在** `changed` 为真时显示：不承诺一件没发生的事 */
export function changeRows(body: ChangeBody): readonly LogRow[] {
  const rows: LogRow[] = [
    { kind: "kv", key: "写入", value: body.changed ? "已改" : "没动" },
    { kind: "note", text: body.message },
  ];
  if (body.notice !== undefined && body.notice !== null) {
    rows.push({ kind: "note", text: body.notice });
  }
  if (body.changed && body.effective !== undefined && body.effective !== null) {
    rows.push({ kind: "note", text: body.effective });
  }
  return rows;
}

/** `help`（无主题）：命令表逐行一条（数据源是 `@/cmd` 那**唯一**一份表，本层不另抄） */
export function helpRows(topic: string | null, width: number): readonly LogRow[] {
  if (topic !== null) {
    const spec = findSpec(topic);
    if (spec === undefined) {
      return [{ kind: "err", text: `help 里没有这个命令名：${topic}` }];
    }
    // ⚠️ 头一行印的是 **`path`**（`/user add`）而不是 `name`：这一屏上印出来的就是操作者回车时该敲的那一串
    const rows: LogRow[] = [
      { kind: "head", text: spec.path },
      { kind: "kv", key: "说明", value: spec.summary },
      { kind: "kv", key: "用法", value: spec.usage },
    ];
    if (spec.subs.length > 0) {
      rows.push({ kind: "kv", key: "子命令", value: spec.subs.join(" / ") });
    }
    for (const one of spec.args) {
      rows.push({ kind: "kv", key: `形参 ${one.label}`, value: one.required ? "必填" : "选填" });
    }
    if (spec.args.length === 0) rows.push({ kind: "note", text: "这一条不带形参" });
    return rows;
  }
  const specs: readonly ColumnSpec[] = [
    { header: "命令", width: "auto", min: 8 },
    { header: "说明", width: "flex", min: 12 },
  ];
  return [
    table(
      specs,
      // ⚠️ 逐行用 `path`：命令面板（`@/cmd/palette.js`）印的也是它，两屏必须逐字一致
      COMMAND_SPECS.map((spec) => [spec.path, spec.summary]),
      width,
    ),
    { kind: "note", text: `${COMMAND_PREFIX}help <命令名> 看用法与形参` },
  ];
}