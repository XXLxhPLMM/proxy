/**
 * 源码级断言的公共工具（读源文件 → 单趟去注释 → 定位函数体）
 *
 * @description
 * 守护栏的形态是「读源码文本 → 去注释 → 逐行/逐块匹配」，因为要盯的是**文本事实**
 * （某个构造调用出现在哪个函数体里），运行期形状看不见这件事。
 *
 * 口径与 `unit/dialer-protocol-boundary.test.ts` 完全一致（那边保留自己的一份拷贝，
 * 是为了让那条护栏的文本面与行为面锁在同一个文件里、互不影响）：
 * - **只去注释、不去字符串字面量**：字符串里出现被禁词汇往往正是要盯的泄漏形态；
 *   而注释里出现它通常是在**描述这条不变量本身**（文件头不得不点名自己禁止什么），
 *   把注释纳入断言就成了自我否定、只能靠删文档来过。
 * - 单趟状态机，注释逐字符换空格、换行原样保留（行号不漂移，失败时给出的行仍对得上原文）。
 */
import fs from "node:fs";
import path from "node:path";

/**
 * 去掉注释、只留「代码 + 字符串字面量」（换行保留 → 行号不漂移）
 *
 * @description
 * 已知边界：本仓 `src/core/{forward,server}/**` 的源码里没有含引号的正则字面量；
 * 若将来引入，切分会失准——那时失败输出会直接把原文贴出来，人眼一看就知道。
 */
export function codeOnly(source: string): string {
  const out: string[] = [];
  let i = 0;

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") {
        out.push(" ");
        i++;
      }

      continue;
    }

    if (ch === "/" && next === "*") {
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        out.push(source[i] === "\n" ? "\n" : " ");
        i++;
      }

      out.push("  ");
      i += 2;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      out.push(ch);
      i++;

      while (i < source.length && source[i] !== ch) {
        if (source[i] === "\\") {
          out.push(source[i]);
          out.push(source[i + 1] ?? " ");
          i += 2;
          continue;
        }

        out.push(source[i]);
        i++;
      }

      out.push(ch);
      i++;
      continue;
    }

    out.push(ch);
    i++;
  }

  return out.join("");
}

/** 读 `src/` 下某个源文件的原文（相对仓库根） */
export function sourceOf(...segments: string[]): string {
  return fs.readFileSync(path.join(__dirname, "..", "..", "src", ...segments), "utf8");
}

/** 读 `src/` 下某个源文件并**立即去注释**（断言正文用这个，省得每处都记得先调 `codeOnly`） */
export function codeOf(...segments: string[]): string {
  return codeOnly(sourceOf(...segments));
}

/**
 * 从 `anchor` 之后开始做花括号配对，返回那个代码块的正文（不含首尾花括号）
 *
 * @description
 * 用于「某个函数体 / 某个回调体内有没有某段文本」这类断言：只切出那一段，
 * 才不会因为文件别处合法地出现了同样字样而误判。字符串字面量在配对时被跳过
 * （调用方应传**已去注释**的文本）。
 * @param code - 已去注释的源码文本
 * @param anchor - 定位锚点（形如 `private async handleForward(` / `server.on("request"`）
 * @returns 该代码块正文；锚点不存在时抛错（说明源码结构变了，护栏必须显式更新）
 */
export function blockAfter(code: string, anchor: string): string {
  const at = code.indexOf(anchor);

  if (at < 0) {
    throw new Error(`源码里找不到锚点：${JSON.stringify(anchor)}（结构变了，护栏需显式更新）`);
  }

  const start = code.indexOf("{", at + anchor.length);

  if (start < 0) {
    throw new Error(`锚点 ${JSON.stringify(anchor)} 之后没有代码块`);
  }

  let depth = 0;
  let i = start;

  while (i < code.length) {
    const ch = code[i];

    if (ch === '"' || ch === "'" || ch === "`") {
      i++;
      while (i < code.length && code[i] !== ch) {
        i += code[i] === "\\" ? 2 : 1;
      }

      i++;
      continue;
    }

    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;

      if (depth === 0) {
        return code.slice(start + 1, i);
      }
    }

    i++;
  }

  throw new Error(`锚点 ${JSON.stringify(anchor)} 的代码块没有闭合`);
}

/** 命中的那些行（失败时把行号与原文一起贴出来，省得人去猜是哪一行） */
export function offendingLines(text: string, re: RegExp): string[] {
  return text
    .split("\n")
    .map((line, i) => ({ line, no: i + 1 }))
    .filter(({ line }) => re.test(line))
    .map(({ no, line }) => `${no}: ${line.trim()}`);
}
