#!/usr/bin/env node
/**
 * Banner 生成脚本
 * 根据输入的标题和信息生成 ASCII art banner
 *
 * 用法：
 *   node scripts/gen-banner.mjs --title "SWAIN" --subtitle "PROXY"
 *   node scripts/gen-banner.mjs --title "HELLO" --subtitle "WORLD" --version "1.0.0"
 *   node scripts/gen-banner.mjs --title "SWAIN" --subtitle "PROXY" --output src/utils/banner.ts
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ── 字形数据 ──────────────────────────────────────────────
// 外置于 scripts/fonts/ansi-shadow.json（ANSI Shadow，官方 .flf 解析入库）：
// 加新字体 = 加个 JSON 文件，不改代码。
// 来源: https://github.com/patorjk/figlet.js/blob/master/fonts/ANSI%20Shadow.flf
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadFont() {
  const fontPath = path.join(__dirname, "fonts", "ansi-shadow.json");
  try {
    return JSON.parse(fs.readFileSync(fontPath, "utf8"));
  } catch (err) {
    console.error(`[gen-banner] 无法加载字形文件: ${fontPath} (${err.message})`);
    process.exit(1);
  }
}

const FONT = loadFont();
const LINE_HEIGHT = FONT["A"].length;

// ── ASCII 转换 ────────────────────────────────────────────

/** 文本转 ASCII art：统一大写，未知字符回退空格 */
function textToAscii(text) {
  const lines = Array.from({ length: LINE_HEIGHT }, () => "");
  for (const char of text.toUpperCase()) {
    const glyph = FONT[char] ?? FONT[" "];
    for (let i = 0; i < LINE_HEIGHT; i++) lines[i] += `${glyph[i]} `;
  }
  return lines.map((l) => l.trimEnd());
}

// ── 排版核心 ──────────────────────────────────────────────

/** 单行居中装进边框：先 pad 到最长行，再左右均分剩余宽度 */
function centerLine(line, maxLen, contentWidth) {
  const padded = line.padEnd(maxLen);
  const left = Math.floor((contentWidth - padded.length) / 2);
  return "║" + " ".repeat(left) + padded + " ".repeat(contentWidth - padded.length - left) + "║";
}

/** 信息行：左对齐，超长时顶满不截断 */
function infoLine(info, contentWidth) {
  return "║" + info + " ".repeat(Math.max(0, contentWidth - info.length)) + "║";
}

/**
 * 排版：标题/副标题转 ASCII 并装进边框，返回纯文本行数组。
 * generateBanner / generateTypeScript 只是两种薄输出格式。
 */
function buildLines({ title, subtitle, name, version, url }) {
  const blocks = [textToAscii(title)];
  if (subtitle) blocks.push(textToAscii(subtitle));

  // 边框宽度 = 内容最大宽度 + 左右 padding 4
  const maxLen = Math.max(...blocks.flat().map((l) => l.length));
  const contentWidth = maxLen + 4;
  const hLine = "═".repeat(contentWidth);
  const blank = "║" + " ".repeat(contentWidth) + "║";

  const [first, ...rest] = blocks;
  const lines = [`╔${hLine}╗`, blank];
  for (const line of first) lines.push(centerLine(line, maxLen, contentWidth));
  for (const block of rest) {
    lines.push(blank);
    for (const line of block) lines.push(centerLine(line, maxLen, contentWidth));
  }
  lines.push(blank, `╠${hLine}╣`);

  if (name && version) lines.push(infoLine(`  ${name}  v${version}`, contentWidth));
  if (url) lines.push(infoLine(`  ${url}`, contentWidth));
  lines.push(`╚${hLine}╝`);

  return lines;
}

// ── 输出格式 ──────────────────────────────────────────────

/** 预览用纯文本 */
function generateBanner(opts) {
  return ["", ...buildLines(opts), ""].join("\n");
}

/** 落盘用 TypeScript 代码 */
function generateTypeScript(opts) {
  const body = ["", ...buildLines(opts), ""].map((l) => `    "${l}",`).join("\n");
  return [
    "/**",
    " * 启动 Banner - 方块风格 ASCII Art",
    " */",
    "",
    'import { logger } from "./logger.js";',
    "",
    "/**",
    " * 打印启动 Banner",
    " */",
    "export function printBanner(): void {",
    "  const lines = [",
    body,
    "  ];",
    '  logger.raw(lines.join("\\n"));',
    "}",
  ].join("\n");
}

// ── 命令行解析 ────────────────────────────────────────────

const DEFAULTS = {
  title: "SWAIN",
  subtitle: "PROXY",
  name: "@b-hole/proxy",
  version: "5.0.0",
  url: "https://github.com/b-hole/proxy",
  output: null,
  preview: true,
};

/** 吃值的 flag -> config key；未知参数直接忽略 */
const OPTIONS = {
  "--title": "title", "-t": "title",
  "--subtitle": "subtitle", "-s": "subtitle",
  "--name": "name", "-n": "name",
  "--version": "version", "-v": "version",
  "--url": "url", "-u": "url",
  "--output": "output", "-o": "output",
};

const HELP = `
Banner 生成脚本

用法:
  node scripts/gen-banner.mjs [选项]

选项:
  --title, -t      主标题 (默认: SWAIN)
  --subtitle, -s   副标题 (默认: PROXY)
  --name, -n       包名 (默认: @b-hole/proxy)
  --version, -v    版本号 (默认: 5.0.0)
  --url, -u        链接 (默认: https://github.com/b-hole/proxy)
  --output, -o     输出到 TypeScript 文件
  --no-preview     不预览输出
  --help, -h       显示帮助

示例:
  node scripts/gen-banner.mjs
  node scripts/gen-banner.mjs --title "HELLO" --subtitle "WORLD"
  node scripts/gen-banner.mjs --title "SWAIN" --subtitle "PROXY" --output src/utils/banner.ts
`;

function parseArgs(argv = process.argv.slice(2)) {
  const config = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--no-preview") {
      config.preview = false;
    } else if (arg === "--help" || arg === "-h") {
      console.log(HELP);
      process.exit(0);
    } else if (OPTIONS[arg]) {
      config[OPTIONS[arg]] = argv[++i];
    }
  }
  return config;
}

// ── 主流程 ────────────────────────────────────────────────

function main() {
  const config = parseArgs();

  if (config.preview) {
    console.log("\n=== 预览 ===\n");
    console.log(generateBanner(config));
    console.log("\n=== TypeScript 代码 ===\n");
    console.log(generateTypeScript(config));
  }

  if (config.output) {
    fs.writeFileSync(config.output, generateTypeScript(config), "utf-8");
    console.log(`\n✅ 已生成到: ${config.output}`);
  }
}

main();
