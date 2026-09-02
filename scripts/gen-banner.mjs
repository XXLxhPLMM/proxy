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

// ANSI Shadow 字体字符映射（标准块状字体）
// 来源: https://github.com/patorjk/figlet.js/blob/master/fonts/ANSI%20Shadow.flf
const FONT = {
  "@": [
    " ██████╗ ",
    "██╔═══██╗",
    "██║██╗██║",
    "██║██║██║",
    "╚█║████╔╝",
    " ╚╝╚═══╝ ",
    "         ",
  ],
  "A": [
    " █████╗ ",
    "██╔══██╗",
    "███████║",
    "██╔══██║",
    "██║  ██║",
    "╚═╝  ╚═╝",
    "        ",
  ],
  "B": [
    "██████╗ ",
    "██╔══██╗",
    "██████╔╝",
    "██╔══██╗",
    "██████╔╝",
    "╚═════╝ ",
    "        ",
  ],
  "C": [
    " ██████╗",
    "██╔════╝",
    "██║     ",
    "██║     ",
    "╚██████╗",
    " ╚═════╝",
    "        ",
  ],
  "D": [
    "██████╗ ",
    "██╔══██╗",
    "██║  ██║",
    "██║  ██║",
    "██████╔╝",
    "╚═════╝ ",
    "        ",
  ],
  "E": [
    "███████╗",
    "██╔════╝",
    "█████╗  ",
    "██╔══╝  ",
    "███████╗",
    "╚══════╝",
    "        ",
  ],
  "F": [
    "███████╗",
    "██╔════╝",
    "█████╗  ",
    "██╔══╝  ",
    "██║     ",
    "╚═╝     ",
    "        ",
  ],
  "G": [
    " ██████╗ ",
    "██╔════╝ ",
    "██║  ███╗",
    "██║   ██║",
    "╚██████╔╝",
    " ╚═════╝ ",
    "         ",
  ],
  "H": [
    "██╗  ██╗",
    "██║  ██║",
    "███████║",
    "██╔══██║",
    "██║  ██║",
    "╚═╝  ╚═╝",
    "        ",
  ],
  "I": [
    "██╗",
    "██║",
    "██║",
    "██║",
    "██║",
    "╚═╝",
    "   ",
  ],
  "J": [
    "     ██╗",
    "     ██║",
    "     ██║",
    "██   ██║",
    "╚█████╔╝",
    " ╚════╝ ",
    "        ",
  ],
  "K": [
    "██╗  ██╗",
    "██║ ██╔╝",
    "█████╔╝ ",
    "██╔═██╗ ",
    "██║  ██╗",
    "╚═╝  ╚═╝",
    "        ",
  ],
  "L": [
    "██╗     ",
    "██║     ",
    "██║     ",
    "██║     ",
    "███████╗",
    "╚══════╝",
    "        ",
  ],
  "M": [
    "███╗   ███╗",
    "████╗ ████║",
    "██╔████╔██║",
    "██║╚██╔╝██║",
    "██║ ╚═╝ ██║",
    "╚═╝     ╚═╝",
    "           ",
  ],
  "N": [
    "███╗   ██╗",
    "████╗  ██║",
    "██╔██╗ ██║",
    "██║╚██╗██║",
    "██║ ╚████║",
    "╚═╝  ╚═══╝",
    "          ",
  ],
  "O": [
    " ██████╗ ",
    "██╔═══██╗",
    "██║   ██║",
    "██║   ██║",
    "╚██████╔╝",
    " ╚═════╝ ",
    "         ",
  ],
  "P": [
    "██████╗ ",
    "██╔══██╗",
    "██████╔╝",
    "██╔═══╝ ",
    "██║     ",
    "╚═╝     ",
    "        ",
  ],
  "Q": [
    " ██████╗ ",
    "██╔═══██╗",
    "██║   ██║",
    "██║▄▄ ██║",
    "╚██████╔╝",
    " ╚══▀▀═╝ ",
    "         ",
  ],
  "R": [
    "██████╗ ",
    "██╔══██╗",
    "██████╔╝",
    "██╔══██╗",
    "██║  ██║",
    "╚═╝  ╚═╝",
    "        ",
  ],
  "S": [
    "███████╗",
    "██╔════╝",
    "███████╗",
    "╚════██║",
    "███████║",
    "╚══════╝",
    "        ",
  ],
  "T": [
    "████████╗",
    "╚══██╔══╝",
    "   ██║   ",
    "   ██║   ",
    "   ██║   ",
    "   ╚═╝   ",
    "         ",
  ],
  "U": [
    "██╗   ██╗",
    "██║   ██║",
    "██║   ██║",
    "██║   ██║",
    "╚██████╔╝",
    " ╚═════╝ ",
    "         ",
  ],
  "V": [
    "██╗   ██╗",
    "██║   ██║",
    "██║   ██║",
    "╚██╗ ██╔╝",
    " ╚████╔╝ ",
    "  ╚═══╝  ",
    "         ",
  ],
  "W": [
    "██╗    ██╗",
    "██║    ██║",
    "██║ █╗ ██║",
    "██║███╗██║",
    "╚███╔███╔╝",
    " ╚══╝╚══╝ ",
    "          ",
  ],
  "X": [
    "██╗  ██╗",
    "╚██╗██╔╝",
    " ╚███╔╝ ",
    " ██╔██╗ ",
    "██╔╝ ██╗",
    "╚═╝  ╚═╝",
    "        ",
  ],
  "Y": [
    "██╗   ██╗",
    "╚██╗ ██╔╝",
    " ╚████╔╝ ",
    "  ╚██╔╝  ",
    "   ██║   ",
    "   ╚═╝   ",
    "         ",
  ],
  "Z": [
    "███████╗",
    "╚══███╔╝",
    "  ███╔╝ ",
    " ███╔╝  ",
    "███████╗",
    "╚══════╝",
    "        ",
  ],
};

const LINE_HEIGHT = 7;

/**
 * 将文本转换为 ASCII art
 */
function textToAscii(text) {
  const upper = text.toUpperCase();
  const lines = Array.from({ length: LINE_HEIGHT }, () => "");

  for (const char of upper) {
    const glyph = FONT[char] || FONT[" "];
    for (let i = 0; i < LINE_HEIGHT; i++) {
      lines[i] += glyph[i] + " ";
    }
  }

  // 去掉每行末尾空格
  return lines.map((l) => l.trimEnd());
}

/**
 * 生成完整的 banner 文本
 */
function generateBanner({ title, subtitle, name, version, url }) {
  const titleAscii = textToAscii(title);
  const subtitleAscii = subtitle ? textToAscii(subtitle) : null;

  // 计算最长行宽度
  const allLines = [...titleAscii, ...(subtitleAscii || [])];
  const maxLen = Math.max(...allLines.map((l) => l.length));

  // 边框宽度 = 内容最大宽度 + 左右 padding 4
  const contentWidth = maxLen + 4;

  // 生成水平线
  const hLine = "═".repeat(contentWidth);

  const result = [];
  result.push("");
  result.push(`╔${hLine}╗`);
  result.push("║" + " ".repeat(contentWidth) + "║");

  // 标题居中 - 每行填充到相同长度
  for (const line of titleAscii) {
    const padded = line.padEnd(maxLen); // 填充到最大长度
    const pad = contentWidth - padded.length;
    const left = Math.floor(pad / 2);
    const right = pad - left;
    result.push("║" + " ".repeat(left) + padded + " ".repeat(right) + "║");
  }

  if (subtitleAscii) {
    result.push("║" + " ".repeat(contentWidth) + "║");
    for (const line of subtitleAscii) {
      const padded = line.padEnd(maxLen); // 填充到最大长度
      const pad = contentWidth - padded.length;
      const left = Math.floor(pad / 2);
      const right = pad - left;
      result.push("║" + " ".repeat(left) + padded + " ".repeat(right) + "║");
    }
  }

  result.push("║" + " ".repeat(contentWidth) + "║");
  result.push("╠" + hLine + "╣");

  // 信息行
  if (name && version) {
    const info = `  ${name}  v${version}`;
    const pad = contentWidth - info.length;
    result.push("║" + info + " ".repeat(Math.max(0, pad)) + "║");
  }
  if (url) {
    const info = `  ${url}`;
    const pad = contentWidth - info.length;
    result.push("║" + info + " ".repeat(Math.max(0, pad)) + "║");
  }

  result.push("╚" + hLine + "╝");
  result.push("");

  return result.join("\n");
}

/**
 * 生成 TypeScript 代码
 */
function generateTypeScript({ title, subtitle, name, version, url }) {
  const titleAscii = textToAscii(title);
  const subtitleAscii = subtitle ? textToAscii(subtitle) : null;

  const allLines = [...titleAscii, ...(subtitleAscii || [])];
  const maxLen = Math.max(...allLines.map((l) => l.length));
  const contentWidth = maxLen + 4;
  const hLine = "═".repeat(contentWidth);

  const tsLines = [];
  tsLines.push('/**');
  tsLines.push(' * 启动 Banner - 方块风格 ASCII Art');
  tsLines.push(' */');
  tsLines.push('');
  tsLines.push('import { logger } from "./logger.js";');
  tsLines.push('');
  tsLines.push('/**');
  tsLines.push(' * 打印启动 Banner');
  tsLines.push(' */');
  tsLines.push('export function printBanner(): void {');
  tsLines.push('  const lines = [');

  // 开始行
  tsLines.push('    "",');
  tsLines.push(`    "╔${hLine}╗",`);
  tsLines.push(`    "║${" ".repeat(contentWidth)}║",`);

  // 标题 - 每行填充到相同长度
  for (const line of titleAscii) {
    const padded = line.padEnd(maxLen); // 填充到最大长度
    const pad = contentWidth - padded.length;
    const left = Math.floor(pad / 2);
    const right = pad - left;
    tsLines.push(`    "║${" ".repeat(left)}${padded}${" ".repeat(right)}║",`);
  }

  if (subtitleAscii) {
    tsLines.push(`    "║${" ".repeat(contentWidth)}║",`);
    for (const line of subtitleAscii) {
      const padded = line.padEnd(maxLen); // 填充到最大长度
      const pad = contentWidth - padded.length;
      const left = Math.floor(pad / 2);
      const right = pad - left;
      tsLines.push(`    "║${" ".repeat(left)}${padded}${" ".repeat(right)}║",`);
    }
  }

  tsLines.push(`    "║${" ".repeat(contentWidth)}║",`);
  tsLines.push(`    "╠${hLine}╣",`);

  // 信息行 - 使用静态值
  if (name && version) {
    const info = `  ${name}  v${version}`;
    const pad = contentWidth - info.length;
    tsLines.push(`    "║${info}${" ".repeat(Math.max(0, pad))}║",`);
  }
  if (url) {
    const info = `  ${url}`;
    const pad = contentWidth - info.length;
    tsLines.push(`    "║${info}${" ".repeat(Math.max(0, pad))}║",`);
  }

  tsLines.push(`    "╚${hLine}╝",`);
  tsLines.push('    "",');
  tsLines.push('  ];');
  tsLines.push('  logger.raw(lines.join("\\n"));');
  tsLines.push('}');

  return tsLines.join('\n');
}

// 解析命令行参数
function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    title: "SWAIN",
    subtitle: "PROXY",
    name: "@b-hole/proxy",
    version: "5.0.0",
    url: "https://github.com/b-hole/proxy",
    output: null,
    preview: true,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--title":
      case "-t":
        config.title = args[++i];
        break;
      case "--subtitle":
      case "-s":
        config.subtitle = args[++i];
        break;
      case "--name":
      case "-n":
        config.name = args[++i];
        break;
      case "--version":
      case "-v":
        config.version = args[++i];
        break;
      case "--url":
      case "-u":
        config.url = args[++i];
        break;
      case "--output":
      case "-o":
        config.output = args[++i];
        break;
      case "--no-preview":
        config.preview = false;
        break;
      case "--help":
      case "-h":
        console.log(`
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
`);
        process.exit(0);
    }
  }

  return config;
}

// 主函数
async function main() {
  const config = parseArgs();

  if (config.preview) {
    console.log("\n=== 预览 ===\n");
    console.log(generateBanner(config));
    console.log("\n=== TypeScript 代码 ===\n");
    console.log(generateTypeScript(config));
  }

  if (config.output) {
    const fs = await import("node:fs");
    const tsCode = generateTypeScript(config);
    fs.writeFileSync(config.output, tsCode, "utf-8");
    console.log(`\n✅ 已生成到: ${config.output}`);
  }
}

main();
