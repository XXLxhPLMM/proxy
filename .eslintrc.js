module.exports = {
  env: {
    browser: false,
    es2021: true,
    node: true,
  },
  extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended"],
  parser: "@typescript-eslint/parser",
  parserOptions: {
    ecmaVersion: "latest",
    sourceType: "commonjs",
  },
  plugins: ["@typescript-eslint"],
  rules: {
    // 系统内禁止直接 console 打印，统一走 src/utils/log/logger.ts
    "no-console": "error",
    // 引号配置
    quotes: ["error", "double", { avoidEscape: true }], // 使用双引号（含双引号的字符串允许单引号，与 Prettier 一致）

    // 分号配置
    semi: ["error", "always"], //

    // 逗号配置
    "comma-dangle": ["error", "always-multiline"], // 禁止尾随逗号

    // 逗号后的空格配置
    "comma-spacing": ["error", { before: false, after: true }], // 逗号后必须有空格

    // 其他常用格式化规则
    "space-infix-ops": ["error", { int32Hint: false }], // 操作符两侧需要空格
    "@typescript-eslint/no-explicit-any": "off",
    "@typescript-eslint/no-unused-expressions": [
      "error",
      {
        allowTernary: true,
        allowShortCircuit: true,
      },
    ],
    "comma-style": "error",
    "@typescript-eslint/no-require-imports": "off",
    "space-in-parens": ["error", "never"],
    "no-empty": ["error", { allowEmptyCatch: true }],
  },
  overrides: [
    {
      // 日志管理器本身允许使用 console；构建/脚本为工具链，允许
      files: ["src/utils/log/logger.ts", "build.mjs", "scripts/**/*.mjs"],
      rules: { "no-console": "off" },
    },
    {
      // tests/ 是独立 ESM 工具脚本（.mjs，pnpm test:server）：
      // 顶层 sourceType 默认 commonjs 会被 parser 归一成 script，作用域语义会错，显式声明 module
      files: ["tests/**/*.mjs"],
      parserOptions: { sourceType: "module" },
      env: { node: true },
      // 独立进程的终端输出源，直接打 console（无 src/logger 可用）
      rules: { "no-console": "off" },
    },
  ],
};
