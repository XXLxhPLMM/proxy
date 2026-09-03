/**
 * vitest 全局前置隔离
 * 背景：loader.ts 的 proxyMode 别名含 MODE/RUN_MODE，而 vite/vitest
 * 默认会把 process.env.MODE 置为 test/development/production，导致
 * import 时的 initConfig() 副作用把 MODE=test 误判为非法 proxyMode 抛错。
 * 此处仅当 MODE/RUN_MODE 为 vite 保留字时清除，用户显式配的 server/client/true/1 不动。
 */
const VITE_RESERVED = new Set(["test", "testing", "development", "production"]);

for (const key of ["MODE", "RUN_MODE"]) {
  const v = process.env[key];
  if (v !== undefined && VITE_RESERVED.has(v.toLowerCase().trim())) {
    delete process.env[key];
  }
}
