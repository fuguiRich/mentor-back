#!/usr/bin/env bash
# mentor v1 一键部署：后端（NestJS）+ 管理端（mentor-web）+ 学生端（mentor-mobile）
#
# 在服务器上运行（Linux + bash）。配置见同目录 deploy.env.example，
# 完整步骤见 docs/部署-v1.md。
#
#   bash scripts/deploy/deploy.sh all             # 三端全量
#   bash scripts/deploy/deploy.sh backend         # 只发后端
#   bash scripts/deploy/deploy.sh web             # 只发管理端
#   bash scripts/deploy/deploy.sh mobile          # 只发学生端
#
#   --skip-build     前端不重新构建，直接发布已有的 dist（离线 / 本地构建后上传）
#   --skip-migrate   后端跳过 prisma migrate deploy
#   --seed           后端部署后执行 db:seed（仅首次初始化需要）
#   --with-tests     后端构建前跑 lint + tsc + 单测（默认不跑，CI 负责）
#   --check          只做配置与依赖检查，不改任何东西（含不安装）
#   --no-install     缺依赖时报错，不自动安装
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CONFIG_FILE="${DEPLOY_CONFIG:-$SCRIPT_DIR/deploy.env}"

# shellcheck source=lib/ensure-env.sh
source "$SCRIPT_DIR/lib/ensure-env.sh"
# shellcheck source=lib/nginx.sh
source "$SCRIPT_DIR/lib/nginx.sh"

TARGET="all"
SKIP_BUILD=0
SKIP_MIGRATE=0
RUN_SEED=0
WITH_TESTS=0
CHECK_ONLY=0
AUTO_INSTALL=1

usage() {
  sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    all | backend | web | mobile) TARGET="$1" ;;
    --skip-build) SKIP_BUILD=1 ;;
    --skip-migrate) SKIP_MIGRATE=1 ;;
    --seed) RUN_SEED=1 ;;
    --with-tests) WITH_TESTS=1 ;;
    --check) CHECK_ONLY=1 AUTO_INSTALL=0 ;;
    --no-install) AUTO_INSTALL=0 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      printf 'ERROR: 未知参数 %s（--help 看用法）\n' "$1" >&2
      exit 1
      ;;
  esac
  shift
done

step() { printf '\n==> %s\n' "$*"; }
info() { printf '  %s\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }
die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}
trap 'die "第 $LINENO 行执行失败，部署中止"' ERR

if [[ -f "$CONFIG_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$CONFIG_FILE"
else
  warn "未找到 $CONFIG_FILE，使用默认值（参考 scripts/deploy/deploy.env.example）"
fi

# ---- 可配置项（deploy.env 里覆盖） ----------------------------------------
# 源码目录：后端默认本仓库；前端默认同级目录（服务器上按实际位置改）
: "${BACKEND_DIR:=$REPO_ROOT}"
: "${WEB_SRC:=$REPO_ROOT/../mentor-web}"
: "${MOBILE_SRC:=$REPO_ROOT/../mentor-mobile}"

# 发布目录：nginx 的 root 指向 <root>/current（符号链接，可回滚）
: "${WEB_ROOT:=/var/www/mentor-web}"
: "${MOBILE_ROOT:=/var/www/mentor-mobile}"

# 前端请求前缀：nginx 把 /api/ 反代到后端并剥掉前缀
: "${API_BASE:=/api}"

# 后端进程管理：systemd（默认）或 pm2
: "${PROCESS_MANAGER:=systemd}"
: "${BACKEND_SERVICE:=mentor-back}"
: "${PM2_NAME:=mentor-back}"
: "${PM2_BIN:=pm2}"
: "${BACKEND_PORT:=3000}"
: "${HEALTH_PATH:=/health}"

# nginx 站点（服务器上已有其他项目：只写 mentor- 前缀的独立文件，并检查冲突）
# 1 = 按下面的域名自动生成 /etc/nginx/conf.d/mentor-*.conf；0 = 只做 nginx -t + reload
: "${NGINX_CONFIGURE:=1}"
: "${NGINX_CONF_DIR:=/etc/nginx/conf.d}"
: "${WEB_DOMAIN:=}"
: "${MOBILE_DOMAIN:=}"

# 需要提权时设 SUDO=sudo（写 /var/www、systemctl、自动安装依赖）。
# root 直接运行则自动去掉 sudo；目录都归部署用户时可显式设 SUDO=
: "${SUDO-sudo}"
if [[ "$(id -u)" -eq 0 ]]; then
  SUDO=""
fi
: "${PNPM:=pnpm}"
: "${KEEP_RELEASES:=5}"
: "${RELOAD_NGINX:=1}"
: "${NGINX_RELOAD_CMD:=$SUDO systemctl reload nginx}"

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "缺少命令：$1"
}

check_node() {
  require_cmd node
  local major
  major="$(node -p 'process.versions.node.split(".")[0]')"
  if (( major < 20 )); then
    die "Node 版本过低（当前 $(node -v)），NestJS 11 需要 Node >= 20（推荐 22 LTS）"
  fi
  require_cmd "$PNPM"
  require_cmd curl
  printf '  node %s ｜ pnpm %s ｜ %s\n' "$(node -v)" "$("$PNPM" -v)" "$(uname -srm)"
}

check_backend() {
  [[ -d "$BACKEND_DIR" ]] || die "后端目录不存在：BACKEND_DIR=$BACKEND_DIR"
  [[ -f "$BACKEND_DIR/package.json" ]] || die "后端目录不像项目根（缺 package.json）：$BACKEND_DIR"
  [[ -f "$BACKEND_DIR/.env" ]] ||
    die "后端 .env 不存在：$BACKEND_DIR/.env（生产配置不能由仓库提供，需在服务器上单独维护）"
}

check_frontend() {
  local src="$1" name="$2"
  [[ -d "$src" ]] || die "$name 源码目录不存在：$src"
  [[ -f "$src/package.json" ]] || die "$name 目录不像项目根（缺 package.json）：$src"
}

wait_health() {
  local url="http://127.0.0.1:${BACKEND_PORT}${HEALTH_PATH}"
  local attempt
  step "后端健康检查：$url"
  for attempt in $(seq 1 30); do
    if curl -fsS --max-time 3 "$url" >/dev/null 2>&1; then
      printf '  健康检查通过（第 %s 次）\n' "$attempt"
      return 0
    fi
    sleep 2
  done
  die "健康检查 60 秒未通过：$url（看 journalctl -u $BACKEND_SERVICE -n 100 或 pm2 logs）"
}

restart_backend() {
  case "$PROCESS_MANAGER" in
    systemd)
      require_cmd systemctl
      step "重启 systemd 服务：$BACKEND_SERVICE"
      $SUDO systemctl restart "$BACKEND_SERVICE"
      $SUDO systemctl is-active --quiet "$BACKEND_SERVICE" ||
        die "服务未处于 active：$BACKEND_SERVICE"
      ;;
    pm2)
      require_cmd "$PM2_BIN"
      step "重启 pm2 进程：$PM2_NAME"
      if "$PM2_BIN" describe "$PM2_NAME" >/dev/null 2>&1; then
        "$PM2_BIN" restart "$PM2_NAME" --update-env
      else
        (cd "$BACKEND_DIR" && "$PM2_BIN" start dist/main.js --name "$PM2_NAME" --cwd "$BACKEND_DIR")
      fi
      ;;
    *)
      die "PROCESS_MANAGER 只能是 systemd 或 pm2（当前：$PROCESS_MANAGER）"
      ;;
  esac
}

deploy_backend() {
  check_backend
  step "后端：安装依赖（--frozen-lockfile）"
  # --prod=false：构建需要 devDependencies（nest cli / prisma / typescript）；
  # 服务器全局设了 NODE_ENV=production 时也不让 pnpm 省掉它们
  (cd "$BACKEND_DIR" && "$PNPM" install --frozen-lockfile --prod=false)

  step "后端：生成 Prisma Client"
  (cd "$BACKEND_DIR" && "$PNPM" exec prisma generate)

  if (( WITH_TESTS == 1 )); then
    step "后端：质量门槛（lint / tsc / 单测）"
    (cd "$BACKEND_DIR" && "$PNPM" lint)
    (cd "$BACKEND_DIR" && "$PNPM" exec tsc --noEmit -p tsconfig.json)
    (cd "$BACKEND_DIR" && "$PNPM" test)
  fi

  step "后端：编译（nest build）"
  (cd "$BACKEND_DIR" && "$PNPM" build)
  [[ -f "$BACKEND_DIR/dist/main.js" ]] || die "构建产物缺失：$BACKEND_DIR/dist/main.js"

  if (( SKIP_MIGRATE == 0 )); then
    step "后端：执行数据库迁移（prisma migrate deploy）"
    (cd "$BACKEND_DIR" && "$PNPM" db:migrate)
  else
    warn "已跳过数据库迁移（--skip-migrate）"
  fi

  if (( RUN_SEED == 1 )); then
    step "后端：播种初始化数据（仅首次部署）"
    (cd "$BACKEND_DIR" && "$PNPM" db:seed)
  fi

  restart_backend
  wait_health
}

# 原子发布：新构建放进 releases/<时间戳>，current 符号链接指向它；旧版本按 KEEP_RELEASES 清理
publish_dist() {
  local label="$1" slug="$2" dist="$3" root="$4"
  local stamp release current="$root/current"
  stamp="$(date +%Y%m%d-%H%M%S)"
  release="$root/releases/$stamp-$slug"
  # 同一秒内连续部署时给目录加后缀，避免覆盖正在使用的版本
  if [[ -e "$release" ]]; then
    release="$release-$$"
  fi

  step "$label：发布到 $release"
  if [[ -e "$current" && ! -L "$current" ]]; then
    die "$current 已存在且不是符号链接，拒绝覆盖（请先人工确认）"
  fi
  $SUDO mkdir -p "$release"
  $SUDO cp -a "$dist/." "$release/"
  printf '{"release":"%s","builtAt":"%s"}\n' "$(basename "$release")" "$(date -Is)" |
    $SUDO tee "$release/version.json" >/dev/null
  $SUDO chmod -R a+rX "$release"
  $SUDO ln -sfn "$release" "$current"
  printf '  current -> %s\n' "$release"

  # 只留最近 KEEP_RELEASES 份。**按目录名排序而不是 mtime**：`cp -a` 会保留
  # 源目录的 mtime，用 `ls -t` 会把「新版本」排到旧版本后面，清理时误删新版本。
  local old
  mapfile -t old < <(ls -1d "$root"/releases/* 2>/dev/null | sort -r | tail -n +$((KEEP_RELEASES + 1)))
  if (( ${#old[@]} > 0 )); then
    $SUDO rm -rf "${old[@]}"
    printf '  清理旧版本：%s 份\n' "${#old[@]}"
  fi
}

deploy_frontend() {
  local label="$1" src="$2" root="$3" base_var="$4" slug="$5"

  if (( SKIP_BUILD == 0 )); then
    check_frontend "$src" "$label"
    step "$label：安装依赖（--frozen-lockfile）"
    (cd "$src" && "$PNPM" install --frozen-lockfile --prod=false)

    step "$label：构建（$base_var=$API_BASE）"
    (cd "$src" && env "$base_var=$API_BASE" "$PNPM" build)
  else
    warn "$label 已跳过构建（--skip-build），直接发布 $src/dist"
  fi

  local dist="$src/dist"
  [[ -f "$dist/index.html" ]] || die "$label 构建产物缺失：$dist/index.html"

  # 兜底：生产包不能把开发机地址带上去（VITE_API_* 没生效时最容易发生）
  if grep -RIl --include='*.js' --include='*.html' --include='*.css' -E 'localhost:(3000|3001)' "$dist" >/dev/null; then
    die "$label 构建产物仍引用 localhost，检查 $base_var 是否生效"
  fi

  publish_dist "$label" "$slug" "$dist" "$root"
}

render_nginx_site() {
  local domain="$1" root="$2"
  cat <<EOF
$NGINX_MARKER
server {
    listen 80;
    server_name $domain;

    root $root/current;
    index index.html;
    client_max_body_size 20m;

    location /api/ {
        proxy_pass http://127.0.0.1:$BACKEND_PORT/;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_connect_timeout 5s;
        proxy_read_timeout 60s;
    }

    location / {
        try_files \$uri \$uri/ /index.html;
    }

    location = /index.html {
        add_header Cache-Control "no-store, must-revalidate";
    }

    location ~* \.(?:js|css|woff2?|ttf|png|jpe?g|gif|svg|ico)$ {
        expires 30d;
        add_header Cache-Control "public, max-age=2592000, immutable";
        try_files \$uri =404;
    }
}
EOF
}

configure_nginx() {
  local target="$1"
  if (( NGINX_CONFIGURE == 0 )); then
    info "NGINX_CONFIGURE=0：跳过站点配置生成（仍会 nginx -t + reload）"
    return 0
  fi
  if ! command -v nginx >/dev/null 2>&1; then
    warn "未安装 nginx，跳过站点配置"
    return 0
  fi

  local domains=()
  case "$target" in
    all)
      [[ -n "$WEB_DOMAIN" ]] && domains+=("$WEB_DOMAIN")
      [[ -n "$MOBILE_DOMAIN" ]] && domains+=("$MOBILE_DOMAIN")
      ;;
    web) [[ -n "$WEB_DOMAIN" ]] && domains+=("$WEB_DOMAIN") ;;
    mobile) [[ -n "$MOBILE_DOMAIN" ]] && domains+=("$MOBILE_DOMAIN") ;;
  esac

  if (( ${#domains[@]} == 0 )); then
    warn "未配置 WEB_DOMAIN / MOBILE_DOMAIN，跳过自动写站点（只做 nginx -t + reload）"
    return 0
  fi

  step "检查并写入 nginx 站点（不覆盖其他项目）"
  nginx_test || die "现有 nginx 配置不合法，先修复再部署"
  nginx_assert_unique_names "${domains[@]}"

  if [[ "$target" == "all" || "$target" == "web" ]] && [[ -n "$WEB_DOMAIN" ]]; then
    nginx_write_site "$NGINX_CONF_DIR/mentor-web.conf" \
      "$(render_nginx_site "$WEB_DOMAIN" "$WEB_ROOT")"
  fi
  if [[ "$target" == "all" || "$target" == "mobile" ]] && [[ -n "$MOBILE_DOMAIN" ]]; then
    nginx_write_site "$NGINX_CONF_DIR/mentor-mobile.conf" \
      "$(render_nginx_site "$MOBILE_DOMAIN" "$MOBILE_ROOT")"
  fi
}

reload_nginx() {
  (( RELOAD_NGINX == 1 )) || return 0
  step "重载 nginx"
  nginx_reload_safe
}

read_env_var() {
  # 只读单键，不 source 整个 .env。文件不存在时输出空串。
  sed -n "s/^[[:space:]]*$1=//p" "$BACKEND_DIR/.env" 2>/dev/null | tail -n 1 |
    tr -d '\r' | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"
}

main() {
  step "部署配置"
  printf '  目标：%s ｜ 后端：%s ｜ 管理端：%s ｜ 学生端：%s\n' \
    "$TARGET" "$BACKEND_DIR" "$WEB_SRC" "$MOBILE_SRC"
  printf '  发布目录：%s、%s ｜ API 前缀：%s\n' "$WEB_ROOT" "$MOBILE_ROOT" "$API_BASE"

  local db_url redis_url
  case "$TARGET" in
    all | backend) check_backend ;;
  esac
  db_url="$(read_env_var DATABASE_URL)"
  redis_url="$(read_env_var REDIS_URL)"
  case "$TARGET" in
    all | backend) ensure_environment native "$db_url" "$redis_url" ;;
    *)
      # 只发前端时不需要数据库，别为了静态资源去装 MySQL/Redis
      ensure_curl
      ensure_tar
      ensure_nginx
      ensure_node
      ensure_pnpm
      ensure_info "环境检查通过（前端）"
      ;;
  esac
  # 服务器上通常还有别的项目：先确认现有 nginx 配置本身是合法的
  nginx_test || die "现有 nginx 配置不合法，请先修复（nginx -t 的输出见上）"
  check_node

  if (( CHECK_ONLY == 1 )); then
    case "$TARGET" in
      all) check_backend && check_frontend "$WEB_SRC" "管理端" && check_frontend "$MOBILE_SRC" "学生端" ;;
      backend) check_backend ;;
      web) check_frontend "$WEB_SRC" "管理端" ;;
      mobile) check_frontend "$MOBILE_SRC" "学生端" ;;
    esac
    step "检查通过（--check 未做任何改动）"
    return 0
  fi

  case "$TARGET" in
    all)
      deploy_backend
      deploy_frontend "管理端" "$WEB_SRC" "$WEB_ROOT" "VITE_API_BASE" "web"
      deploy_frontend "学生端" "$MOBILE_SRC" "$MOBILE_ROOT" "VITE_API_BASE_URL" "mobile"
      configure_nginx "all"
      reload_nginx
      ;;
    backend) deploy_backend ;;
    web)
      deploy_frontend "管理端" "$WEB_SRC" "$WEB_ROOT" "VITE_API_BASE" "web"
      configure_nginx "web"
      reload_nginx
      ;;
    mobile)
      deploy_frontend "学生端" "$MOBILE_SRC" "$MOBILE_ROOT" "VITE_API_BASE_URL" "mobile"
      configure_nginx "mobile"
      reload_nginx
      ;;
  esac

  step "部署完成"
  printf '  后端健康：http://127.0.0.1:%s%s\n' "$BACKEND_PORT" "$HEALTH_PATH"
  if [[ "$TARGET" == "all" || "$TARGET" == "web" ]]; then
    printf '  管理端：%s/current\n' "$WEB_ROOT"
  fi
  if [[ "$TARGET" == "all" || "$TARGET" == "mobile" ]]; then
    printf '  学生端：%s/current\n' "$MOBILE_ROOT"
  fi
}

main "$@"