import fs from "fs";
import path from "path";

/**
 * 获取 文件
 * @param p 
 * @returns 
 */
export function getFile(p: string) {
    return fs.readFileSync(path.join(process.cwd(), p));
}
