import { defineConfig } from "drizzle-kit";

/** ⚠️ 只给 `generate` 用（产 SQL 进 git）；运行期怎么应用迁移还没定（见 `src/services/db/sqlite/client.ts` 文件头）
 *  ⚠️ 迁移**按方言分目录**（`drizzle/<方言>/`）：加 MySQL 时另起一份 `drizzle.config.<方言>.ts`，别往这里塞第二种。 */
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/services/db/sqlite/schemas/index.ts",
  out: "./drizzle/sqlite",
});
