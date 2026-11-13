#!/usr/bin/env bash
# 一键部署向导（在本地 Windows/macOS 上运行，通过 SSH 部署到远端 Linux）。
#
#   bash scripts/deploy/deploy-oneclick.sh
#
# 只会询问少量配置：
#   - 服务器 IP / SSH 用户 / SSH 端口
#   - 首次连接需要输入一次服务器密码（用于安装公钥；之后免密）
#   - 后端端口 / 管理端端口 / 学生端端口
#   - 访问方式：直接用 IP+端口，或域名 + 宿主机 nginx
#   - 首次部署时输入 MySQL root 密码 / 应用用户密码（不随机生成）
#
# 然后自动完成：安装公钥 → 写服务器 deploy/.env（MySQL 密码由你输入，JWT 自动生成）
# → 上传三端源码 → 远端自动安装 Docker/Compose/nginx → 构建镜像 → 迁移
# → 启动 → 健康检查（首次还会 seed 超管）。
#
# 也支持非交互参数（适合脚本化；密码不要写在命令行，用环境变量）：
#   DEPLOY_SSH_PASSWORD=... DEPLOY_MYSQL_ROOT_PASSWORD=... \
#   DEPLOY_MYSQL_PASSWORD=... bash scripts/deploy/deploy-oneclick.sh \
#     --host 1.2.3.4 --user root --backend-port 3000 --web-port 8081 \
#     --mobile-port 8082 --access ip
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
REMOTE_CONFIG="$SCRIPT_DIR/deploy-remote.env"
REMOTE_APP_ROOT="/opt/mentor"

HOST=""
SSH_USER="root"
SSH_PORT="22"
BACKEND_PORT=""
WEB_PORT=""
MOBILE_PORT=""
ACCESS_MODE=""
ACCESS_MODE_SET=0
WEB_DOMAIN=""
MOBILE_DOMAIN=""
ASSUME_YES=0

step() { printf '\n==> %s\n' "$*"; }
info() { printf '  %s\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }
die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}
trap 'die "第 $LINENO 行执行失败，部署中止"' ERR

usage() {
  sed -n '2,21p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) HOST="${2:?--host 需要值}"; shift 2 ;;
    --user) SSH_USER="${2:?--user 需要值}"; shift 2 ;;
    --ssh-port) SSH_PORT="${2:?--ssh-port 需要值}"; shift 2 ;;
    --backend-port) BACKEND_PORT="${2:?--backend-port 需要值}"; shift 2 ;;
    --web-port) WEB_PORT="${2:?--web-port 需要值}"; shift 2 ;;
    --mobile-port) MOBILE_PORT="${2:?--mobile-port 需要值}"; shift 2 ;;
    --access) ACCESS_MODE="${2:?--access 需要值（ip|domain）}"; ACCESS_MODE_SET=1; shift 2 ;;
    --web-domain) WEB_DOMAIN="${2:?--web-domain 需要值}"; ACCESS_MODE_SET=1; shift 2 ;;
    --mobile-domain) MOBILE_DOMAIN="${2:?--mobile-domain 需要值}"; ACCESS_MODE_SET=1; shift 2 ;;
    -y | --yes) ASSUME_YES=1; shift ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) die "未知参数：$1（--help 看用法）" ;;
  esac
done

ask() {
  local label="$1" default="${2-}" answer=""
  if (( ASSUME_YES == 1 )); then
    REPLY="${default:-}"
    return 0
  fi
  if [[ -n "$default" ]]; then
    read -r -p "$label [$default]: " answer || true
    answer="${answer:-$default}"
  else
    while :; do
      read -r -p "$label: " answer || die "无法读取输入"
      [[ -n "$answer" ]] && break
    done
  fi
  REPLY="$answer"
}

ask_secret() {
  # $1 = 提示语；$2 = 非交互模式下读取的环境变量名
  local label="$1" env_name="${2:-DEPLOY_SSH_PASSWORD}" answer=""
  if (( ASSUME_YES == 1 )); then
    REPLY="${!env_name:-}"
    return 0
  fi
  read -r -s -p "$label: " answer || true
  printf '\n'
  REPLY="$answer"
}

validate_domain() {
  [[ "$1" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] ||
    die "域名格式不对：$1"
}

rand_b64() {
  local n="${1:-48}"
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 "$n" | tr -d '\n'
  else
    head -c "$n" /dev/urandom | base64 | tr -d '\n'
  fi
}

# ---- 1. 交互收集配置 --------------------------------------------------------

step "配置"
if [[ -z "$HOST" ]]; then
  ask "服务器 IP 或域名"
  HOST="$REPLY"
fi
[[ -n "$HOST" ]] || die "服务器 IP 不能为空"

ask "SSH 用户" "$SSH_USER"
SSH_USER="$REPLY"
ask "SSH 端口" "$SSH_PORT"
SSH_PORT="$REPLY"

if [[ -z "$BACKEND_PORT" ]]; then
  ask "后端端口" "3000"
  BACKEND_PORT="$REPLY"
fi
if [[ -z "$WEB_PORT" ]]; then
  ask "管理端端口" "8081"
  WEB_PORT="$REPLY"
fi
if [[ -z "$MOBILE_PORT" ]]; then
  ask "学生端端口" "8082"
  MOBILE_PORT="$REPLY"
fi
for p in "$BACKEND_PORT" "$WEB_PORT" "$MOBILE_PORT"; do
  [[ "$p" =~ ^[0-9]+$ ]] && (( p > 0 && p < 65536 )) || die "端口不合法：$p"
done

# ---- 2. SSH 免密 ------------------------------------------------------------

step "SSH 连接"
command -v ssh >/dev/null 2>&1 || die "本机缺少 ssh"
command -v tar >/dev/null 2>&1 || die "本机缺少 tar（Windows 用 Git Bash）"

SSH_BASE=(ssh -p "$SSH_PORT" -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new "$SSH_USER@$HOST")
remote() { "${SSH_BASE[@]}" -o BatchMode=yes "$1"; }

if ! remote "true" >/dev/null 2>&1; then
  KEY="$HOME/.ssh/id_ed25519"
  if [[ ! -f "$KEY" ]]; then
    step "生成 SSH 密钥"
    mkdir -p "$HOME/.ssh"
    ssh-keygen -t ed25519 -N "" -f "$KEY" -q
    info "已生成：$KEY"
  fi

  if command -v sshpass >/dev/null 2>&1; then
    if [[ -z "${DEPLOY_SSH_PASSWORD:-}" ]]; then
      ask_secret "服务器密码（仅用于安装公钥，不会保存）" DEPLOY_SSH_PASSWORD
      DEPLOY_SSH_PASSWORD="$REPLY"
    fi
    [[ -n "$DEPLOY_SSH_PASSWORD" ]] || die "密码为空"
    step "安装 SSH 公钥（sshpass）"
    sshpass -p "$DEPLOY_SSH_PASSWORD" ssh-copy-id -i "$KEY.pub" \
      -p "$SSH_PORT" -o StrictHostKeyChecking=accept-new "$SSH_USER@$HOST"
  else
    step "安装 SSH 公钥"
    info "本机没有 sshpass，接下来 ssh-copy-id 会提示输入一次服务器密码"
    if command -v ssh-copy-id >/dev/null 2>&1; then
      ssh-copy-id -i "$KEY.pub" -p "$SSH_PORT" \
        -o StrictHostKeyChecking=accept-new "$SSH_USER@$HOST"
    else
      # Windows OpenSSH 有时不带 ssh-copy-id：直接追加公钥（会提示一次密码）
      PUB="$(cat "$KEY.pub")"
      "${SSH_BASE[@]}" "mkdir -p ~/.ssh && chmod 700 ~/.ssh && \
        (grep -qF '$PUB' ~/.ssh/authorized_keys 2>/dev/null || echo '$PUB' >> ~/.ssh/authorized_keys) && \
        chmod 600 ~/.ssh/authorized_keys"
    fi
  fi

  remote "true" >/dev/null 2>&1 || die "SSH 免密仍未生效，请检查用户/端口/密码"
fi
info "SSH 免密正常：$SSH_USER@$HOST:$SSH_PORT"

# ---- 3. 判断首次部署 --------------------------------------------------------

FIRST_DEPLOY=0
if ! remote "test -f '$REMOTE_APP_ROOT/mentor-back/deploy/.env'" >/dev/null 2>&1; then
  FIRST_DEPLOY=1
fi

# 已部署过：沿用服务器上的端口 / 绑定地址，避免和 compose 实际监听不一致
if (( FIRST_DEPLOY == 0 )); then
  existing_backend="$(remote "sed -n 's/^BACKEND_PORT=//p' '$REMOTE_APP_ROOT/mentor-back/deploy/.env' | tail -n1" || true)"
  existing_web="$(remote "sed -n 's/^WEB_PORT=//p' '$REMOTE_APP_ROOT/mentor-back/deploy/.env' | tail -n1" || true)"
  existing_mobile="$(remote "sed -n 's/^MOBILE_PORT=//p' '$REMOTE_APP_ROOT/mentor-back/deploy/.env' | tail -n1" || true)"
  [[ -n "$existing_backend" ]] && BACKEND_PORT="$existing_backend"
  [[ -n "$existing_web" ]] && WEB_PORT="$existing_web"
  [[ -n "$existing_mobile" ]] && MOBILE_PORT="$existing_mobile"
  info "检测到已部署：沿用服务器端口 $BACKEND_PORT / $WEB_PORT / $MOBILE_PORT"
fi

# 访问方式：首次部署询问；重复部署默认沿用现有（不碰 nginx）
if [[ -z "$ACCESS_MODE" ]]; then
  if (( ACCESS_MODE_SET == 1 )); then
    if [[ -n "$WEB_DOMAIN" || -n "$MOBILE_DOMAIN" ]]; then
      ACCESS_MODE=domain
    else
      ACCESS_MODE=ip
    fi
  elif (( FIRST_DEPLOY == 0 )); then
    ACCESS_MODE=keep
  elif (( ASSUME_YES == 1 )); then
    ACCESS_MODE=ip
  else
    printf '\n访问方式：\n'
    printf '  1) 直接用 IP + 端口访问（最快，先跑起来；生产后续再加 HTTPS）\n'
    printf '  2) 域名 + 宿主机 nginx（生产形态，脚本会写 nginx 站点；TLS 需再配）\n'
    ask "选择" "1"
    case "$REPLY" in
      1 | ip) ACCESS_MODE=ip ;;
      2 | domain) ACCESS_MODE=domain ;;
      *) die "访问方式只能是 1 或 2" ;;
    esac
  fi
fi
case "$ACCESS_MODE" in
  ip | domain | keep) ;;
  *) die "访问方式只能是 ip / domain / keep" ;;
esac

if [[ "$ACCESS_MODE" == "domain" ]]; then
  if [[ -z "$WEB_DOMAIN" ]]; then
    ask "管理端域名（例如 admin.example.com）"
    WEB_DOMAIN="$REPLY"
  fi
  if [[ -z "$MOBILE_DOMAIN" ]]; then
    ask "学生端域名（例如 m.example.com）"
    MOBILE_DOMAIN="$REPLY"
  fi
  validate_domain "$WEB_DOMAIN"
  validate_domain "$MOBILE_DOMAIN"
fi

# ---- 4. 服务器配置（仅首次） ------------------------------------------------

if (( FIRST_DEPLOY == 1 )); then
  JWT_SECRET="$(rand_b64 48)"

  # MySQL 密码由用户指定（不随机生成）。非交互模式用环境变量：
  #   DEPLOY_MYSQL_ROOT_PASSWORD、DEPLOY_MYSQL_PASSWORD
  if [[ -z "${DEPLOY_MYSQL_ROOT_PASSWORD:-}" ]]; then
    if (( ASSUME_YES == 1 )); then
      die "非交互模式需要设置 DEPLOY_MYSQL_ROOT_PASSWORD"
    fi
    ask_secret "MySQL root 密码" DEPLOY_MYSQL_ROOT_PASSWORD
    DEPLOY_MYSQL_ROOT_PASSWORD="$REPLY"
  fi
  [[ -n "$DEPLOY_MYSQL_ROOT_PASSWORD" ]] || die "MySQL root 密码不能为空"
  [[ "$DEPLOY_MYSQL_ROOT_PASSWORD" =~ [[:space:]#\"\'] ]] &&
    die "MySQL root 密码不能包含空白、引号或 #"

  if [[ -z "${DEPLOY_MYSQL_PASSWORD:-}" ]]; then
    if (( ASSUME_YES == 1 )); then
      DEPLOY_MYSQL_PASSWORD="$DEPLOY_MYSQL_ROOT_PASSWORD"
    else
      ask_secret "MySQL 应用用户（mentor）密码（回车沿用 root 密码）" DEPLOY_MYSQL_PASSWORD
      DEPLOY_MYSQL_PASSWORD="${REPLY:-$DEPLOY_MYSQL_ROOT_PASSWORD}"
    fi
  fi
  [[ -n "$DEPLOY_MYSQL_PASSWORD" ]] || die "MySQL 应用用户密码不能为空"
  # DATABASE_URL 会直接拼接这个密码，必须 URL 安全
  [[ "$DEPLOY_MYSQL_PASSWORD" =~ ^[A-Za-z0-9_.-]+$ ]] ||
    die "MySQL 应用用户密码只能包含字母、数字、下划线、点、短横线（要拼进 DATABASE_URL）"

  MYSQL_ROOT_PASSWORD="$DEPLOY_MYSQL_ROOT_PASSWORD"
  MYSQL_PASSWORD="$DEPLOY_MYSQL_PASSWORD"
  if [[ "$ACCESS_MODE" == "ip" ]]; then
    BIND_ADDR="0.0.0.0"
    PUBLIC_WEB_URL="http://$HOST:$WEB_PORT"
    PUBLIC_MOBILE_URL="http://$HOST:$MOBILE_PORT"
    CORS_ORIGINS=""
  else
    BIND_ADDR="127.0.0.1"
    PUBLIC_WEB_URL="https://$WEB_DOMAIN"
    PUBLIC_MOBILE_URL="https://$MOBILE_DOMAIN"
    CORS_ORIGINS="https://$WEB_DOMAIN,https://$MOBILE_DOMAIN"
  fi

  step "写入服务器配置 deploy/.env"
  ENV_CONTENT="$(cat <<EOF
TZ=Asia/Shanghai
MYSQL_ROOT_PASSWORD=$MYSQL_ROOT_PASSWORD
MYSQL_DATABASE=mentor_back
MYSQL_USER=mentor
MYSQL_PASSWORD=$MYSQL_PASSWORD
BACKEND_PORT=$BACKEND_PORT
WEB_PORT=$WEB_PORT
MOBILE_PORT=$MOBILE_PORT
BIND_ADDR=$BIND_ADDR
NGINX_CONFIGURE=1
WEB_DOMAIN=$WEB_DOMAIN
MOBILE_DOMAIN=$MOBILE_DOMAIN
JWT_SECRET=$JWT_SECRET
FILE_MAX_BYTES=10485760
SWAGGER_ENABLED=0
CORS_ORIGINS=$CORS_ORIGINS
SSO_LOGIN_ENABLED=0
SSO_SYNC_ENABLED=0
EOF
)"
  printf '%s\n' "$ENV_CONTENT" |
    remote "umask 077 && mkdir -p '$REMOTE_APP_ROOT/mentor-back/deploy' && \
      cat > '$REMOTE_APP_ROOT/mentor-back/deploy/.env.tmp' && \
      mv '$REMOTE_APP_ROOT/mentor-back/deploy/.env.tmp' '$REMOTE_APP_ROOT/mentor-back/deploy/.env'"
  info "已生成随机 MySQL / JWT 密钥（保存在服务器 deploy/.env，权限 600）"
else
  BIND_ADDR="$(remote "sed -n 's/^BIND_ADDR=//p' '$REMOTE_APP_ROOT/mentor-back/deploy/.env' | tail -n1" || true)"
  : "${BIND_ADDR:=127.0.0.1}"
  if [[ "$ACCESS_MODE" == "ip" ]]; then
    if [[ "$BIND_ADDR" != "0.0.0.0" ]]; then
      die "服务器现有 deploy/.env 的 BIND_ADDR=$BIND_ADDR，IP:端口无法从外部访问；请改用域名模式，或把 deploy/.env 改成 BIND_ADDR=0.0.0.0 后重跑"
    fi
    PUBLIC_WEB_URL="http://$HOST:$WEB_PORT"
    PUBLIC_MOBILE_URL="http://$HOST:$MOBILE_PORT"
  elif [[ "$ACCESS_MODE" == "domain" ]]; then
    PUBLIC_WEB_URL="https://$WEB_DOMAIN"
    PUBLIC_MOBILE_URL="https://$MOBILE_DOMAIN"
  elif [[ "$BIND_ADDR" == "0.0.0.0" ]]; then
    PUBLIC_WEB_URL="http://$HOST:$WEB_PORT"
    PUBLIC_MOBILE_URL="http://$HOST:$MOBILE_PORT"
  else
    # keep：沿用上次记录的地址；没有就只提示已部署
    PUBLIC_WEB_URL="$(sed -n 's/^PUBLIC_WEB_URL=//p' "$REMOTE_CONFIG" 2>/dev/null | tail -n1)"
    PUBLIC_MOBILE_URL="$(sed -n 's/^PUBLIC_MOBILE_URL=//p' "$REMOTE_CONFIG" 2>/dev/null | tail -n1)"
    : "${PUBLIC_WEB_URL:=（沿用现有 nginx 配置）}"
    : "${PUBLIC_MOBILE_URL:=（沿用现有 nginx 配置）}"
  fi
fi

# ---- 5. 生成本地 deploy-remote.env -----------------------------------------

step "生成本地 deploy-remote.env"
umask 077
cat >"$REMOTE_CONFIG" <<EOF
REMOTE_HOST=$HOST
REMOTE_USER=$SSH_USER
REMOTE_PORT=$SSH_PORT
SSH_OPTS="-o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new"
REMOTE_APP_ROOT=$REMOTE_APP_ROOT
REMOTE_BACKEND_DIR=$REMOTE_APP_ROOT/mentor-back
REMOTE_WEB_SRC=$REMOTE_APP_ROOT/mentor-web
REMOTE_MOBILE_SRC=$REMOTE_APP_ROOT/mentor-mobile
DEPLOY_MODE=docker
BACKEND_SYNC=tar
REMOTE_DEPLOY_CONFIG=$REMOTE_APP_ROOT/mentor-back/scripts/deploy/deploy.env
PUBLIC_WEB_URL=$PUBLIC_WEB_URL
PUBLIC_MOBILE_URL=$PUBLIC_MOBILE_URL
EOF
chmod 600 "$REMOTE_CONFIG" 2>/dev/null || true
info "已写入：$REMOTE_CONFIG"

# ---- 6. 同步源码并部署 ------------------------------------------------------

step "部署（首次 = $FIRST_DEPLOY）"
DEPLOY_ARGS=(all)
if (( FIRST_DEPLOY == 1 )); then
  DEPLOY_ARGS+=(--seed)
  info "首次部署会创建 super_admin，随机密码只打印一次，请注意保存"
fi
DEPLOY_REMOTE_CONFIG="$REMOTE_CONFIG" bash "$SCRIPT_DIR/deploy-remote.sh" "${DEPLOY_ARGS[@]}"

# ---- 7. nginx --------------------------------------------------------------

if [[ "$ACCESS_MODE" == "domain" ]]; then
  info "nginx 站点由服务器端 deploy-docker.sh 写入（已做冲突检查与回滚）"
  info "启用 HTTPS：sudo certbot --nginx -d $WEB_DOMAIN -d $MOBILE_DOMAIN（或手动配证书）"
fi

# ---- 8. 汇总 ----------------------------------------------------------------

step "完成"
info "管理端地址：$PUBLIC_WEB_URL"
info "学生端地址：$PUBLIC_MOBILE_URL"
info "接口健康：$PUBLIC_WEB_URL/api/health"
if [[ "$ACCESS_MODE" == "ip" ]]; then
  warn "当前是 HTTP + IP:端口模式，仅适合验证；生产请改用域名 + HTTPS"
fi
info "重新部署：bash scripts/deploy/deploy-oneclick.sh -y --host $HOST --access $ACCESS_MODE"
info "服务器配置：$REMOTE_APP_ROOT/mentor-back/deploy/.env（改端口 / 密钥后重跑部署）"