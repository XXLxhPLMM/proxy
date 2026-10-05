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
 *   把注释纳入断言就会让文件头无法再解释自己在禁止什么。
 * - 单趟状态机，注释逐字符换空格、换行原样保留（行号不漂移，失败时给出的行仍对得上原文）。
 */
import fs from "node:fs";
import path from "node:path";

/**
 * 仓库根、`tests/`、`src/` 三个绝对路径 —— **层数只许出现在这一处**
 *
 * @description
 * 判据是「每个文件自己往上数几级 `..`」这件事天生不可靠：测试目录会继续往下嵌套，
 * 而层数跟着调用点搬家。少一个 `..` 解析到 `tests/src` 会抛 `ENOENT`（**自己暴露**）；
 * **多一个 `..` 枚举到空集则恒绿** —— 后者危险得多，因为它只会静静地不再判任何东西
 * （`packages/tui/AGENTS.md` 已把这条坑逐字写死）。
 *
 * 所以：任何要走出 `tests/` 的相对路径都从这里派生。文件嵌套变深时只改这一处，
 * 调用点改的只是 import 层数，不再各自数 `..`。
 */
export const REPO_ROOT = path.resolve(__dirname, "..", "..");
export const TESTS_DIR = path.join(REPO_ROOT, "tests");
export const SRC_DIR = path.join(REPO_ROOT, "src");

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
  return fs.readFileSync(path.join(SRC_DIR, ...segments), "utf8");
}

/** 读 `src/` 下某个源文件并**立即去注释**（断言正文用这个，省得每处都记得先调 `codeOnly`） */
export function codeOf(...segments: string[]): string {
  return codeOnly(sourceOf(...segments));
}

/**
 * `src/` 下若干目录里**此刻真实存在**的全部 `*.ts`，返回可直接喂给 {@link codeOf} 的相对路径
 * @description
 * **列目录而不是手写文件名清单**：手写清单的最大问题不是「漏了一个」，而是**将来新增的那个默认
 * 逃出护栏**——它不在清单里，于是「零 console」「不许 import 代理侧」这类断言对它恒绿，而它看起来
 * 正在生效。目录是那个「被防住的行为在今天仍然存在的形状」，新增文件自动进扫描范围。
 *
 * ⚠️ 由此本函数**也会把将来的辅助文件一并纳入**：新增一个文件必须同样满足所在层的每一条不变式。
 * 这正是要的——先证明它合规，再提交它。
 *
 * @param dirs - 相对 `src/` 的目录（可多个，如 `"admin"` / `"ops"`）
 */
export function sourceFiles(...dirs: readonly string[]): string[] {
  return dirs.flatMap((dir) =>
    fs
      .readdirSync(path.join(SRC_DIR, dir))
      .filter((name) => name.endsWith(".ts"))
      .sort()
      .map((name) => `${dir}/${name}`),
  );
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
