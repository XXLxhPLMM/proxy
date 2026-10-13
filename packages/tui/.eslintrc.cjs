module.exports = {
  root: true,
  env: {
    browser: false,
    es2022: true,
    node: true,
  },
  extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended"],
  parser: "@typescript-eslint/parser",
  parserOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
    ecmaFeatures: { jsx: true },
  },
  plugins: ["@typescript-eslint"],
  rules: {
    "no-console": "error",
    quotes: ["error", "double", { avoidEscape: true }],
    semi: ["error", "always"],
    "comma-dangle": ["error", "always-multiline"],
    "comma-spacing": ["error", { before: false, after: true }],
    "space-infix-ops": ["error", { int32Hint: false }],
    "@typescript-eslint/no-explicit-any": "off",
    "comma-style": "error",
    "space-in-parens": ["error", "never"],
    "no-empty": ["error", { allowEmptyCatch: true }],
  },
  ignorePatterns: ["dist/", "node_modules/"],
  overrides: [
    {
      // ⚠️ 分层地板（机制与理由见 `src/AGENTS.md`）：`db/` `lib/` `config/` `api/` `service/` 一律不认 cordis。
      //    `declare module "cordis"` 只许出现在 `starter/plugins/*` 与 `ink-ui/`（UI 确实要拿 ctx）。
      //    放开了以后这条就是唯一挡着「ctx 一路渗进叶子」的东西 —— 文档不算数，红线才算。
      files: ["src/db/**/*.ts", "src/lib/**/*.ts", "src/config/**/*.ts", "src/api/**/*.ts"],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            paths: [
              {
                name: "cordis",
                message: "这一层不认 cordis：能力从参数进、走窄口或返回值出（见 src/AGENTS.md 的分层表）。",
              },
            ],
          },
        ],
      },
    },
    {
      // ⚠️ 业务服务层**唯一**的红线：不许绑死 DAO。行操作目录在 `ctx.dao`（`starter/plugins/dao`），
      //    库句柄在 `ctx.db`，由调用方**显式**当第一个参数传（普通路径传 `ctx.db`，事务回调里传 `tx`）。
      //    重新 import DAO 等于把这层退回「编译期绑死实现」，换实现只能改代码。
      //    ⚠️ 这一层**不适用**上面那条 cordis 禁令：`import type { Context } from "cordis"` 是它的设计
      //    （服务收 `ctx` 参数），它只是不 import 框架的运行时能力、不自建 Context。
      files: ["src/service/**/*.ts"],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            paths: [
              { name: "@/db/index.js", message: "DAO 走 `ctx.dao.sessions` / `ctx.dao.messages` / …，别 import。" },
              { name: "@/db/dao", message: "同上：DAO 走 `ctx.dao.*`。" },
              { name: "@/db/dao/index.js", message: "同上：DAO 走 `ctx.dao.*`。" },
              { name: "@/db/dao/*", message: "同上：DAO 走 `ctx.dao.*`。" },
            ],
          },
        ],
      },
    },
    {
      files: ["build.mjs"],
      rules: { "no-console": "off" },
    },
    {
      files: ["tests/**/*.ts", "vitest.config.ts"],
      env: { node: true },
      globals: {
        describe: "readonly",
        it: "readonly",
        expect: "readonly",
        vi: "readonly",
        beforeEach: "readonly",
        afterEach: "readonly",
        beforeAll: "readonly",
        afterAll: "readonly",
      },
      rules: { "no-console": "off" },
    },
  ],
};
