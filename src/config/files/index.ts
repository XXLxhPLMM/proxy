/**
 * files 层出口：只做「读数据、校验结构、报告状态迁移」；请求期如何使用这些数据不在这里。
 */

export { createJsonFileEventHandler, logJsonFileEvent } from "./event-log.js";
