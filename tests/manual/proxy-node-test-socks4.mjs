/**
 * 裸 node 自检脚本 - socks4 代理专用（明文 SOCKS 握手 + 隧道里跑 HTTP）
 * 直连本机真服务 127.0.0.1:3000（PROXY_PROTOCOL=socks4, AUTH_TYPE=uid, USER=test），
 * 目标走本地 :4000 压测源站（tests/http-test-server.mjs），不走公网。
 * 用法：先手动 pnpm dev 启动 socks4 服务 + pnpm test:server -- --port 4000 --size 2KB 启动源站，
 *       再 node tests/manual/proxy-node-test-socks4.mjs
 *       http/https 服务请用 proxy-node-test-http.mjs / -https.mjs
 * 日志位置：终端实时 + log/YYYY-MM-DD-HH.log（src/utils/logger.ts:toHourlyFile）
 */
import net from "node:net";

const PROXY_HOST = "127.0.0.1";
const PROXY_PORT = 3000;
const TARGET_HOST = "127.0.0.1";
const TARGET_PORT = 4000;
const USERID = "test";

// SOCKS4 CONNECT 请求：[VN=0x04, CD=0x01, DSTPORT×2 BE, DSTIP×4, USERID, 0x00]
// 应答 8 字节：[VN=0x00, CD=0x5A 放行 / 0x5B 拒绝, DSTPORT×2, DSTIP×4]
function buildRequest(userid) {
  const id = Buffer.from(userid, "utf8");
  const buf = Buffer.alloc(8 + id.length + 1);
  buf[0] = 0x04;
  buf[1] = 0x01;
  buf.writeUInt16BE(TARGET_PORT, 2);
  TARGET_HOST.split(".").forEach((n, i) => (buf[4 + i] = Number(n)));
  id.copy(buf, 8);
  buf[8 + id.length] = 0x00;
  return buf;
}

/** 建连 + 握手，resolve { socket, granted, cd }；reject/close 按拒绝处理 */
function socks4Handshake(userid, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const s = net.createConnection(PROXY_PORT, PROXY_HOST, () => {
      s.write(buildRequest(userid));
    });
    let acc = Buffer.alloc(0);
    const done = (result) => {
      s.removeAllListeners();
      resolve(result);
    };
    const timer = setTimeout(() => {
      s.destroy();
      console.log(`[handshake:${userid}] FAIL - timeout`);
      done({ socket: null, granted: false, cd: null });
    }, timeoutMs);
    s.on("data", (d) => {
      acc = Buffer.concat([acc, d]);
      if (acc.length < 8) return;
      clearTimeout(timer);
      const cd = acc[1];
      done({ socket: s, granted: acc[0] === 0x00 && cd === 0x5a, cd });
    });
    s.on("error", (e) => {
      clearTimeout(timer);
      console.log(`[handshake:${userid}] FAIL - ${e.message}`);
      done({ socket: null, granted: false, cd: null });
    });
    s.on("close", () => {
      clearTimeout(timer);
      done({ socket: null, granted: false, cd: null });
    });
  });
}

function testHandshake() {
  return socks4Handshake(USERID).then(({ socket, granted, cd }) => {
    console.log(`[socks4 handshake] ${granted ? "PASS" : "FAIL"} - CD=0x${cd?.toString(16)}`);
    socket?.destroy();
    return granted;
  });
}

function testHttp(sizeParam, expectLen, timeoutMs = 15000) {
  return new Promise((resolve) => {
    socks4Handshake(USERID).then(({ socket: s, granted }) => {
      if (!granted || !s) {
        console.log(`[http ${sizeParam}] FAIL - handshake not granted`);
        resolve(false);
        return;
      }
      const timer = setTimeout(() => {
        s.destroy();
        console.log(`[http ${sizeParam}] FAIL - timeout`);
        resolve(false);
      }, timeoutMs);
      s.write(
        `GET /?size=${sizeParam} HTTP/1.1\r\nHost: ${TARGET_HOST}:${TARGET_PORT}\r\nConnection: close\r\n\r\n`,
      );
      let raw = Buffer.alloc(0);
      s.on("data", (d) => (raw += d));
      s.on("end", () => {
        clearTimeout(timer);
        const text = raw.toString("utf8");
        const status = text.split("\r\n")[0];
        const bodyLen = Buffer.byteLength(text.split("\r\n\r\n").slice(1).join("\r\n\r\n"));
        const ok = status.includes("200 OK") && bodyLen === expectLen;
        console.log(`[http ${sizeParam}] ${ok ? "PASS" : "FAIL"} - ${status} body=${bodyLen}/${expectLen}B`);
        resolve(ok);
      });
      s.on("error", (e) => {
        clearTimeout(timer);
        console.log(`[http ${sizeParam}] FAIL - ${e.message}`);
        resolve(false);
      });
    });
  });
}

function testAuthDeny() {
  return socks4Handshake("wronguser").then(({ socket, granted, cd }) => {
    // 失败回 [0x00, 0x5B] 并销毁（src/core/server/socks4.ts:106）
    const denied = !granted && (cd === 0x5b || cd === null);
    console.log(`[auth deny] ${denied ? "PASS" : "FAIL"} - CD=${cd === null ? "closed" : "0x" + cd.toString(16)}`);
    socket?.destroy();
    return denied;
  });
}

async function main() {
  console.log(`=== socks4 ${PROXY_HOST}:${PROXY_PORT} userid=${USERID} -> ${TARGET_HOST}:${TARGET_PORT} ===`);
  console.log(`提示：此脚本仅适用于 PROXY_PROTOCOL=socks4，需源站 :4000 在线`);
  const a = await testHandshake();
  await new Promise((r) => setTimeout(r, 500));
  const b = await testHttp("200B", 200);
  await new Promise((r) => setTimeout(r, 500));
  const c = await testHttp("400KB", 409600);
  await new Promise((r) => setTimeout(r, 500));
  const d = await testAuthDeny();
  console.log("\n=== SUMMARY ===");
  console.log(`handshake: ${a ? "PASS" : "FAIL"}`);
  console.log(`http 200B: ${b ? "PASS" : "FAIL"}`);
  console.log(`http 400KB:${c ? "PASS" : "FAIL"}`);
  console.log(`auth deny: ${d ? "PASS" : "FAIL"}`);
  console.log(`overall: ${a && b && c && d ? "ALL PASS" : "SOME FAIL"}`);
  process.exit(a && b && c && d ? 0 : 1);
}
main();
