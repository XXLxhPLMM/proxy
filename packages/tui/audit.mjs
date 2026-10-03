import fs from "node:fs";
import path from "node:path";

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

const rows = [];
for (const f of walk("src")) {
  const lines = fs.readFileSync(f, "utf8").split(/\r?\n/);
  let inBlock = false, comment = 0, code = 0, firstCode = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (inBlock) { comment++; if (t.includes("*/")) inBlock = false; continue; }
    if (t.startsWith("/*")) {
      comment++;
      // 只有当这一行没有闭合 "*/" 时才进入块注释模式
      if (!t.includes("*/")) inBlock = true;
      continue;
    }
    if (t.startsWith("//")) { comment++; continue; }
    if (t === "") continue;
    code++;
    if (firstCode < 0) firstCode = i;
  }
  const header = firstCode < 0 ? lines.length : firstCode;
  rows.push({ f, total: lines.length, code, comment, header,
    dens: comment / Math.max(1, code + comment),
    hdrRatio: header / Math.max(1, lines.length) });
}
rows.sort((a, b) => (b.hdrRatio - a.hdrRatio) || (b.dens - a.dens));
const p = (s, n) => String(s).padEnd(n);
console.log(p("file", 38), p("total", 6), p("code", 6), p("cmt", 5), p("cmt%", 6), p("头注释行", 9), p("头%", 6));
console.log("-".repeat(78));
for (const r of rows.slice(0, 30))
  console.log(p(r.f, 38), p(r.total, 6), p(r.code, 6), p(r.comment, 5),
    p((r.dens*100).toFixed(0)+"%", 6), p(r.header, 9), p((r.hdrRatio*100).toFixed(0)+"%", 6));
const tc = rows.reduce((a,r)=>a+r.comment,0), tt = rows.reduce((a,r)=>a+r.total,0), th = rows.reduce((a,r)=>a+r.header,0);
console.log("-".repeat(78));
console.log(`合计 ${tt} 行 / 注释 ${tc} (${(tc/tt*100).toFixed(1)}%) / 文件头注释 ${th} (${(th/tt*100).toFixed(1)}%)`);
console.log(`注释>代码的文件 ${rows.filter(r=>r.dens>0.5).length} 个 · 头注释>20% 的文件 ${rows.filter(r=>r.hdrRatio>0.2).length} 个`);
