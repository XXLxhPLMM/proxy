#!/usr/bin/env node
/**
 * Banner 生成脚本
 * 根据输入的标题和信息生成无框渐变风格 ASCII art banner
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

// ── ANSI 色彩 ──────────────────────────────────────────────

const RESET = "\x1b[0m";

/** 24-bit 前景色 */
function fg([r, g, b]) {
  return `\x1b[38;2;${r};${g};${b}m`;
}

/** 两个颜色按 t (0..1) 插值 */
function lerpColor(from, to, t) {
  return [
    Math.round(from[0] + (to[0] - from[0]) * t),
    Math.round(from[1] + (to[1] - from[1]) * t),
    Math.round(from[2] + (to[2] - from[2]) * t),
  ];
}

/** 整行单色着色 */
function colorLine(line, color) {
  return fg(color) + line + RESET;
}

/**
 * 垂直渐变：按行索引在 from→to 间插值，整行同色
 * ASCII art 逐行着色后形成自上而下的色彩过渡
 */
function verticalGradient(lines, from, to) {
  const total = lines.length;
  return lines.map((line, i) => {
    if (!line.trim()) return line;
    const t = total <= 1 ? 0 : i / (total - 1);
    return colorLine(line, lerpColor(from, to, t));
  });
}

/** 水平渐变装饰横条：中间嵌一个 ✦，两侧 ─ */
function ornamentBar(width, from, to) {
  const char = "─";
  const center = Math.floor(width / 2);
  let out = "";
  for (let i = 0; i < width; i++) {
    if (i === center) {
      out += fg(lerpColor(from, to, 0.5)) + "✦";
      continue;
    }
    const t = width <= 1 ? 0 : i / (width - 1);
    out += fg(lerpColor(from, to, t)) + char;
  }
  return out + RESET;
}

// ── 配色 ──────────────────────────────────────────────────

/** 主标题：青 → 紫 (synthwave) */
const TITLE_FROM = [0, 217, 255];
const TITLE_TO = [178, 75, 243];
/** 信息行：蓝灰 */
const INFO_COLOR = [141, 153, 174];
/** 标语（副标题小字）：主渐变 70% 处的紫粉 */
const TAGLINE_COLOR = lerpColor(TITLE_FROM, TITLE_TO, 0.7);

// ── ASCII 转换 ────────────────────────────────────────────

/** 文本转 ASCII art：统一大写，未知字符回退空格 */
function textToAscii(text) {
  const lines = Array.from({ length: LINE_HEIGHT }, () => "");
  for (const char of text.toUpperCase()) {
    const glyph = FONT[char] ?? FONT[" "];
    for (let i = 0; i < LINE_HEIGHT; i++) lines[i] += `${glyph[i]} `;
  }
  const trimmed = lines.map((l) => l.trimEnd());
  while (trimmed.length && !trimmed[trimmed.length - 1]) trimmed.pop();
  return trimmed;
}

// ── 排版核心 ──────────────────────────────────────────────

/**
 * 排版：大字标题 + 装饰横条，标语小字置于信息区上方，无框布局 + 渐变
 * generateBanner / generateTypeScript 只是两种薄输出格式。
 */
function buildLines({ title, subtitle, name, version, url }) {
  const block = textToAscii(title);
  const titleWidth = Math.max(...block.map((l) => l.length));
  // 装饰条与大字右缘对齐（保底 30 防极短标题）
  const barWidth = Math.max(titleWidth, 30);

  const grad = verticalGradient(block, TITLE_FROM, TITLE_TO);

  const lines = ["  " + ornamentBar(barWidth, TITLE_FROM, TITLE_TO), ""];
  lines.push(...grad.map((l) => "  " + l));

  lines.push("", "  " + ornamentBar(barWidth, TITLE_FROM, TITLE_TO));

  if (subtitle) lines.push("  " + colorLine(subtitle.toUpperCase().split("").join(" "), TAGLINE_COLOR));
  const info = [];
  if (name && version) info.push(`◆ ${name}  v${version}`);
  if (url) info.push(`◆ ${url}`);
  for (const text of info) lines.push("  " + colorLine(text, INFO_COLOR));

  return lines;
}

// ── 输出格式 ──────────────────────────────────────────────

/** 预览用纯文本 */
function generateBanner(opts) {
  return ["", ...buildLines(opts), ""].join("\n");
}

/** 落盘用 TypeScript 代码 */
function generateTypeScript(opts) {
  const body = ["", ...buildLines(opts), ""].map((l) => `    ${JSON.stringify(l)},`).join("\n");
  return [
    "/**",
    " * 启动 Banner - 无框渐变风格 ASCII Art (truecolor)",
    " */",
    "",
    'import { logger } from "./logger.js";',
    "",
    "// eslint-disable-next-line no-control-regex",
    'const ANSI_RE = /\\x1b\\[[0-9;]*m/g;',
    "",
    "/**",
    " * 打印启动 Banner (NO_COLOR / 非 TTY 时剥离色码)",
    " */",
    "export function printBanner(): void {",
    "  const lines = [",
    body,
    "  ];",
    '  const raw = lines.join("\\n");',
    '  logger.raw(process.env.NO_COLOR || !process.stdout.isTTY ? raw.replace(ANSI_RE, "") : raw);',
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
