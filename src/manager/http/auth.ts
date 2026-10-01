/**
 * @fileoverview 管理面 HTTP 的**唯一**鉴权判据（`Authorization: Bearer <token>`）
 * @module manager/http/auth
 * @description
 * 这个面能读全量配置、增删账号与名单 —— 等价于主机上的 root shell。故鉴权是
 * **一条判据、一个出口**：本模块只答「这一个请求有没有带对凭据」，**不**答「带凭据的人
 * 能不能碰这条资源」（控制面不做授权分级，凭据即全部权限）。
 *
 * ## 三个刻意的形状
 *
 * 1. **空 token ⇒ 永远 401**（`fail-closed`）。`loadConfig` 的 `assertManagerConfig` 已经在
 *    「`MANAGER_ENABLED=true` + 空 token」时让启动中止，故这条在正常部署里**走不到**。
 *    本模块仍然独立地拒掉它，是因为「安全取决于上游那个校验」是一句不可验证的话：配置层哪天
 *    放宽了规则、或者本模块被别的宿主单独用起来（不经过 `loadConfig`），空 token 就成了
 *    「任何能连上的人都是管理员」。**两道闸门各自独立成立**，这是本模块存在的理由。
 * 2. **比的是 SHA-256 摘要，不是原串**。`crypto.timingSafeEqual` 在**长度不等时会抛**
 *    （`ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH`），而「长度不等就提前 return false」虽然不会抛，
 *    却把「token 长度」变成一个可二分的时序信号。摘要恒为 32 字节 ⇒ 永不抛、长度不外泄，
 *    且两个 `createHash` 的耗时与内容无关。
 * 3. **不区分失败原因**（缺头 / scheme 不对 / token 错一律同一个 `false`）。给出「你 scheme
 *    写错了」这类提示等于给攻击者一个 oracle；真正的用法（`Authorization: Bearer <token>`）
 *    写在文档里，不在错误响应里。
 *
 * ## 零 console、零 process
 * 输出走注入的 logger（调用方 `server.ts` 负责记日志）；本模块只返回一个布尔。
 *
 * @module
 */

import { createHash, timingSafeEqual } from "node:crypto";

/**
 * `Authorization` 头的形态：`Bearer` + 至少一个空白 + **不含空白**的 token。
 * @description scheme 大小写不敏感（RFC 7235 §2.1：认证方案名不区分大小写）；
 * **token 本身逐字节敏感**（JWT / 随机十六进制都含大小写），故只对 scheme 用 `i` 标志，
 * 捕获组不参与任何大小写变换。空 token 被这条正则直接排除（`[^ \t]+` 要求至少一个字符）。
 */
const BEARER_TOKEN = /^bearer[ \t]+([^ \t]+)$/i;

/** SHA-256 摘要（恒 32 字节）——`timingSafeEqual` 的输入形状由它保证 */
function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * 这个请求带对凭据了吗
 * @description
 * 永不抛、永不返回可区分的失败原因。**调用方必须对每一个方法都调它**（含 `OPTIONS` /
 * `HEAD` / 未知方法）——判据放在路由之前，于是「未鉴权的调用者」连「这个路径存不存在、
 * 这个方法允不允许」都拿不到。
 *
 * @param authorization - `IncomingMessage.headers.authorization`（缺头即 `undefined`）
 * @param expectedToken - 配置里的 `managerToken`；**空串一律判否**
 * @returns true = 凭据逐字节相等
 * @example authorize("Bearer s3cr3t", "s3cr3t") // => true
 * @example authorize("Bearer s3cr3", "much-longer-token") // => false（长度不等也不抛）
 * @example authorize(undefined, "") // => false（空 token = 没有任何凭据可比）
 */
export function authorize(authorization: string | undefined, expectedToken: string): boolean {
  if (expectedToken.length === 0) {
    return false;
  }
  if (authorization === undefined) {
    return false;
  }
  const matched = BEARER_TOKEN.exec(authorization);
  if (matched === null) {
    return false;
  }
  return timingSafeEqual(digest(matched[1]), digest(expectedToken));
}
