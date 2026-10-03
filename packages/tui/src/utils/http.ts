/**
 * @fileoverview 两处 `字符串 → URL` 的变换（端点模板代入 / 基址收窄）
 * @module utils/http
 * @description
 * 拨号之前只有这两个字符串变换，它们是「地址写错」变成一句**看得见的话**的最后一道机会，故各自有牙齿
 * （`packages/tui/tests/endpoints.test.ts` 与 `client.test.ts`）。
 *
 * ⚠️ **本文件零 IO**：不触网、不读时钟、不读环境。真正拨号的那一处在 `./client.js`。
 *
 * @module
 */

import { TuiError } from "./error.js";

/**
 * 把模板里的 `:username` 段代入真实值
 * @description ⚠️ **判「模板里有没有这个段」与替换必须用同一条整段判据**：用 `includes(":username")` 判、逐段
 * 替换，会让 `:usernames` 这种含子串的段名通过校验却原样返回 —— 一条「判据说有、实际没换」的路径。
 *
 * ⚠️ **代入必须编码**（控制面 decode 之后才判字符白名单），而**本端不发明字符白名单**：`encodeURIComponent` 不
 * 转义 `.`，所以 `..` 会原样穿过；闸门在服务端 `requireSafeUsername`。后果要记住：`fetch` 的 URL 解析会把
 * `/api/users/..` 消解成 `/api/`，症状是 404。
 *
 * @param template - 端点表里那条 `path`（含 `:username`，见 `@/api/index.js:ENDPOINTS`）
 * @param username - 账号名
 * @throws {Error} 模板里没有 `:username` **段**（调用方传错了模板，不是运行期数据问题）
 * @example endpointPath("/api/users/:username", "al ice") // => "/api/users/al%20ice"
 */
export function endpointPath(template: string, username: string): string {
  const segments = template.split("/");
  if (!segments.includes(":username")) {
    throw new Error(`端点模板 ${template} 里没有 :username 段`);
  }
  const encoded = encodeURIComponent(username);
  // 逐段替换：只动 `:username` 这个段，不碰别的段里恰好出现的同名字面量
  return segments.map((seg) => (seg === ":username" ? encoded : seg)).join("/");
}

/**
 * 把用户敲的地址收窄成可用的基址
 * @description ⚠️ **只保留 origin**：路径与查询都不该出现在基址里，且尾斜杠 / 尾路径必须拒 —— 拼出
 * `//api/status` 而服务端逐段比对路径，于是「地址填对了却连不上」变成一句毫无线索的 404。⚠️ 带 userinfo
 * （`http://u:p@host`）也拒：`fetch` 对带凭据的 URL 直接抛 `TypeError`，而那句话把**密码**印在栈里。
 *
 * @param raw - 用户输入
 * @throws {TuiError} `invalid` / `LOCAL_REQUEST`：地址形状不合法，**请求从未发出**
 * @example normalizeBaseUrl("http://127.0.0.1:3010/api") // => "http://127.0.0.1:3010"
 */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") {
    throw TuiError.local({ message: "地址为空" });
  }
  // ⚠️ 这一条**必须在解析之前**：`new URL("http:///api").hostname === "api"`（实测）—— WHATWG 解析会把
  // 三个斜杠消解成「一个斜杠 + 主机分隔符」，于是 `http:///api` **合法地**解析成主机 `api`，
  // `url.hostname === ""` 那一支永远走不到，而用户看到的是「静默去连一台叫 `api` 的机器」
  if (/^https?:\/{3,}/i.test(trimmed)) {
    throw TuiError.local({
      message: `地址缺主机名：${trimmed}（协议头后面要直接跟主机，别多打斜杠）`,
    });
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw TuiError.local({ message: `地址不是合法 URL：${trimmed}（要写成 http://主机:端口）` });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw TuiError.local({
      message: `只支持 http / https，收到 ${url.protocol.replace(":", "")}`,
    });
  }
  if (url.username !== "" || url.password !== "") {
    // ⚠️ 错误文案里**不重打** userinfo：那一段就是凭据
    throw TuiError.local({
      message: "地址里不许带 user:pass（控制面用 Bearer token 鉴权，不走 URL 凭据）",
    });
  }
  if (url.hostname === "") {
    throw TuiError.local({ message: `地址缺主机名：${trimmed}` });
  }
  return `${url.protocol}//${url.host}`;
}