FROM node:18-alpine AS builder

WORKDIR /app

COPY package.json pnpm-lock.yaml* ./
RUN npm install -g pnpm && pnpm install

COPY . .
RUN pnpm build

FROM node:20-alpine

WORKDIR /app

COPY --from=builder /app/dist ./dist
COPY .env ./
COPY keys ./keys

ENV NODE_ENV=production

EXPOSE 3000 8080

CMD ["node", "dist/app.js"]
