/**
 * IP 地址字节语义 - 纯函数，无 IO，无配置依赖
 * 职责：
 * - 归一化单个 IP 文本 → 字节（含 v4-mapped IPv6 `::ffff:a.b.c.d` 还原为 IPv4、剥方括号与 %zone）
 * - 字节 → 文本（`ipv4BytesToString` / `ipv6BytesToString`）
 * 不负责：CIDR 规则的前缀编译与匹配（`cidr.ts`）、主机名归一（`host.ts`）
 * 设计：
 * - 地址一律表示为**字节缓冲**（IPv4 4 字节 / IPv6 16 字节）：前缀匹配本就是按字节+位比较，
 *   用字节比用 128bit 大整数更贴近语义，也免去大整数运算开销（tsconfig target ES6 亦不支持 BigInt 字面量）
 * - 严格解析：任何非法条目返回 undefined，由调用方决定 fail-closed（本项目一律启动期 abort）
 * - v4-mapped 归一化是必需项：Windows/双栈下对端地址常为 `::ffff:127.0.0.1`，
 *   不归一则 IPv4 规则永远匹配不上。**这是全项目唯一一份 v4-mapped 还原实现**，
 *   自环判定（`loop.ts`）、CIDR 规则（`cidr.ts`）与 SOCKS ATYP 族判定都取这里的 `normalizeIp`
 */

import net from "node:net";

/** IP 地址族 */
export type IpFamily = 4 | 6;

/** 归一化后的 IP：族 + 字节缓冲（4 或 16 字节） */
export interface IpValue {
  family: IpFamily;
  bytes: Buffer;
}

/**
 * 解析点分 IPv4 为 4 字节缓冲
 * @param s - 已归一小写的地址串
 * @returns 合法返回 4 字节 Buffer，否则 undefined
 */
function parseIpv4(s: string): Buffer | undefined {
  if (net.isIP(s) !== 4) {
    return undefined;
  }
  const p = s.split(".");
  return Buffer.from([Number(p[0]), Number(p[1]), Number(p[2]), Number(p[3])]);
}

/**
 * 解析 IPv6 文本为 16 字节缓冲（支持 `::` 压缩与内嵌 IPv4 尾）
 * @param input - 已归一小写的地址串
 * @returns 合法返回 16 字节 Buffer，否则 undefined
 * @example parseIpv6("::1") // => <00..01>
 * @example parseIpv6("::ffff:1.2.3.4") // => <00..ff ff 01 02 03 04>
 */
function parseIpv6(input: string): Buffer | undefined {
  if (!input.includes(":")) {
    return undefined;
  }

  let s = input;

  // 内嵌 IPv4 尾（如 `::ffff:1.2.3.4`）：替换为等值两段十六进制后再统一按组解析
  const lastColon = s.lastIndexOf(":");
  const tail = s.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = parseIpv4(tail);
    if (!v4) {
      return undefined;
    }
    const hi = v4.readUInt16BE(0).toString(16);
    const lo = v4.readUInt16BE(2).toString(16);
    s = `${s.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const halves = s.split("::");
  if (halves.length > 2) {
    return undefined;
  }

  const head = halves[0] ? halves[0].split(":") : [];
  const back = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = 8 - head.length - back.length;

  if (halves.length === 1) {
    if (head.length !== 8) {
      return undefined;
    }
  } else if (fill < 1) {
    // `::` 至少代表一组 0（RFC 4291 §2.2）
    return undefined;
  }

  const groups = [...head, ...Array<string>(Math.max(fill, 0)).fill("0"), ...back];
  if (groups.length !== 8) {
    return undefined;
  }

  const buf = Buffer.alloc(16);
  for (let i = 0; i < 8; i++) {
    const g = groups[i];
    if (!/^[0-9a-f]{1,4}$/.test(g)) {
      return undefined;
    }
    buf.writeUInt16BE(parseInt(g, 16), i * 2);
  }
  return buf;
}

/**
 * 归一化任意 IP 文本
 * @description 剥方括号与 %zone、统一小写；`::ffff:a.b.c.d`（含十六进制形态 `::ffff:7f00:1`）
 * 一律还原为 IPv4，保证双栈环境下 IPv4 规则可命中
 * @param addr - 原始地址（可含方括号与 %zone）
 * @returns 归一化结果，非法返回 undefined
 * @example normalizeIp("::ffff:127.0.0.1") // => { family: 4, bytes: <7f 00 00 01> }
 */
export function normalizeIp(addr: string): IpValue | undefined {
  if (typeof addr !== "string") {
    return undefined;
  }

  let h = addr.trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) {
    h = h.slice(1, -1);
  }
  const zone = h.indexOf("%");
  if (zone !== -1) {
    h = h.slice(0, zone);
  }

  const v4 = parseIpv4(h);
  if (v4) {
    return { family: 4, bytes: v4 };
  }

  const v6 = parseIpv6(h);
  if (!v6) {
    return undefined;
  }

  // v4-mapped ::ffff:0:0/96：还原为 IPv4，否则 IPv4 规则在双栈下永不命中
  if (isV4Mapped(v6)) {
    return { family: 4, bytes: v6.subarray(12) };
  }

  return { family: 6, bytes: v6 };
}

/**
 * 判断 16 字节地址是否落在 `::ffff:0:0/96`
 * @param b - 16 字节地址
 * @returns 是否 v4-mapped
 */
function isV4Mapped(b: Buffer): boolean {
  for (let i = 0; i < 10; i++) {
    if (b[i] !== 0) {
      return false;
    }
  }
  return b[10] === 0xff && b[11] === 0xff;
}

/**
 * 4 字节 IPv4 地址转点分文本
 * @param b - 4 字节地址（长度不符时按实际字节补 0，绝不抛错）
 * @returns 点分十进制文本
 * @example ipv4BytesToString(Buffer.from([127, 0, 0, 1])) // => "127.0.0.1"
 */
export function ipv4BytesToString(b: Buffer): string {
  const at = (i: number): number => (i < b.length ? b[i] : 0);
  return `${at(0)}.${at(1)}.${at(2)}.${at(3)}`;
}

/**
 * 16 字节 IPv6 地址转文本（RFC 5952 风格：小写、无前导零、最长零段压缩）
 * @description SOCKS5 ATYP=0x04 收到的 16 字节需转文本才能进 `net.connect` 与名单判定；
 * 最长零段（>=2 组）压缩为 `::`，并列取首段，全零即 `::`
 * @param b - 16 字节地址（不足 16 按实际组数格式化，不抛错）
 * @returns 裸 IPv6 文本（不带方括号，供 `net.connect` 直用）
 * @example ipv6BytesToString(Buffer.from([0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1])) // => "::1"
 * @example ipv6BytesToString(Buffer.alloc(16)) // => "::"
 */
export function ipv6BytesToString(b: Buffer): string {
  const groups: number[] = [];
  for (let i = 0; i + 1 < b.length; i += 2) {
    groups.push(b.readUInt16BE(i));
  }

  let bestStart = -1;
  let bestLen = 0;
  let curStart = -1;
  let curLen = 0;
  for (let i = 0; i <= groups.length; i++) {
    if (i < groups.length && groups[i] === 0) {
      if (curStart < 0) {
        curStart = i;
        curLen = 1;
      } else {
        curLen++;
      }
    } else {
      if (curLen > bestLen) {
        bestLen = curLen;
        bestStart = curStart;
      }
      curStart = -1;
      curLen = 0;
    }
  }

  const hex = (n: number): string => n.toString(16);
  if (bestLen >= 2) {
    const head = groups.slice(0, bestStart).map(hex).join(":");
    const tail = groups.slice(bestStart + bestLen).map(hex).join(":");
    if (head === "" && tail === "") {
      return "::";
    }
    if (head === "") {
      return `::${tail}`;
    }
    if (tail === "") {
      return `${head}::`;
    }
    return `${head}::${tail}`;
  }
  return groups.map(hex).join(":");
}

