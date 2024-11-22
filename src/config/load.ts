import { config } from "dotenv";
import { logger } from "@/utils/log";
const EVN_LOG = logger.getLogger("CONFIG_ENV");
export default function loadConfig() {
  // 获取命令行参数
  const args = process.argv.slice(2);
  const modeArg = args.find((arg) => arg.startsWith("mode=")); // 查找以 'mode=' 开头的参数
  // 提取 mode 的值
  const mode = modeArg ? modeArg.split("=")[1] : "dev"; // 默认使用 'dev'
  const appMode = args.find((arg) => arg.startsWith("APP_MODE=")); // 查找以 'appMode=' 开头的参数
  process.env.APP_MODE = appMode ? appMode.split("=")[1] : "server"; // 默认使用 'web'
  EVN_LOG.info(`APP_MODE: ${process.env.APP_MODE}`);
  // 定义加载的 .env 文件
  const envFile = `.env.${mode}`;
  // 加载对应的 .env 文件
  config({ path: [envFile, ".env"] });
}
loadConfig()

export { loadConfig }
