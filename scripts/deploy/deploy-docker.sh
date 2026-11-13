#!/usr/bin/env bash
# Docker 模式部署（在服务器上执行）：docker compose 构建镜像 → 迁移 → 启动 → 健康检查。
#
#   bash scripts/deploy/deploy-docker.sh all              # 后端 + 管理端 + 学生端
#   bash scripts/deploy/deploy-docker.sh backend
#   bash scripts/deploy/deploy-docker.sh web mobile
#   bash scripts/deploy/deploy-docker.sh all --seed       # 首次部署（建超管）
#   bash scripts/deploy/deploy-docker.sh all --check
#
#   --skip-build    使用已有镜像，不重新构建
#   --skip-migrate  不启动 migrate 服务（确认没有新迁移时）
#   --seed          启动后执行 prisma seed（仅首次初始化需要）
#   --check         只检查 compose 配置与文件，不做任何变更（含不安装）
#   --no-install    缺依赖时报错，不自动安装
#
# 配置文件：deploy/.env（服务器本地，参考 deploy/.env.example）。
# 宿主机 nginx / TLS 见 docs/部署-docker.md。
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
COMPOSE_FILE="${DOCKER_COMPOSE_FILE:-$REPO_ROOT/deploy/docker-compose.yml}"
COMPOSE_DIR="$(cd "$(dirname "$COMPOSE_FILE")" && pwd)"
ENV_FILE="${DOCKER_ENV_FILE:-$COMPOSE_DIR/.env}"
SUDO="${SUDO-sudo}"
if [[ "$(id -u)" -eq 0 ]]; then
  SUDO=""
fi

# shellcheck source=lib/ensure-env.sh
source "$SCRIPT_DIR/lib/ensure-env.sh"
# shellcheck source=lib/nginx.sh
source "$SCRIPT_DIR/lib/nginx.sh"

info() { printf '  %s\n' "$*"; }

TARGETS=()
SKIP_BUILD=0
SKIP_MIGRATE=0
RUN_SEED=0
CHECK_ONLY=0
AUTO_INSTALL=1

step() { printf '\n==> %s\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }
die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}
trap 'die "第 $LINENO 行执行失败，部署中止"' ERR

for arg in "$@"; do
  case "$arg" in
    all | backend | web | mobile) TARGETS+=("$arg") ;;
    --skip-build) SKIP_BUILD=1 ;;
    --skip-migrate) SKIP_MIGRATE=1 ;;
    --seed) RUN_SEED=1 ;;
    --check) CHECK_ONLY=1 AUTO_INSTALL=0 ;;
    --no-install) AUTO_INSTALL=0 ;;
    -h | --help)
      sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      die "未知参数：$arg（--help 看用法）"
      ;;
  esac
done
if (( ${#TARGETS[@]} == 0 )); then
  TARGETS=(all)
fi
mapfile -t TARGETS < <(printf '%s\n' "${TARGETS[@]}" | awk '!seen[$0]++')
if printf '%s\n' "${TARGETS[@]}" | grep -qx all && (( ${#TARGETS[@]} > 1 )); then
  TARGETS=(all)
fi

# docker 命令可能在自动安装后才出现；当前用户不在 docker 组时回退 sudo
DOCKER=()
COMPOSE=()

resolve_docker() {
  if docker info >/dev/null 2>&1; then
    DOCKER=(docker)
  elif $SUDO docker info >/dev/null 2>&1; then
    DOCKER=($SUDO docker)
    ensure_info "当前用户不在 docker 组，本次使用 sudo 执行 docker 命令"
  else
    die "Docker daemon 不可用"
  fi
  COMPOSE=("${DOCKER[@]}" compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE")
}

# 目标 → compose 服务名
services_for() {
  local target
  for target in "${TARGETS[@]}"; do
    case "$target" in
      all) printf '%s\n' mentor-back mentor-web mentor-mobile ;;
      backend) printf '%s\n' mentor-back ;;
      web) printf '%s\n' mentor-web ;;
      mobile) printf '%s\n' mentor-mobile ;;
    esac
  done
}

check() {
  command -v docker >/dev/null 2>&1 || die "缺少 docker"
  command -v curl >/dev/null 2>&1 || die "缺少 curl"
  "${DOCKER[@]}" compose version >/dev/null 2>&1 || die "缺少 docker compose（v2）"
  [[ -f "$COMPOSE_FILE" ]] || die "compose 文件不存在：$COMPOSE_FILE"
  [[ -f "$ENV_FILE" ]] ||
    die "环境文件不存在：$ENV_FILE（cp deploy/.env.example deploy/.env 后填写）"

  printf '  docker %s ｜ compose %s\n' \
    "$(docker --version | awk '{print $3}' | tr -d ,)" \
    "$("${DOCKER[@]}" compose version --short 2>/dev/null || true)"
  "${COMPOSE[@]}" config -q
}

check_sources() {
  local target
  for target in "${TARGETS[@]}"; do
    case "$target" in
      all)
        [[ -d "$REPO_ROOT/../mentor-web" ]] || die "管理端源码不存在：$REPO_ROOT/../mentor-web"
        [[ -d "$REPO_ROOT/../mentor-mobile" ]] || die "学生端源码不存在：$REPO_ROOT/../mentor-mobile"
        ;;
      web) [[ -d "$REPO_ROOT/../mentor-web" ]] || die "管理端源码不存在：$REPO_ROOT/../mentor-web" ;;
      mobile) [[ -d "$REPO_ROOT/../mentor-mobile" ]] || die "学生端源码不存在：$REPO_ROOT/../mentor-mobile" ;;
    esac
  done
}

read_env() {
  # 只读单个键，不 source 整个文件（避免把配置当脚本执行）
  sed -n "s/^[[:space:]]*$1=//p" "$ENV_FILE" | tail -n 1 | tr -d '\r' |
    sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"
}

wait_health() {
  local port="${BACKEND_PORT:-3000}"
  local url="http://127.0.0.1:${port}/health"
  local attempt
  step "后端健康检查：$url"
  for attempt in $(seq 1 30); do
    if curl -fsS --max-time 3 "$url" >/dev/null 2>&1; then
      printf '  健康检查通过（第 %s 次）\n' "$attempt"
      return 0
    fi
    sleep 2
  done
  "${COMPOSE[@]}" ps
  die "健康检查 60 秒未通过（docker compose logs mentor-back 查看日志）"
}

render_docker_site() {
  local domain="$1" port="$2"
  cat <<EOF
$NGINX_MARKER
server {
    listen 80;
    server_name $domain;

    client_max_body_size 20m;

    location / {
        proxy_pass http://127.0.0.1:$port;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_connect_timeout 5s;
        proxy_read_timeout 120s;
    }
}
EOF
}

configure_nginx_docker() {
  local targets="$1"
  if (( NGINX_CONFIGURE == 0 )); then
    info "NGINX_CONFIGURE=0：跳过 nginx 站点配置"
    return 0
  fi
  if ! command -v nginx >/dev/null 2>&1; then
    warn "未安装 nginx，跳过站点配置（容器端口仍监听 BIND_ADDR）"
    return 0
  fi

  local want_web=0 want_mobile=0
  case " $targets " in
    *" all "*) want_web=1; want_mobile=1 ;;
    *" web "*) want_web=1 ;;
    *" mobile "*) want_mobile=1 ;;
  esac
  (( want_web == 1 || want_mobile == 1 )) || return 0

  local domains=()
  (( want_web == 1 )) && [[ -n "$WEB_DOMAIN" ]] && domains+=("$WEB_DOMAIN")
  (( want_mobile == 1 )) && [[ -n "$MOBILE_DOMAIN" ]] && domains+=("$MOBILE_DOMAIN")
  if (( ${#domains[@]} == 0 )); then
    warn "未配置 WEB_DOMAIN / MOBILE_DOMAIN，跳过 nginx 站点（容器仍监听 127.0.0.1 端口）"
    return 0
  fi

  step "检查并写入 nginx 站点（不覆盖其他项目）"
  nginx_test || die "现有 nginx 配置不合法，先修复再部署"
  nginx_assert_unique_names "${domains[@]}"

  if (( want_web == 1 )) && [[ -n "$WEB_DOMAIN" ]]; then
    nginx_write_site "$NGINX_CONF_DIR/mentor-web.conf" \
      "$(render_docker_site "$WEB_DOMAIN" "$WEB_PORT")"
  fi
  if (( want_mobile == 1 )) && [[ -n "$MOBILE_DOMAIN" ]]; then
    nginx_write_site "$NGINX_CONF_DIR/mentor-mobile.conf" \
      "$(render_docker_site "$MOBILE_DOMAIN" "$MOBILE_PORT")"
  fi
  nginx_reload_safe
}

main() {
  # 先确认配置存在，避免为一个还没准备好的部署去装 Docker
  [[ -f "$COMPOSE_FILE" ]] || die "compose 文件不存在：$COMPOSE_FILE"
  [[ -f "$ENV_FILE" ]] ||
    die "环境文件不存在：$ENV_FILE（cp deploy/.env.example deploy/.env 后填写）"

  ensure_environment docker
  resolve_docker
  check
  check_sources
  if (( CHECK_ONLY == 1 )); then
    step "检查通过（--check 未做任何变更）"
    return 0
  fi

  BACKEND_PORT="$(read_env BACKEND_PORT)"
  WEB_PORT="$(read_env WEB_PORT)"
  MOBILE_PORT="$(read_env MOBILE_PORT)"
  : "${BACKEND_PORT:=3000}"
  : "${WEB_PORT:=8081}"
  : "${MOBILE_PORT:=8082}"
  NGINX_CONFIGURE="$(read_env NGINX_CONFIGURE)"
  NGINX_CONF_DIR="$(read_env NGINX_CONF_DIR)"
  WEB_DOMAIN="$(read_env WEB_DOMAIN)"
  MOBILE_DOMAIN="$(read_env MOBILE_DOMAIN)"
  : "${NGINX_CONFIGURE:=1}"
  : "${NGINX_CONF_DIR:=/etc/nginx/conf.d}"

  local services
  mapfile -t services < <(services_for)
  if (( ${#services[@]} == 0 )); then
    die "没有可部署的服务（目标：${TARGETS[*]}）"
  fi

  step "目标服务：${services[*]}"

  if (( SKIP_BUILD == 0 )); then
    step "构建镜像（--pull）"
    # 保留上一版镜像：回滚时 docker tag <name>:previous <name>:local 再 up --no-build
    local image
    for image in mentor-back mentor-web mentor-mobile; do
      if "${DOCKER[@]}" image inspect "$image:local" >/dev/null 2>&1; then
        "${DOCKER[@]}" tag "$image:local" "$image:previous"
        printf '  已保存上一版：%s:previous\n' "$image"
      fi
    done
    "${COMPOSE[@]}" build --pull "${services[@]}"
  else
    warn "已跳过构建（--skip-build），使用已有镜像"
  fi

  if (( SKIP_MIGRATE == 0 )); then
    # 显式跑一次迁移：不依赖 compose 是否会重启已退出的 migrate 容器；
    # 该服务也挂在 mentor-back 的 depends_on 上，重复执行是幂等的。
    step "执行数据库迁移（一次性 migrate 容器）"
    "${COMPOSE[@]}" run --rm migrate
    step "启动服务"
    "${COMPOSE[@]}" up -d --remove-orphans "${services[@]}"
  else
    warn "已跳过迁移（--skip-migrate）：只启动服务，不动数据库"
    "${COMPOSE[@]}" up -d --no-deps --remove-orphans "${services[@]}"
  fi

  wait_health

  if (( RUN_SEED == 1 )); then
    step "播种初始化数据（仅首次部署）"
    "${COMPOSE[@]}" run --rm mentor-back ./node_modules/.bin/ts-node prisma/seed.ts
  fi

  configure_nginx_docker "${TARGETS[*]}"

  # 只清悬空镜像（旧版本构建层）；命名镜像保留给回滚
  "${DOCKER[@]}" image prune -f >/dev/null 2>&1 || true

  step "部署完成"
  printf '  后端容器：mentor-back（127.0.0.1:%s）\n' "$BACKEND_PORT"
  printf '  管理端容器：mentor-web（127.0.0.1:%s）\n' "${WEB_PORT:-8081}"
  printf '  学生端容器：mentor-mobile（127.0.0.1:%s）\n' "${MOBILE_PORT:-8082}"
  printf '  查看状态：docker compose -f %s ps\n' "$COMPOSE_FILE"
  printf '  查看日志：docker compose -f %s logs -f mentor-back\n' "$COMPOSE_FILE"
}

main "$@"