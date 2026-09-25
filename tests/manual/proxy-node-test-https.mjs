/**
 * 裸 node 自检脚本 - https 代理专用（TLS 外层）
 * 直连本机真服务 https://127.0.0.1:3000，日志直接走控制台 + log/ 文件
 * 用法：先手动 pnpm dev 启动 https 服务（.env.development 已切 PROXY_PROTOCOL=https）
 *       再 node tests/manual/proxy-node-test-https.mjs
 *       http 服务请用 node tests/manual/proxy-node-test-http.mjs
 *       失败时：tail log/*.jsonl / jq 'select(.msg=="[auth] deny")' 查看
 * 原理：外层先 tls.connect 到代理（rejectUnauthorized:false 自签），
 *       内层 https/wss 再经 CONNECT 隧道二次 TLS + 发帧
 * 关联：src/core/server/https.ts: HttpsProxy / src/utils/tls/certs.ts:loadCerts
 */
import net from "node:net";
import tls from "node:tls";

const PROXY_HOST = "127.0.0.1";
const PROXY_PORT = 3000;
const AUTH = "admin:secret";
const AUTH_B64 = Buffer.from(AUTH).toString("base64");

function connectProxy() {
  return tls.connect({ host: PROXY_HOST, port: PROXY_PORT, rejectUnauthorized: false, servername: PROXY_HOST });
}

function testHttp() {
  return new Promise((resolve) => {
    const s = connectProxy();
    s.once("secureConnect", () => {
      s.write(
        `GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\nProxy-Authorization: Basic ${AUTH_B64}\r\nConnection: close\r\n\r\n`,
      );
    });
    let data = "";
    s.on("data", (d) => (data += d.toString()));
    s.on("end", () => {
      const ok = data.includes("200 OK") && data.includes("Example Domain");
      console.log(`[http via https-proxy] ${ok ? "PASS" : "FAIL"} - ${data.split("\r\n")[0]}`);
      resolve(ok);
    });
    s.on("error", (e) => {
      console.log(`[http] FAIL - ${e.message}`);
      resolve(false);
    });
    setTimeout(() => {
      s.destroy();
      console.log("[http] FAIL - timeout");
      resolve(false);
    }, 8000);
  });
}

function testHttps() {
  return new Promise((resolve) => {
    const s = connectProxy();
    s.once("secureConnect", () => {
      s.write(
        `CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\nProxy-Authorization: Basic ${AUTH_B64}\r\nProxy-Connection: Keep-Alive\r\n\r\n`,
      );
    });
    s.once("data", (d) => {
      const r = d.toString();
      const line = r.split("\r\n")[0];
      console.log(`[https CONNECT via https-proxy] ${line}`);
      if (!r.includes("200 Connection Established")) {
        console.log("[https] FAIL - CONNECT not 200");
        s.destroy();
        resolve(false);
        return;
      }
      const tlss = tls.connect(
        { socket: s, servername: "example.com", rejectUnauthorized: false },
        () => {
          tlss.write(`GET / HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n`);
        },
      );
      let data = "";
      tlss.on("data", (d2) => (data += d2.toString()));
      tlss.on("end", () => {
        const ok = data.includes("200 OK") && data.includes("Example Domain");
        console.log(`[https] ${ok ? "PASS" : "FAIL"} - ${data.split("\r\n")[0]}`);
        resolve(ok);
      });
      tlss.on("error", (e) => {
        console.log(`[https] FAIL - tls ${e.message}`);
        resolve(false);
      });
      setTimeout(() => {
        tlss.destroy();
        s.destroy();
        console.log("[https] FAIL - timeout");
        resolve(false);
      }, 8000);
    });
    s.on("error", (e) => {
      console.log(`[https] FAIL - ${e.message}`);
      resolve(false);
    });
    setTimeout(() => {
      s.destroy();
      console.log("[https] FAIL - timeout CONNECT");
      resolve(false);
    }, 5000);
  });
}

function testWs() {
  return new Promise((resolve) => {
    const target = "ws.postman-echo.com";
    const tport = 443;
    const s = connectProxy();
    s.once("secureConnect", () => {
      s.write(
        `CONNECT ${target}:${tport} HTTP/1.1\r\nHost: ${target}:${tport}\r\nProxy-Authorization: Basic ${AUTH_B64}\r\nProxy-Connection: Keep-Alive\r\n\r\n`,
      );
    });
    s.once("data", (d) => {
      const r = d.toString();
      console.log(`[wss CONNECT via https-proxy] ${r.split("\r\n")[0]}`);
      if (!r.includes("200 Connection Established")) {
        console.log("[wss] FAIL - CONNECT not 200");
        s.destroy();
        resolve(false);
        return;
      }
      const tlss = tls.connect({ socket: s, servername: target, rejectUnauthorized: false }, () => {
        const key = "dGhlIHNhbXBsZSBub25jZQ==";
        tlss.write(
          `GET /raw HTTP/1.1\r\nHost: ${target}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
        );
      });
      tlss.once("data", (d2) => {
        const h = d2.toString();
        console.log(`[ws handshake] ${h.split("\r\n")[0]}`);
        if (!h.includes("101 Switching Protocols")) {
          console.log("[ws] FAIL - not 101");
          tlss.destroy();
          resolve(false);
          return;
        }
        const payload = Buffer.from("hello-node");
        const frame = Buffer.alloc(2 + 4 + payload.length);
        frame[0] = 0x81;
        frame[1] = 0x80 | payload.length;
        const mask = Buffer.from([1, 2, 3, 4]);
        mask.copy(frame, 2);
        for (let i = 0; i < payload.length; i++) frame[6 + i] = payload[i] ^ mask[i % 4];
        tlss.write(frame);
        tlss.on("data", (d3) => {
          const hex = d3.toString("hex");
          console.log(`[ws frame hex] ${hex.slice(0, 80)}`);
          const ok = d3.includes("hello-node") || hex.includes(Buffer.from("hello-node").toString("hex"));
          console.log(`[ws] ${ok ? "PASS" : "FAIL"} - echo ${ok ? "matched" : "mismatch"}`);
          setTimeout(() => {
            tlss.destroy();
            s.destroy();
            resolve(ok);
          }, 300);
        });
      });
      tlss.on("error", (e) => {
        console.log(`[ws] FAIL - tls ${e.message}`);
        resolve(false);
      });
      setTimeout(() => {
        tlss.destroy();
        s.destroy();
        console.log("[ws] FAIL - timeout handshake");
        resolve(false);
      }, 8000);
    });
    s.on("error", (e) => {
      console.log(`[ws] FAIL - ${e.message}`);
      resolve(false);
    });
  });
}

async function main() {
  console.log(`=== proxy https://${PROXY_HOST}:${PROXY_PORT} auth=${AUTH} (TLS外层) ===`);
  console.log(`提示：此脚本仅适用于 PROXY_PROTOCOL=https`);
  console.log(`      http 服务请用 node tests/manual/proxy-node-test.mjs`);
  const a = await testHttp();
  await new Promise((r) => setTimeout(r, 500));
  const b = await testHttps();
  await new Promise((r) => setTimeout(r, 500));
  const c = await testWs();
  console.log("\n=== SUMMARY ===");
  console.log(`http via https-proxy:  ${a ? "PASS" : "FAIL"}`);
  console.log(`https via https-proxy: ${b ? "PASS" : "FAIL"}`);
  console.log(`wss via https-proxy:   ${c ? "PASS" : "FAIL"}`);
  console.log(`overall: ${a && b && c ? "ALL PASS" : "SOME FAIL"}`);
  console.log(`\n日志： tail -n 50 log/2026-09-08-*.log`);
  process.exit(a && b && c ? 0 : 1);
}
main();
