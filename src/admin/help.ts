/**
 * @fileoverview `proxy-cli` 的帮助文本
 * @module admin/help
 * @description
 * **帮助文本是本工具唯一的手册**，所以它必须说清三件常被跳过的事：①配置从哪来（env 文件 +
 * cwd）；②退出码有哪几个；③哪些事**这个工具故意不做**以及为什么。
 *
 * ③是最要紧的一条。一个「查不到的功能」如果只在源码里写着理由，运维的体感是「这工具没做完」；
 * 写在 `--help` 里，体感才是「哦，它是不这么做的」——这两者对下一次使用的差别很大。
 *
 * @module
 */

import type { AdminIo } from "./out.js";

const GENERAL = `proxy-cli —— 本机账号 / 名单 / 用量的管理工具（不启动代理）

用法
  proxy-cli <命令> [参数…]
  proxy-cli help [user|acl|usage|config]

配置从哪来
  与代理逐字相同：当前目录的 .env.production / .env.development / .env.$NODE_ENV（后者可被
  前两者覆盖），加宿主环境变量；USE_HOME_CONFIG=true 时配置目录换成 ~/.proxy。相对路径按配置
  目录解析。命令行参数**不是**配置项——要临时换一份数据源请用环境变量：
    AUTH_USERS_DRIVER=sqlite proxy-cli user list
    ACL_FILE=/tmp/acl.json proxy-cli acl show

退出码
  0  成功
  1  操作失败（账号不存在 / 已被占用 / 名单驱动只读 / 形状非法 / 读不到数据）
  2  用法错（命令或参数拼错、参数个数不对）

命令
  user     账号表：list / show / add / set / passwd / disable / enable / remove
  acl      访问控制名单：show / add / remove
  usage    配额账本：show（只读，见下方「不做的事」）
  config   show —— 此刻正在操作哪三份数据（驱动 + 绝对路径）

细节
  proxy-cli help user
  proxy-cli help acl
  proxy-cli help usage
  proxy-cli help config

不做的事
  · 不启动代理，也不起监听端口——它只读配置与数据源。
  · usage 没有任何写操作（没有 reset）。判定读的是代理进程内的镜像、合并用 max，
    从第二个进程删账本里的行对运行中的代理无效；要真清账请停代理 → 改账本 → 重启。
  · 不做字段级的账号改写接口。账号表底层只有「整条替换」一种写，所以 user set / disable /
    enable 一律是「读-改-整条写回」，未指定的字段逐字保留。`;

const USER = `proxy-cli user —— 账号表

  user list                          列出全部账号
  user show <name>                   列出单个账号的全部字段
  user add <name> <password>         新建账号（等价于 user add <name> --password <password>）
  user set <name> [字段…]            改字段；未指定的字段**逐字保留**
  user passwd <name> <newpassword>   只改密码
  user disable <name>                禁用（等价于 user set <name> --disabled）
  user enable  <name>                启用（等价于 user set <name> --no-disabled）
  user remove <name>                 删除

user add / user set 的字段参数
  --password <pw>              新密码
  --quota <bytes|clear>        流量上限；0 = 不限流（与不配等价），clear = 删掉整个 quota
  --window <day|month|clear>   配额窗口；不给 --quota 而账号当前又没有 quota 时会报错
  --expires <ISO|clear>        有效期截止，ISO 8601 且**必须带时区偏移**；clear = 删掉
  --disabled / --no-disabled   置为禁用 / 启用
  --target-whitelist <a,b>     整份替换该用户的 target 白名单（空串 = 清空）
  --target-blacklist <c,d>     整份替换该用户的 target 黑名单（空串 = 清空）

必须知道的三件事
  1. user add 遇到**已存在**的账号会直接拒绝并提示改用 user set。底层写是「整条替换」，
     让 add 静默成功等于「我以为在新建」变成「我顺手清掉了他的配额与有效期」。
  2. 禁用**不追溯**已建立的连接：一条 CONNECT / SOCKS 隧道会跑到断为止，HTTP keep-alive 的
     下一个请求才会重新认证并被拒。与 expiresAt 同一语义。
  3. AUTH_TYPE=jwt 下 expiresAt 与 disabled **都不生效**（jwt 判定不查账号表）。本工具在改完
     之后会当场提醒一句；那条启动期告警（account-table-inert）要等下次重启才看得见。

改完多久生效
  账号表走 mtime 节流热加载：运行中的代理最迟 1 秒后生效，无需重启。`;

const ACL = `proxy-cli acl —— 访问控制名单

  acl show
  acl add    <clientip|target|upstream> <whitelist|blacklist> <entry>
  acl remove <clientip|target|upstream> <whitelist|blacklist> <entry>

条目语法（与直接编辑 acl.json 逐字相同，写入前会被同一份校验判一次）
  clientIp  只收 IP / CIDR，按 TCP 对端地址判定，不看 XFF
  target    收 IP / CIDR / 域名 / *.通配域名，按请求的 host 字符串匹配，不做 DNS、不支持端口
  upstream  语法同 target，但**只在 PROXY_MODE=client 生效**，动作是「直连、不交上游」

必须知道的三件事
  1. 写是**整份覆盖**，不是「加一条」。本工具自己读整份、改一格、再整份写回；两个 proxy-cli
     同时跑，或一个 CLI 与一次人工编辑同时发生，后落盘的那份不含前一份的改动。
  2. 名单驱动是**开放集合**。内置 json 档可写；自定义驱动若没在 AclSource 上实现 write，
     本工具会明确报错退出，而不是静默成功。
  3. 写之前整份结果会过一次形状校验，所以「写得进去、读不出来」不存在——这正是本工具相对
     人手编辑 acl.json 的全部价值：后者要等到下一个请求周期才发现写坏了。

改完多久生效
  判定期走 mtime 节流：运行中的代理最迟 1 秒后读到，无需重启。`;

const USAGE = `proxy-cli usage —— 配额账本

  usage show            列出当前窗口全部用户的已用字节
  usage show <name>     只看一个用户

窗口口径与代理判定**同一份**（同一个 QUOTA_RESET_HOUR、同一个账号表里的 quota.window），
所以这里看到的数与代理用来判超限的数是同一个口径下的同一个数。

不做写操作（没有 usage reset，这是刻意的）
  判定读的是代理**进程内**的镜像，而镜像吸收回读时合并用 max(本进程值, 账本值)。于是从第二个
  进程删掉账本里的行之后，运行中的代理读到权威值 0、却仍然按 max 取自己的旧值 —— 删除永不生效，
  而命令退出码是 0。那是本仓最恨的一种形状：命令成功、结果没变、零信号。
  要真的清账：停掉代理 → 改账本（或删库）→ 重启（重启后的首次回读就是新起点）。

这个数有多新
  运行中的代理判定读的是它自己的镜像，最多落后 2 × QUOTA_FLUSH_INTERVAL（默认是秒级）。
  故本命令只说「账本此刻记着多少」，绝不说「这个账号现在还能用多少」。

副作用
  对 json 档，查询会把账本文件物化出来（若不存在）——那是数据源自己「目标不存在就物化」的
  纪律，所以「查一下用量」在空部署上会留下一个空账本文件。`;

const CONFIG = `proxy-cli config show —— 此刻正在操作哪三份数据

打的是**解析后的绝对路径**（不是 env 文件里那个相对串）与驱动名，以及配置目录、读了哪些
env 文件、鉴权开关、配额窗口口径与落盘周期。未注册的驱动在这一步就会抛错并列出全部已注册项 ——
那正是「以为接上了数据库、实际读的是 users.json」唯一能提前暴露的地方。

用法
  proxy-cli config show

注意：用量那一行给的是**目录**而不是确切文件名（文件名算法住在两个数据源实现器里，而本命令
不造数据源——造它会让「看一眼配置」这个无副作用的动作变成「可能建出一个账本文件」）。
要确切位置跑 proxy-cli usage show。`;

const TOPICS: Readonly<Record<string, string>> = {
  user: USER,
  acl: ACL,
  usage: USAGE,
  config: CONFIG,
};

/** 打印帮助（`topic` 缺省 = 总览） */
export function printHelp(io: AdminIo, topic?: "user" | "acl" | "usage" | "config"): void {
  io.write(topic === undefined ? GENERAL : (TOPICS[topic] ?? GENERAL));
}
