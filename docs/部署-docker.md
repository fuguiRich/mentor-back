# Docker 部署手册（v1，复用宿主机 MySQL）

> 适用：一台远端 Linux 服务器，Docker Engine 24+ / Compose v2。
> 容器化：Redis、后端、管理端、学生端；**MySQL 使用宿主机已安装的实例**。
> 脚本：`scripts/deploy/deploy-docker.sh`（服务器上执行）。
>
> **所有 `docker build` / `docker compose` 都发生在远端 Linux 服务器上。**

## 服务器上直接部署（推荐）

部署包里的 `deploy/.env` 已按 host 模式写好（`DB_MODE=host` + `DATABASE_URL`）。
复制到服务器后按需改 MySQL 密码 / JWT，然后：

```bash
cd /opt/mentor/mentor-back
chmod 600 deploy/.env
bash scripts/deploy/deploy-docker.sh all
```

检测到服务器已有 nginx 时会直接复用，不会重复安装；MySQL 连接宿主机
`127.0.0.1:3306`，不再启动数据库容器。

---

## 0.1 复用宿主机已安装的 MySQL（DB_MODE=host）

服务器上已经有 MySQL、不想再起数据库容器时用这套：

```dotenv
# deploy/.env
DB_MODE=host
DATABASE_URL=mysql://mentor:密码@127.0.0.1:3306/mentor_back
REDIS_PORT=6379
```

编排文件会自动切换到 `deploy/docker-compose.host-db.yml`：

- 后端 / migrate 用 `network_mode: host`，直接连 `127.0.0.1:3306`；
- Redis 仍由容器提供，发布到 `127.0.0.1:6379`（宿主机已有 Redis 时改 `REDIS_PORT`）；
- 两个前端容器走 bridge，通过 `extra_hosts: mentor-back:host-gateway` 把 `/api` 反代到宿主机 3000；
- 宿主机 nginx 继续负责域名 / TLS，转发到 `127.0.0.1:8081` / `8082`。

MySQL 侧先建库建号（后端从宿主机本机连接，不需要开放 0.0.0.0）：

```sql
CREATE DATABASE mentor_back CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'mentor'@'localhost' IDENTIFIED BY '你的密码';
CREATE USER 'mentor'@'127.0.0.1' IDENTIFIED BY '你的密码';
GRANT ALL PRIVILEGES ON mentor_back.* TO 'mentor'@'localhost';
GRANT ALL PRIVILEGES ON mentor_back.* TO 'mentor'@'127.0.0.1';
FLUSH PRIVILEGES;
```

然后照常：

```bash
cd /opt/mentor/mentor-back
bash scripts/deploy/deploy-docker.sh all
```

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

部署包里已经带了一份 host 模式的 `deploy/.env`，复制到服务器后检查：

```bash
cd /opt/mentor/mentor-back
chmod 600 deploy/.env
vi deploy/.env
```

重点确认：

| 键 | 说明 |
| --- | --- |
| `DB_MODE` | 固定 `host`（复用宿主机 MySQL） |
| `DATABASE_URL` | `mysql://mentor:密码@127.0.0.1:3306/mentor_back`，密码要和 MySQL 用户一致 |
| `REDIS_PORT` | Redis 容器映射端口，默认 6379 |
| `JWT_SECRET` | 已生成；换环境时用 `openssl rand -base64 48` 重新生成 |
| `SSO_*` | 按学校值；不用统一认证就保持 `SSO_LOGIN_ENABLED=0` |

`REDIS_URL` / `FILE_ROOT` / `PORT` 由 `docker-compose.host-db.yml` 注入，不需要写。
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

`--seed` 只做一次：创建 `super_admin`，**随机密码只打印一次**。之后不要再用。

> 首次部署时脚本会自动安装缺失的 Docker / Compose / nginx / curl / tar。
> Docker 安装优先走 `get.docker.com`，需要服务器能访问该地址或系统包源；
> 全部装好后再执行镜像构建。MySQL 不会启动容器，直接连宿主机。

服务器 Docker 需要能拉取 `node:22-bookworm-slim`、`nginx:1.27-alpine`、`redis:7-alpine`；
内网环境请提前 `docker pull` 或配置镜像加速。

首次部署后：

```bash
docker compose -f deploy/docker-compose.host-db.yml ps
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
COMPOSE="docker compose -f deploy/docker-compose.host-db.yml"

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
| `mentor_redis-data` | Redis AOF（会话 / 限流，可丢） |
| `mentor_uploads` | 上传文件（`FILE_ROOT=/data/uploads`） |

MySQL 数据在宿主机上，用 mysqldump 备份：

```bash
# MySQL 逻辑备份（推荐每日 cron；账号密码来自 deploy/.env）
mysqldump -h 127.0.0.1 -u mentor -p --single-transaction mentor_back \
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
COMPOSE="docker compose -f deploy/docker-compose.host-db.yml"

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