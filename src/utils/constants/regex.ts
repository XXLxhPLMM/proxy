/**
 * @fileoverview 协议常量中心 - 预编译正则（regex.ts）
 *
 * 职责清单：
 * - 报文判定（absolute-form URL、上游状态行、Forwarded for 参数）
 * - 凭据解码前的字符归一与校验（base64url → base64、严格 base64 字符集）
 * - CLI 键归一（去前导横杠、横杠转下划线）与端口数字校验
 * - 显示层 ANSI 转义清理
 *
 * 约束：**全部** 预编译为模块级常量再导出，正则字面量禁止出现在调用点；
 *       任何新增正则先问「是不是该常量化」，避免各写各的。
 */

/**
 * 绝对 URL 判定正则（`/^https?:\/\//i`，大小写不敏感）。
 * server 模式下判断请求行 target 是否为 absolute-form（`http://host/...`）；
 * client 模式不走此分支。注意仅匹配 http/https scheme。
 */
export const RE_ABSOLUTE_URL = /^https?:\/\//i;
/**
 * 上游 HTTP 状态行提取正则（`/HTTP\/\d\.\d\s+(\d+)/`）。
 * 隧道首包仅需状态码，body 交管道透传；捕获组 [1] 为三位码。
 * 用例：`HTTP/1.1 200 Connection Established` => `200`
 */
export const RE_HTTP_STATUS_LINE = /HTTP\/\d\.\d\s+(\d+)/;
/**
 * RFC7239 Forwarded 头 for 参数提取（`/for=([^;,\s]+)/i`，大小写不敏感）。
 * 取 `;` / `,` / 空白为止，去引号后即客户端 IP（含 quoted-string 兼容）。
 * 用例：`for=192.0.2.43, for="[2001:db8::1]"` => `192.0.2.43`
 */
export const RE_FORWARDED_FOR = /for=([^;,\s]+)/i;
/**
 * 双引号全局清理（`/"+/g`），供 Forwarded quoted-string 去引号用。
 */
export const RE_QUOTE_GLOBAL = /"/g;
/**
 * base64url 转 base64：横杠全局替换（`/-/g` => `"+"`），JWT payload 解码前归一用。
 */
export const RE_BASE64URL_DASH = /-/g;
/**
 * base64url 转 base64：下划线全局替换（`/_/g` => `"/"`），JWT payload 解码前归一用。
 */
export const RE_BASE64URL_UNDERSCORE = /_/g;
/**
 * 严格 base64 字符集校验（`/^[A-Za-z0-9+/=]+$/`）。
 * Basic 令牌先验字符集再解码，避免误解明文 `user:pass`。
 */
export const RE_BASE64_STRICT = /^[A-Za-z0-9+/=]+$/;
/**
 * CLI 键归一：去前导横杠（`/^-+/`），`--port` => `port` 用。
 * loader parseRawArgv 三处复用，收敛避免各写各的。
 */
export const RE_LEADING_DASHES = /^-+/;
/**
 * CLI 键归一：横杠转下划线全局替换（`/-/g` => `"_"`），`--proxy-protocol` => `PROXY_PROTOCOL` 用。
 */
export const RE_DASH_GLOBAL = /-/g;
/**
 * 纯数字端口校验（`/^\d+$/`），Host 头端口段合法性判定用。
 * 用例：`example.com:8080` => `8080` 合法
 */
export const RE_DIGITS = /^\d+$/;
/**
 * ANSI 转义序列全局清理（`/\x1b\[[0-9;]*m/g`），banner 非 TTY / NO_COLOR 时剥色用。
 * 显示层唯一正则，收敛至此避免 banner 内联编译。
 */
// eslint-disable-next-line no-control-regex
export const RE_ANSI_ESCAPE = /\x1b\[[0-9;]*m/g;
