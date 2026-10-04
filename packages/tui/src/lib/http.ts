/**
 * @fileoverview 拨号之前的两处 `字符串 → URL` 变换（端点模板代入 / 基址收窄）
 * @module utils/http
 * @description 零 IO：这两处是「地址写错」变成一句看得见的话的最后一道机会。
 */

import { TuiError } from "./errors.js";

/**
 * 把模板里的 `:username` 段代入真实值
 * @param template - 端点表里那条 `path`（含 `:username`，见 `@/api/index.js:ENDPOINTS`）
 * @example endpointPath("/api/users/:username", "al ice") // => "/api/users/al%20ice"
 * @throws {Error} 模板里没有 `:username` **段**（调用方传错了模板，不是运行期数据问题）
 */
export function endpointPath(template: string, username: string): string {
  const segments = template.split("/");
  if (!segments.includes(":username")) {
    throw new Error(`端点模板 ${template} 里没有 :username 段`);
  }
  const encoded = encodeURIComponent(username);
  // ⚠️ 判「模板里有没有这个段」与替换必须同一条整段判据：`includes` + 逐段 replace 放 `:usernames`
  return segments.map((seg) => (seg === ":username" ? encoded : seg)).join("/");
}

/**
 * 把用户敲的地址收窄成可用的基址（只保留 origin：路径与尾斜杠不许留在基址里，否则拼出 `//api/status`）
 * @param raw - 用户输入
 * @throws {TuiError} `invalid` / `LOCAL_REQUEST`：地址形状不合法，**请求从未发出**
 * @example normalizeBaseUrl("http://127.0.0.1:3010/api") // => "http://127.0.0.1:3010"
 */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") {
    throw TuiError.local({ message: "地址为空" });
  }
  // ⚠️ 这一条**必须在 `new URL` 之前**：`new URL("http:///api").hostname === "api"`，`hostname === ""` 那支永远走不到
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