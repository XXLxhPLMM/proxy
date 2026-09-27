# CNB 云原生构建使用文档

> 官方文档：https://docs.cnb.cool/zh/build/intro.html

## 1. 概述

CNB 云原生构建是基于 Docker 生态的 CI/CD 平台，通过声明式配置（`.cnb.yml`）定义自动化构建流程。

核心特性：

- **声明式**：YAML 语法，可编程、易分享
- **云原生**：基于 Docker 容器运行，资源池化
- **高性能**：最高 64 核 CPU、读秒克隆、copy-on-write 缓存并发

---

## 2. 配置文件

文件名：`.cnb.yml`，存放于仓库根目录。

### 2.1 基本结构层级

```
触发分支 → 触发事件 → Pipeline（流水线）→ Stage（阶段）→ Job（任务）
```

- 同一事件下的多条 Pipeline **并发执行**
- 同一 Pipeline 内的 Stages **顺序执行**

### 2.2 完整示例

```yaml
main:
  push:
    - name: pipeline-1
      docker:
        image: node:22
        volumes:
          - /root/.npm:copy-on-write
      stages:
        - name: install
          script: pnpm install
        - name: lint
          script: pnpm lint
        - name: build
          script: pnpm build
      failStages:
        - name: notify
          script: echo "Build failed!"
      endStages:
        - name: cleanup
          script: echo "Cleanup done"
```

### 2.3 数组形式 vs 对象形式

```yaml
# 数组形式（推荐）
main:
  push:
    - name: pipeline-1
      stages:
        - name: job1
          script: echo 1
    - name: pipeline-2
      stages:
        - name: job2
          script: echo 2

# 对象形式
main:
  push:
    pipeline-1:
      stages:
        - name: job1
          script: echo 1
    pipeline-2:
      stages:
        - name: job2
          script: echo 2
```

---

## 3. 触发分支

| 模式       | 说明                 | 示例                   |
| ---------- | -------------------- | ---------------------- |
| 精确匹配   | 精确匹配分支名       | `main`、`dev`          |
| 通配符匹配 | glob 语法            | `feature/*`、`"dev/*"` |
| 兜底匹配   | 匹配所有未命中的分支 | `$`                    |

```yaml
main:
  push:
    - stages:
        - echo "main branch"

"feature/*":
  push:
    - stages:
        - echo "feature branch"

$:
  push:
    - stages:
        - echo "other branches"
```

多个 glob 规则同时匹配时，所有匹配规则的流水线**并行执行**。

---

## 4. 触发事件

### 4.1 Git 操作事件

| 事件名          | 触发时机                    |
| --------------- | --------------------------- |
| `push`          | 分支推送时                  |
| `commit.add`    | 分支推送包含新提交时        |
| `branch.create` | 分支创建时（同时触发 push） |
| `branch.delete` | 分支删除时                  |

### 4.2 Pull Request 事件

| 事件名                           | 触发时机                                               |
| -------------------------------- | ------------------------------------------------------ |
| `pull_request`                   | PR 创建、重新打开、源分支 push                         |
| `pull_request.update`            | PR 创建、重新打开、源分支 push、title/description 修改 |
| `pull_request.target`            | PR 创建、重新打开、源分支 push（使用目标分支配置）     |
| `pull_request.mergeable`         | PR 满足合并条件时                                      |
| `pull_request.merged`            | PR 合并完成时                                          |
| `pull_request.approved`          | PR 评审通过时                                          |
| `pull_request.changes_requested` | PR 评审需要改进时                                      |
| `pull_request.comment`           | PR 评论时                                              |

### 4.3 Tag 事件

| 事件名         | 触发时机                           |
| -------------- | ---------------------------------- |
| `tag_push`     | Tag push 时                        |
| `auto_tag`     | 页面点击「自动生成 Tag」按钮时     |
| `tag_deploy.*` | Tag/Release 页面点击「部署」按钮时 |

### 4.4 其他事件

| 事件名                                           | 触发时机           |
| ------------------------------------------------ | ------------------ |
| `web_trigger` / `web_trigger_*`                  | 页面自定义按钮触发 |
| `api_trigger` / `api_trigger_*`                  | API 调用触发       |
| `"crontab: ..."`                                 | 定时任务触发       |
| `issue.open/close/reopen/update/comment`         | Issue 相关操作     |
| `issue.comment@npc` / `pull_request.comment@npc` | @NPC 触发          |

### 4.5 不可信事件

以下事件为不可信事件，`CNB_TOKEN` 权限受限：

- `pull_request`、`pull_request.update`、`pull_request.approved`、`pull_request.changes_requested`、`pull_request.comment`
- `pull_request.comment@npc`、`issue.comment`、`issue.comment@npc`

---

## 5. Pipeline 配置项

### 5.1 配置项概览

| 配置项         | 类型            | 说明                                     |
| -------------- | --------------- | ---------------------------------------- |
| `name`         | String          | 流水线名称                               |
| `runner`       | Object          | 构建节点配置（tags、cpus）               |
| `docker`       | Object          | Docker 环境配置（image、build、volumes） |
| `git`          | Object          | Git 仓库配置（enable、submodules、lfs）  |
| `services`     | Array           | 构建服务（docker、vscode）               |
| `env`          | Object          | 环境变量                                 |
| `imports`      | Array\<String\> | 从文件导入环境变量                       |
| `stages`       | Array           | 阶段任务列表（顺序执行）                 |
| `failStages`   | Array           | 失败时执行的任务                         |
| `endStages`    | Array           | 结束时执行的任务（无论成败）             |
| `ifNewBranch`  | Boolean         | 仅新分支时执行                           |
| `ifModify`     | Array\<String\> | 文件变更时执行                           |
| `retry`        | Number          | 失败重试次数                             |
| `allowFailure` | Boolean         | 允许失败                                 |
| `lock`         | Object          | 流水线锁配置                             |
| `sandbox`      | Boolean         | 沙箱模式                                 |

### 5.2 runner — 构建节点

```yaml
main:
  push:
    - runner:
        tags: cnb:arch:amd64
        cpus: 8
      stages:
        - name: echo
          script: uname -a
```

可用构建节点：

| 标签                     | 架构     | CPU 范围      | 说明     |
| ------------------------ | -------- | ------------- | -------- |
| `cnb:arch:amd64`         | amd64    | 1~64（默认8） | 标准节点 |
| `cnb:arch:arm64:v8`      | arm64/v8 | 1~16（默认8） | ARM 节点 |
| `cnb:arch:amd64:gpu`     | amd64    | 固定16        | GPU 48GB |
| `cnb:arch:amd64:gpu:H20` | amd64    | 固定32        | GPU 96GB |
| `cnb:arch:amd64:gpu:L40` | amd64    | 固定16        | GPU 48GB |

### 5.3 docker — 构建环境

#### image — 使用现有镜像

```yaml
main:
  push:
    - docker:
        image: node:22
      stages:
        - node -v
```

私有镜像：

```yaml
main:
  push:
    - docker:
        image:
          name: docker.cnb.cool/images/pipeline-env:1.0
      stages:
        - echo "hello"
```

#### build — 动态构建镜像

```yaml
main:
  push:
    - docker:
        build:
          dockerfile: ./Dockerfile
          by:
            - package.json
            - package-lock.json
          versionBy:
            - package-lock.json
          target: builder
      stages:
        - echo "hello"
```

#### volumes — 数据卷缓存

| 类型                      | 简写 | 说明                           | 适用场景         |
| ------------------------- | ---- | ------------------------------ | ---------------- |
| `read-write`              | rw   | 读写，并发写冲突需自行处理     | 串行构建         |
| `read-only`               | ro   | 只读                           | 只读访问         |
| `copy-on-write`           | cow  | 读写，变更在流水线成功后合并   | 并发构建（默认） |
| `copy-on-write-read-only` | -    | 只读，变更在流水线结束后丢弃   | PR 场景          |
| `data`                    | -    | 临时数据卷，流水线结束自动清理 | 共享数据         |

格式：`[group:]<path>[:<type>]`

```yaml
main:
  push:
    - docker:
        image: node:22
        volumes:
          - /root/.npm:copy-on-write
          - node_modules
          - main:/root/.gradle:copy-on-write
      stages:
        - npm install
  pull_request:
    - docker:
        image: node:22
        volumes:
          - /root/.npm:copy-on-write
          - main:/root/.gradle:copy-on-write-read-only
      stages:
        - npm install
```

### 5.4 services — 构建服务

```yaml
main:
  push:
    - services:
        - docker
      docker:
        image: alpine
      stages:
        - name: docker info
          script:
            - docker info
            - docker ps
```

启用 `docker` 服务后会自动 `docker login` 到 CNB Docker 制品库。

### 5.5 env — 环境变量

```yaml
main:
  push:
    - env:
        APP_MODE: manager
        NODE_ENV: production
      stages:
        - echo $APP_MODE
```

### 5.6 imports — 导入密钥文件

```yaml
main:
  push:
    - imports: https://cnb.cool/<your-repo-slug>/-/blob/main/xxx/envs.yml
      stages:
        - echo $SECRET_KEY
```

### 5.7 ifModify — 文件变更时执行

```yaml
main:
  push:
    - ifModify:
        - src/**
        - package.json
      stages:
        - pnpm build
```

---

## 6. Stage 与 Job

### 6.1 脚本任务

```yaml
stages:
  - name: install
    script: pnpm install

  - name: multi-line
    script: |
      echo "line 1"
      echo "line 2"

  - name: multi-script
    script:
      - echo "step 1"
      - echo "step 2"
```

### 6.2 任务级别覆盖镜像

```yaml
stages:
  - name: use-default
    script: node -v

  - name: use-node-20
    image: node:20
    script: node -v
```

### 6.3 插件任务

```yaml
stages:
  - name: hello
    image: cnbcool/hello-world
```

### 6.4 内置任务

```yaml
stages:
  - name: cache
    type: docker:cache
    options:
      dockerfile: cache.dockerfile
      by:
        - package.json
        - package-lock.json
    exports:
      name: DOCKER_CACHE_IMAGE_NAME
```

---

## 7. 内置任务一览

| 任务                        | 类型   | 说明                               |
| --------------------------- | ------ | ---------------------------------- |
| `docker:cache`              | Docker | 构建 Docker 缓存镜像，加速依赖安装 |
| `cnb:await` / `cnb:resolve` | 协作   | 等待/通知机制，多流水线协作        |
| `cnb:apply`                 | 触发   | 触发同仓库下的子流水线             |
| `cnb:trigger`               | 触发   | 触发指定仓库下的子流水线           |
| `cnb:read-file`             | 文件   | 读取文件内容导出为环境变量         |
| `cnb:destroy-token`         | 安全   | 销毁流水线 CNB_TOKEN               |
| `vscode:go`                 | 开发   | 控制远程开发环境可用时机           |
| `git:auto-merge`            | Git    | PR 自动合并                        |
| `git:reviewer`              | Git    | PR 自动添加评审人                  |
| `git:release`               | Git    | 仓库发布 Release                   |
| `git:issue-update`          | Git    | 更新 Issue 状态                    |
| `testing:coverage`          | 测试   | 单测覆盖率上报                     |

---

## 8. 内置环境变量

### 8.1 基础变量

| 变量名                    | 说明                       |
| ------------------------- | -------------------------- |
| `CI`                      | CI 标识，值为 `true`       |
| `CNB`                     | CNB 标识，值为 `true`      |
| `CNB_EVENT`               | 触发构建的事件名称         |
| `CNB_BRANCH`              | 分支名或 Tag 名            |
| `CNB_COMMIT`              | 构建对应的代码 SHA         |
| `CNB_COMMIT_SHORT`        | Commit SHA 前 8 位         |
| `CNB_COMMIT_MESSAGE`      | 提交信息                   |
| `CNB_DEFAULT_BRANCH`      | 仓库默认分支               |
| `CNB_TOKEN`               | 流水线运行期临时令牌       |
| `CNB_TOKEN_USER_NAME`     | 临时令牌用户名，固定 `cnb` |
| `CNB_DOCKER_REGISTRY`     | 制品库 Docker 源地址       |
| `CNB_REPO_SLUG`           | 仓库路径                   |
| `CNB_REPO_SLUG_LOWERCASE` | 仓库路径小写格式           |
| `CNB_REPO_URL_HTTPS`      | 仓库 HTTPS 地址            |

### 8.2 构建类变量

| 变量名                 | 说明                                  |
| ---------------------- | ------------------------------------- |
| `CNB_BUILD_ID`         | 构建流水号                            |
| `CNB_BUILD_WEB_URL`    | 构建日志地址                          |
| `CNB_BUILD_USER`       | 触发者用户名                          |
| `CNB_BUILD_WORKSPACE`  | 工作空间根目录                        |
| `CNB_BUILD_FAILED_MSG` | 构建失败错误信息（failStages 中可用） |
| `CNB_PIPELINE_NAME`    | Pipeline 名称                         |
| `CNB_PIPELINE_STATUS`  | Pipeline 构建状态（endStages 中可用） |
| `CNB_CPUS`             | 可用 CPU 核数                         |
| `CNB_MEMORY`           | 可用内存大小                          |

### 8.3 PR 类变量

| 变量名                      | 说明           |
| --------------------------- | -------------- |
| `CNB_PULL_REQUEST`          | 是否为 PR 触发 |
| `CNB_PULL_REQUEST_PROPOSER` | PR 提出者      |
| `CNB_PULL_REQUEST_TITLE`    | PR 标题        |
| `CNB_PULL_REQUEST_BRANCH`   | PR 源分支名称  |
| `CNB_PULL_REQUEST_IID`      | PR 仓库编号    |

---

## 9. 环境变量操作

### 9.1 声明

```yaml
main:
  push:
    - env:
        MY_VAR: hello
      stages:
        - echo $MY_VAR
```

### 9.2 导出（Job 间传递）

```yaml
stages:
  - name: set env
    script: echo -n $(date "+%Y-%m-%d")
    exports:
      stdout: TODAY
  - name: use env
    script: echo $TODAY
```

### 9.3 脚本输出变量

```yaml
stages:
  - name: set output
    script: echo "##[set-output my_var=some value]"
    exports:
      my_var: MY_VAR
  - name: use output
    script: echo $MY_VAR
```

### 9.4 变量替换

配置文件中 `$VAR_NAME` 会替换为环境变量值：

```yaml
main:
  push:
    - docker:
        image: $MY_IMAGE
      stages:
        - echo $CNB_BRANCH
```

阻止替换：`\$VAR_NAME`

---

## 10. 定时任务

```yaml
main:
  "crontab: 30 5,17 * * *":
    - name: nightly-build
      stages:
        - name: test
          script: echo "Running scheduled tasks..."
```

- 最小间隔：5 分钟
- 不支持 glob 匹配分支，必须明确分支名
- 执行者为最后修改配置的用户

---

## 11. 自定义部署

### 11.1 部署环境配置

文件：`.cnb/tag_deploy.yml`

```yaml
environments:
  - name: development
    description: Development environment
    env:
      name: development
    permissions:
      roles:
        - developer
      users:
        - user1

  - name: production
    description: Production environment
    env:
      name: production
    require:
      - environmentName: staging
        after: 1800
      - approver:
          users:
            - user1
          title: 运维审批
    deploy:
      - name: 部署
        description: 部署到生产环境
```

### 11.2 部署流水线

```yaml
main:
  tag_deploy.development:
    - stages:
        - name: deploy-dev
          script: echo "Deploy to development"

  tag_deploy.production:
    - stages:
        - name: deploy-prod
          script: echo "Deploy to production"
```

---

## 12. 自定义按钮

文件：`.cnb/web_trigger.yml`

```yaml
branch:
  - reg: ^release
    buttons:
      - name: 部署测试环境
        description: 部署到测试环境
        event: web_trigger_deploy_test
        env:
          ENV: test
        inputs:
          version:
            name: 版本号
            type: input
            required: true
            default: latest

  - buttons:
      - name: 通用按钮
        event: web_trigger_common
```

对应 `.cnb.yml` 中配置：

```yaml
"release*":
  web_trigger_deploy_test:
    - stages:
        - name: deploy
          script: echo "Deploy version $version to $ENV"
```

---

## 13. 跳过流水线

```bash
# 方式一：commit message 中添加
git commit -m "feat: some feature [ci skip]"

# 方式二：git push 选项
git push origin main -o ci.skip
```

---

## 14. 登录调试

1. 在日志页面勾选 `Rebuild` 旁的 `Debug` 选项
2. 点击 `Rebuild` 触发构建
3. 构建结束后环境保留 5 分钟，可登录调试
4. 持续有人登录则继续保留，最长 1 小时

---

## 15. Docker 镜像构建与推送

```yaml
main:
  push:
    - services:
        - docker
      stages:
        - name: build and push
          script: |
            docker build -t ${CNB_DOCKER_REGISTRY}/${CNB_REPO_SLUG_LOWERCASE}:${CNB_COMMIT_SHORT} .
            docker push ${CNB_DOCKER_REGISTRY}/${CNB_REPO_SLUG_LOWERCASE}:${CNB_COMMIT_SHORT}
```

启用 `services: [docker]` 后会自动 `docker login` 到 CNB Docker 制品库。

多架构构建（buildx）：

```yaml
main:
  push:
    - docker:
        image: golang:1.24
      services:
        - name: docker
          options:
            rootlessBuildkitd:
              enabled: true
      stages:
        - name: buildx push
          script: |
            docker login -u ${CNB_TOKEN_USER_NAME} -p "${CNB_TOKEN}" ${CNB_DOCKER_REGISTRY}
            docker buildx build -t ${CNB_DOCKER_REGISTRY}/${CNB_REPO_SLUG_LOWERCASE}:latest \
              --platform linux/amd64,linux/arm64 --push .
```

---

## 16. 云原生开发

```yaml
$:
  vscode:
    - runner:
        cpus: 64
      services:
        - vscode
        - docker
      docker:
        image: node:22
      volumes:
        - node_modules:copy-on-write
      stages:
        - pnpm install
```

---

## 17. VSCode 语法支持

安装 `redhat.vscode-yaml` 插件，在 `settings.json` 中添加：

```json
{
  "yaml.schemas": {
    "https://docs.cnb.cool/conf-schema-zh.json": ".cnb.yml"
  }
}
```

---

## 18. 本项目配置参考

当前项目 `.cnb.yml` 配置了以下流水线：

| 场景           | 分支/Tag | 事件           | 流程                                         |
| -------------- | -------- | -------------- | -------------------------------------------- |
| 主分支构建部署 | `main`   | `push`         | install → lint → build → docker build & push |
| PR 检查        | `main`   | `pull_request` | install → lint → build（失败通知）           |
| 版本发布       | `v*`     | `tag_push`     | install → build → docker build & push        |
