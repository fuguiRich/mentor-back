# Docker 部署手册（v1）

> 适用：一台远端 Linux 服务器，Docker Engine 24+ / Compose v2。
> 三端全部容器化：MySQL、Redis、后端、管理端、学生端。
> 脚本：`scripts/deploy/deploy-docker.sh`（服务器上执行）、
> `scripts/deploy/deploy-remote.sh`（本地一键发到远端）。
>
> **所有 `docker build` / `docker compose` 都发生在远端 Linux 服务器上。**
> 本地（Windows / macOS）只负责 SSH 和源码同步——本地不需要安装 Docker。

## 服务器上直接部署（推荐）

```bash
cd /opt/mentor/mentor-back
cp deploy/.env.example deploy/.env   # 首次：填 MySQL 密码 / JWT_SECRET
bash scripts/deploy/deploy-docker.sh all
```

检测到服务器已有 nginx 时会直接复用，不会重复安装；MySQL 使用 compose 内独立容器，
不影响宿主机上已有的 MySQL。

## 可选：本地交互向导

在本地（Git Bash / WSL / macOS）执行：

```bash
bash scripts/deploy/deploy-oneclick.sh
```

只需要回答：

1. 服务器 IP / SSH 用户（默认 root）/ SSH 端口（默认 22）；
2. 首次连接时输入一次服务器密码（用于安装公钥，之后免密）；
3. 后端 / 管理端 / 学生端端口（默认 3000 / 8081 / 8082）；
4. 访问方式：`1` 直接用 IP+端口（快速验证），`2` 域名 + nginx；
5. 首次部署时输入 **MySQL root 密码** 和 **应用用户（mentor）密码**（不会随机生成；
   应用密码会拼进 `DATABASE_URL`，只允许字母、数字、`_ . -`）。

脚本会自动生成 JWT 密钥、写服务器 `deploy/.env`、上传三端源码、
在服务器上安装 Docker / Compose / nginx、构建、迁移、启动、健康检查；首次还会
创建超管（随机密码只在输出里打印一次）。

非交互（CI / 重复部署）：

```bash
DEPLOY_SSH_PASSWORD=*** \
DEPLOY_MYSQL_ROOT_PASSWORD=*** \
DEPLOY_MYSQL_PASSWORD=*** \
bash scripts/deploy/deploy-oneclick.sh \
  --host 1.2.3.4 --user root --backend-port 3000 --web-port 8081 \
  --mobile-port 8082 --access ip
```

> 本地没有 `sshpass` 时（Windows Git Bash 默认没有），首次会在 `ssh-copy-id`
> 处提示输入一次服务器密码；也可以先把公钥装到服务器，再跑脚本。
> 重复执行时默认沿用服务器上的配置与访问方式；nginx 站点只更新
> `mentor-web.conf` / `mentor-mobile.conf`（写前备份、写后校验，失败回滚）。

---

## 0. 架构

```text
浏览器
  ├─ https://admin.example.com ── 宿主机 nginx ── 127.0.0.1:8081  mentor-web 容器
  └─ https://m.example.com     ── 宿主机 nginx ── 127.0.0.1:8082  mentor-mobile 容器
                                                        │ 容器内 nginx 转发 /api/
                                                        ▼
                                                mentor-back:3000（compose 网络）
                                                   ├─ mysql:3306   （命名卷 mentor_mysql-data）
                                                   ├─ redis:6379   （命名卷 mentor_redis-data）
                                                   └─ uploads     （命名卷 mentor_uploads）
```

- 容器端口**只绑 127.0.0.1**，外网流量必须经宿主机 nginx（TLS 也在这里）。
- 前端容器内的 nginx 负责 SPA 回退、静态缓存、`/api/` 反代；宿主机 nginx 只做域名 + TLS + 转发。
- `migrate` 是一次性服务：每次 `docker compose up` 先 `prisma migrate deploy`，成功后后端才启动。
- 数据库 / Redis / 上传文件都在命名卷里，重建容器不丢数据。

---

## 1. 服务器准备

`deploy-docker.sh` 会**自动检查并安装**缺少的依赖（需要 sudo）：

| 依赖 | 处理 |
| --- | --- |
| curl / tar | 缺失时用 apt / dnf / yum / apk 安装 |
| nginx | 已安装则直接复用（不再安装）；站点配置见第 3 节 |
| Docker Engine | 优先官方 `get.docker.com` 脚本；失败回退发行版包 |
| Docker Compose 插件 | 先试 `docker-compose-plugin` / `docker-compose-v2`；再失败按官方二进制下载到 `/usr/local/lib/docker/cli-plugins` |

> 宿主机已有的 MySQL 不会被脚本安装或改动；compose 默认使用**独立的 MySQL 容器**
> （数据在 `mentor_mysql-data` 卷，不监听宿主机端口），与宿主机上的其他项目互不影响。

安装后会把当前用户加入 `docker` 组（重新登录后免 sudo 生效）；脚本本次会检测
是否只能通过 `sudo docker` 执行，并自动回退。

> 自动安装需要部署用户的 sudo 能免密执行（SSH 非交互环境无法输入密码）。
> 通过 `deploy-remote.sh` 一键部署时尤其要注意；也可以首次手工装好依赖，
> 之后用 `--no-install` 走纯部署路径。

如果不想让脚本改服务器，用 `--check`（只检查）或 `--no-install`（缺依赖直接报错）。
手动安装 Docker 的方式：

```bash
# Docker（Ubuntu 示例，官方脚本或 apt 均可）
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker mentor     # 重新登录后 docker 免 sudo

docker --version && docker compose version

# 宿主机 nginx + certbot（TLS 用）
sudo apt install -y nginx
```

目录约定（与 `deploy-remote.sh` 一致）：

```text
/opt/mentor/
  mentor-back/        # git 仓库（compose 文件在 deploy/ 下）
  mentor-web/         # 源码（非 git，由部署脚本上传）
  mentor-mobile/      # 源码（非 git，由部署脚本上传）
```

---

## 2. 配置 `deploy/.env`（服务器本地，不入库）

```bash
cd /opt/mentor/mentor-back
cp deploy/.env.example deploy/.env
chmod 600 deploy/.env
vi deploy/.env
```

必须改的：

| 键 | 说明 |
| --- | --- |
| `MYSQL_ROOT_PASSWORD` / `MYSQL_PASSWORD` | 用 URL 安全字符（避免 `@ : / ? # %`） |
| `JWT_SECRET` | `openssl rand -base64 48` |
| `SSO_*` | 按学校值；不用统一认证就保持 `SSO_LOGIN_ENABLED=0` |

`DATABASE_URL` / `REDIS_URL` / `FILE_ROOT` / `PORT` 由 `docker-compose.yml` 注入，不需要写。
**不要在服务器上设 `SEED_DEMO_DATA=1`。**

---

## 3. 宿主机 nginx

服务器上通常已经有其他项目在跑。`deploy-docker.sh` 会在部署后按 `deploy/.env` 里的
`WEB_DOMAIN` / `MOBILE_DOMAIN` 自动写站点：

1. 先 `nginx -t` 确认现有配置合法，不合法直接中止；
2. 检查目标 `server_name` 是否已被别的配置文件占用，冲突就中止；
3. 只写 `/etc/nginx/conf.d/mentor-web.conf`、`mentor-mobile.conf`（带
   `# managed by mentor deploy` 标记），写前备份、写后 `nginx -t` 失败自动回滚；
4. 全部成功才 reload，不碰其他站点。

不想让脚本写配置就把 `NGINX_CONFIGURE=0`，然后手工按
`scripts/deploy/nginx-docker.conf.example` 配置（改 server_name / 证书）。

容器端口由 `deploy/.env` 的 `WEB_PORT`（默认 8081）、`MOBILE_PORT`（默认 8082）决定，
和脚本生成的 nginx upstream 保持一致。

> 若这台机器之前配过 native 部署的 `nginx-mentor.conf.example`（root 指向静态目录），
> 要换成 docker 版配置，否则域名仍然去找旧目录，容器里的前端不会被访问到。

---

## 4. 首次部署

> 如果这台机器之前用 native 方式跑过后端，先停掉并禁用，否则 3000 端口冲突：
>
> ```bash
> sudo systemctl disable --now mentor-back
> ```

服务器上：

```bash
cd /opt/mentor/mentor-back
bash scripts/deploy/deploy-docker.sh all --seed
```

本地一键（推荐）：

```bash
# 本地 deploy-remote.env 里设：
#   DEPLOY_MODE=docker
#   BACKEND_SYNC=git   # 或 tar（本地改动未提交时）
bash scripts/deploy/deploy-remote.sh all --seed
```

`--seed` 只做一次：创建 `super_admin`，**随机密码只打印一次**。之后不要再用。

> 首次部署时远端会自动安装缺失的 Docker / Compose / nginx / curl / tar。
> Docker 安装优先走 `get.docker.com`，需要服务器能访问该地址或系统包源；
> 全部装好后再执行镜像构建。

本地一键时实际发生的事：

```text
本地（Windows/macOS）                        远端 Linux 服务器
  ssh 连通性检查                     ──▶
  tar 上传后端源码（git 模式则 ssh 执行 git pull）
  tar 上传 mentor-web / mentor-mobile  ──▶  /opt/mentor/*
                                              │
                                              ├─ docker compose build（服务器上的 Docker）
                                              ├─ migrate 容器：prisma migrate deploy
                                              ├─ up -d：mysql / redis / mentor-back / web / mobile
                                              └─ curl 127.0.0.1:3000/health
  ◀────────────────────────────────────────── 日志实时输出
```

服务器 Docker 需要能拉取 `node:22-bookworm-slim`、`nginx:1.27-alpine`、`mysql:8.4`、
`redis:7-alpine`；内网环境请提前 `docker pull` 或配置镜像加速（不需要 `docker/dockerfile` 外部 frontend 镜像）。

首次部署后：

```bash
docker compose -f deploy/docker-compose.yml ps
curl -fsS http://127.0.0.1:3000/health
curl -fsS http://127.0.0.1:8081/ | head
curl -fsS http://127.0.0.1:8082/ | head
```

---

## 5. 日常更新

```bash
# 服务器上
bash scripts/deploy/deploy-docker.sh all
bash scripts/deploy/deploy-docker.sh backend
bash scripts/deploy/deploy-docker.sh web mobile

# 或本地一键（DEPLOY_MODE=docker）
bash scripts/deploy/deploy-remote.sh all
```

| 参数 | 用途 |
| --- | --- |
| `--skip-build` | 用已有镜像，不重新构建（镜像已由别处构建 / 紧急重启） |
| `--skip-migrate` | 不启动 migrate 服务（确认没有新迁移） |
| `--seed` | 启动后执行 seed（仅首次） |
| `--check` | 只检查 compose 配置、docker/compose、目录，不变更也不安装 |
| `--no-install` | 缺依赖时直接报错，不自动安装 |

行为：

1. 构建 `mentor-back:local` / `mentor-web:local` / `mentor-mobile:local`；
   构建前把旧 `:local` 打上 `:previous` 标签（用于回滚）。
2. `docker compose run --rm migrate` 显式执行 `prisma migrate deploy`；失败则中止。
3. `up -d` 启动 / 重建变动的容器，其余容器保持运行。
4. 轮询 `http://127.0.0.1:3000/health`，60 秒不通过则报错退出。
5. `docker image prune -f` 清理悬空构建层。

---

## 6. 查看状态与日志

```bash
cd /opt/mentor/mentor-back
COMPOSE="docker compose -f deploy/docker-compose.yml"

$COMPOSE ps
$COMPOSE logs -f --tail=100 mentor-back
$COMPOSE logs -f --tail=100 mentor-web
$COMPOSE exec mentor-back node -e "console.log(process.version)"
```

---

## 7. 数据与备份

命名卷（compose `name: mentor`）：

| 卷 | 内容 |
| --- | --- |
| `mentor_mysql-data` | MySQL 数据目录 |
| `mentor_redis-data` | Redis AOF（会话 / 限流，可丢） |
| `mentor_uploads` | 上传文件（`FILE_ROOT=/data/uploads`） |

```bash
# MySQL 逻辑备份（推荐每日 cron）
docker compose -f deploy/docker-compose.yml exec -T mysql \
  mysqldump -u root -p"$MYSQL_ROOT_PASSWORD" --single-transaction "$MYSQL_DATABASE" \
  | gzip > /backup/mentor-$(date +%F-%H%M).sql.gz

# 上传文件：直接打包卷
docker run --rm -v mentor_uploads:/data -v /backup:/backup alpine \
  tar czf /backup/uploads-$(date +%F).tgz -C /data .
```

---

## 8. 回滚

**镜像回滚**（保留上一版）：

```bash
cd /opt/mentor/mentor-back
COMPOSE="docker compose -f deploy/docker-compose.yml"

docker tag mentor-back:previous mentor-back:local
docker tag mentor-web:previous mentor-web:local
docker tag mentor-mobile:previous mentor-mobile:local
$COMPOSE up -d --no-build --no-deps mentor-back mentor-web mentor-mobile
```

**源码回滚**：后端 `git checkout <上一提交>` + 重新部署（`--skip-migrate`）。

> 数据库迁移不会自动回滚。破坏性迁移前先备份；新增列 / 新表通常旧代码兼容，
> 删列 / 改语义需要先评估再执行。

---

## 9. 与 native 部署的差异

| 项 | native（systemd + nginx 静态目录） | docker（compose） |
| --- | --- | --- |
| 后端进程 | systemd / pm2 管理 `dist/main.js` | `mentor-back` 容器 |
| 前端发布 | `releases/<时间戳>` + `current` 软链 | 前端镜像内 nginx，整镜像替换 |
| MySQL / Redis | 宿主机安装 | compose 内建（命名卷） |
| 迁移 | 脚本执行 `prisma migrate deploy` | `migrate` 一次性服务 |
| 回滚 | 前端软链 / 后端 git | 镜像 `:previous` / git |
| 配置 | 后端 `.env` + `deploy.env` | `deploy/.env` 一份 |

两种模式共用「本地同步源码」的部分：`deploy-remote.sh` 里 `DEPLOY_MODE=native|docker`。

---

## 10. 注意事项

- **端口只绑 127.0.0.1**：不要改成 `0.0.0.0` 暴露后端 / MySQL / Redis。
  one-click 的「IP+端口」模式只会把两个前端端口设为 `BIND_ADDR=0.0.0.0`，后端仍绑本机。
- **HTTPS 必须**：宿主机 nginx 做 301 + 证书；SSO 回调地址要用 https。
- **`.env` 权限 600**；`deploy-remote.sh` 的 tar 同步会保留服务器上的 `deploy/.env`。
- **Swagger**：生产默认不挂载；内网需要时 `SWAGGER_ENABLED=1` 并在宿主机 nginx 放行。
- **镜像体积**：后端镜像保留完整 `node_modules`（迁移 / seed 需要 prisma、ts-node），
  约 600MB 级；v1 可接受，后续可拆迁移镜像再瘦身。
- **首次 `up` 会拉取 mysql/nginx/node 基础镜像**，服务器需要能访问镜像源；
  内网环境请提前 `docker pull` 或配置镜像加速。