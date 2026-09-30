FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json pnpm-lock.yaml* ./
RUN npm install -g pnpm && pnpm install

COPY . .
RUN pnpm build

FROM node:22-alpine AS prod-deps

WORKDIR /app

# 只装**运行期**依赖。为什么要单独一个阶段：最终镜像不能直接 COPY builder 的
# node_modules（那里面是 esbuild / typescript / vitest 整套 devDeps），
# 而**又不能不装** —— `node-sqlite3-wasm` 藏在 `createRequire(__filename)("node-sqlite3-wasm")`
# 后面，esbuild 打不进 bundle，它必须在运行时从 node_modules 解析。
COPY package.json pnpm-lock.yaml* ./
RUN npm install -g pnpm && pnpm install --prod --frozen-lockfile

FROM node:22-alpine

WORKDIR /app

COPY --from=builder /app/dist ./dist
# 运行期依赖：**不是**「顺手拷的」，是 Node < 22.5 那条路的唯一前置。
# 缺了它，base image 是 node:22（≥22.5，走内置档）时**一切正常**，
# 直到哪天 base image 换成 node:20 / node:18、或落到 22.0–22.4，
# 才在**第一次真正记账**时抛 MODULE_NOT_FOUND —— 「构建全绿、运行才炸」里最难查的那一种。
COPY --from=prod-deps /app/node_modules ./node_modules
COPY keys ./keys
# 配置模板：store 默认从 <cwd>/cfg/users.json 与 <cwd>/cfg/acl.json 读取
# （只拷 *.example，真实的 users.json / acl.json 含密码，绝不进镜像）
COPY --from=builder /app/cfg/users.json.example /app/cfg/acl.json.example /app/cfg/

# 配置只来自环境变量：loader 读 .env.production / .env.development / .env.<NODE_ENV>，
# 没有也不读裸 .env（仓库里同样没有该文件）。运行时用 --env-file 传入，
# 或把 .env.production 挂载到 /app/.env.production，否则全部走默认值。
ENV NODE_ENV=production

EXPOSE 3000 8080

CMD ["node", "dist/app.js"]
