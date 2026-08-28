import "./config/loader.js";
import { getAll, get } from "./config/store.js";
import { parseStartupArgs } from "./config/loader.js";

export function run() {
  // 验证环境变量加载是否生效（多方式）
  const argv = process.argv.slice(2);
  const parsed = parseStartupArgs(argv);
  const all = getAll();

  console.log("=== env/config 验证 ===");
  console.log("argv:", argv.length ? argv.join(" ") : "(空)");
  console.log("parseStartupArgs:", parsed);
  console.log("store.getAll():", all);
  console.log('get("port"):', get("port"), '| get("cacheType"):', get("cacheType"));
  console.log("process.env.PORT:", process.env.PORT ?? "(未设置)");
  console.log("process.env.CACHE_TYPE:", process.env.CACHE_TYPE ?? "(未设置)");
  console.log("========================");
}

// 直接执行时打印（便于 node dist/app.js 验证）
if (require.main === module) run();
