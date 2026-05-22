# AGENT.md - 代理项目智能体指南

## 项目概述

这是一个功能完整的代理服务器项目，支持多种运行模式，提供 HTTP、HTTPS、TCP 代理服务，并包含认证、路由管理等功能。

## 项目特性

### 🚀 核心功能
- **多模式运行**: 支持 manager、server、client、intermediary 四种运行模式
- **代理类型**: 支持 HTTP/HTTPS 代理、TCP 代理、TLS 代理
- **认证系统**: 基于 JWT 的用户认证机制
- **IP 过滤**: 可选的 IP 地址过滤功能
- **证书管理**: 自动生成和管理 SSL/TLS 证书
- **缓存机制**: 支持请求缓存提升性能

### 🔧 技术栈
- **运行时**: Node.js 14+
- **语言**: TypeScript
- **框架**: Koa.js
- **代理**: http-proxy-agent, https-proxy-agent
- **网络**: Socket.io, socks
- **缓存**: Redis (ioredis)
- **构建**: Webpack
- **打包**: pkg (可执行文件)

## 运行模式

### 1. Manager 模式 (管理器)
```bash
pnpm start APP_MODE=manager
```
- **功能**: 代理服务管理器
- **职责**: 管理代理服务实例、用户认证、路由配置
- **端口**: 默认 3000

### 2. Server 模式 (代理服务器)
```bash
pnpm start APP_MODE=server
```
- **功能**: 提供 HTTP/HTTPS/TCP 代理服务
- **职责**: 处理客户端代理请求、转发数据、SSL/TLS 终止
- **端口**: 默认 8080

### 3. Client 模式 (客户端)
```bash
pnpm start APP_MODE=client
```
- **功能**: 客户端代理
- **职责**: 连接到管理器，获取代理配置，发起代理请求
- **用途**: 用于构建客户端代理工具

### 4. Intermediary 模式 (中继器)
```bash
pnpm start APP_MODE=intermediary
```
- **功能**: 中继服务
- **职责**: 作为代理服务器和客户端之间的中间层
- **用途**: 支持复杂的网络拓扑结构

## 项目结构

```
src/
├── app.ts                 # 应用入口
├── config/
│   └── load.ts           # 配置加载
├── manager/              # 管理器模块
│   ├── auth/             # 认证管理
│   ├── router/           # 路由管理
│   ├── starter/          # 启动器
│   ├── utils/            # 工具函数
│   └── index.ts         # 管理器入口
├── server/               # 服务器模块
│   ├── auth.ts          # 认证服务
│   ├── http-proxy.ts    # HTTP代理
│   ├── index.ts         # 服务器入口
│   ├── net-proxy.ts     # 网络代理
│   └── tsl-proxy.ts     # TLS代理
├── client/              # 客户端模块
│   └── index.ts         # 客户端入口
├── intermediary/        # 中继器模块
│   └── index.ts         # 中继器入口
└── utils/               # 通用工具
    ├── crypt.js         # 加密工具
    ├── file-util.ts     # 文件工具
    ├── ip-util.ts       # IP工具
    ├── log.ts           # 日志工具
    ├── reslover.ts      # 解析器
    └── transform.ts     # 转换工具
```

## 环境配置

### .env 文件配置
```env
# 应用模式
APP_MODE=manager

# 版本信息
version=4.2.0

# IP过滤开关
use_ip_filter=false

# 直接启动标志
DIRECT_STARTING=true

# 密钥配置
KEY=your-secret-key-here
```

### 开发环境配置
```env
# .env.dev
APP_MODE=manager
version=4.2.0
use_ip_filter=false
DIRECT_STARTING=true
```

## 证书管理

项目支持自签名 SSL/TLS 证书，用于 HTTPS 代理：

### 生成证书脚本
```bash
# 生成 CA 私钥并使用 AES-256 加密
openssl genpkey -algorithm RSA -out ca.key -aes256

# 生成 CA 证书签名请求
openssl req -new -key ca.key -out ca.csr

# 生成自签名 CA 证书
openssl req -x509 -days 365 -key ca.key -in ca.csr -out ca.crt

# 生成服务器私钥
openssl genpkey -algorithm RSA -out server.key -aes256

# 生成服务器 CSR
openssl req -new -key server.key -out server.csr

# 使用 CA 签名服务器证书
openssl x509 -req -days 365 -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out server.crt

# 生成客户端私钥
openssl genpkey -algorithm RSA -out client.key -aes256

# 生成客户端 CSR
openssl req -new -key client.key -out client.csr

# 使用 CA 签名客户端证书
openssl x509 -req -days 365 -in client.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out client.crt
```

证书文件存储在 `keys/` 目录下：
- `ca.crt` - CA证书
- `ca.key` - CA私钥
- `ca.srl` - CA序列号
- `server.crt` - 服务器证书
- `server.key` - 服务器私钥
- `client.crt` - 客户端证书
- `client.key` - 客户端私钥

## 开发指南

### 安装依赖
```bash
pnpm install
```

### 开发模式
```bash
# 开发模式（默认 manager）
pnpm dev

# 开发模式 - 客户端
pnpm dev-client

# 开发模式 - 中继器
pnpm dev-IM
```

### 构建
```bash
# 构建项目
pnpm build

# 构建库
pnpm build-lib
```

### 代码检查
```bash
# ESLint 检查并修复
pnpm lint
```

### 打包
```bash
# 打包为可执行文件
pnpm build && pnpm start
```

## API 接口

### 认证接口
- `POST /api/auth/login` - 用户登录
- `POST /api/auth/logout` - 用户登出
- `GET /api/auth/profile` - 获取用户信息

### 代理管理接口
- `GET /api/proxy/list` - 获取代理列表
- `POST /api/proxy/create` - 创建代理配置
- `PUT /api/proxy/:id` - 更新代理配置
- `DELETE /api/proxy/:id` - 删除代理配置

### 路由管理接口
- `GET /api/route/list` - 获取路由规则
- `POST /api/route/create` - 创建路由规则
- `PUT /api/route/:id` - 更新路由规则
- `DELETE /api/route/:id` - 删除路由规则

## 部署指南

### 1. 环境准备
- Node.js 14+
- Redis (可选，用于缓存)
- OpenSSL (用于证书生成)

### 2. 配置文件
- 复制 `.env.example` 到 `.env`
- 根据需要修改配置参数

### 3. 证书生成
按照证书管理章节生成所需的 SSL/TLS 证书

### 4. 启动服务
```bash
# 启动管理器
pnpm start APP_MODE=manager

# 启动代理服务器
pnpm start APP_MODE=server

# 启动客户端
pnpm start APP_MODE=client
```

### 5. 生产环境部署
- 使用 PM2 或 systemd 管理进程
- 配置反向代理 (Nginx)
- 设置 SSL 证书
- 配置日志轮转

## 故障排除

### 常见问题

1. **端口冲突**
   - 检查端口是否被占用
   - 修改配置文件中的端口设置

2. **证书问题**
   - 确保证书文件存在且格式正确
   - 检查证书过期时间

3. **认证失败**
   - 检查 JWT 密钥配置
   - 验证用户凭据

4. **代理连接失败**
   - 检查网络连接
   - 验证代理服务器状态
   - 查看 IP 过滤规则

### 日志查看
```bash
# 查看应用日志
tail -f logs/app.log

# 查看错误日志
tail -f logs/error.log
```

## 贡献指南

1. Fork 项目
2. 创建特性分支
3. 提交更改
4. 推送到分支
5. 创建 Pull Request

## 许可证

ISC License

## 版本历史

- **v4.2.0** - 当前版本，支持多种运行模式
- **v4.x.x** - 添加认证和路由管理功能
- **v3.x.x** - 基础代理功能实现

## 联系方式

如有问题或建议，请通过以下方式联系：
- 提交 Issue
- 发送邮件
- 参与讨论