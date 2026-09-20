FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json pnpm-lock.yaml* ./
RUN npm install -g pnpm && pnpm install

COPY . .
RUN pnpm build

FROM node:22-alpine

WORKDIR /app

COPY --from=builder /app/dist ./dist
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
