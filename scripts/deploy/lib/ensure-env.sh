#!/usr/bin/env bash
# 环境自检 / 自动安装（Linux）。由 deploy.sh / deploy-docker.sh source 使用。
#
# 约定：
# - 调用方定义 step / warn / die；本文件只用它们，不重复实现日志。
# - SUDO：空 或 sudo（需要提权时）。
# - AUTO_INSTALL：1 默认；0 表示缺什么就报错（--check / --no-install）。
# - 支持 apt / dnf / yum / apk；未知发行版给出明确报错，不瞎装。
#
# 说明：自动安装会改变服务器状态（docker / node / nginx 等）。
# 首次部署前请确认这确实是想要的；只做检查用 --check 或 --no-install。

ENSURE_PM=""
ENSURE_APT_UPDATED=0
SUDO="${SUDO:-}"
AUTO_INSTALL="${AUTO_INSTALL:-1}"

ensure_info() { printf '  %s\n' "$*"; }

ensure_pm() {
  if [[ -n "$ENSURE_PM" ]]; then
    return 0
  fi
  if command -v apt-get >/dev/null 2>&1; then
    ENSURE_PM=apt
  elif command -v dnf >/dev/null 2>&1; then
    ENSURE_PM=dnf
  elif command -v yum >/dev/null 2>&1; then
    ENSURE_PM=yum
  elif command -v apk >/dev/null 2>&1; then
    ENSURE_PM=apk
  else
    ENSURE_PM=none
  fi
}

ensure_pm_install() {
  ensure_pm
  [[ "$ENSURE_PM" != "none" ]] ||
    die "无法识别包管理器（apt/dnf/yum/apk 都没有），请手动安装：$*"
  case "$ENSURE_PM" in
    apt)
      if (( ENSURE_APT_UPDATED == 0 )); then
        $SUDO env DEBIAN_FRONTEND=noninteractive apt-get update -y
        ENSURE_APT_UPDATED=1
      fi
      $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y "$@"
      ;;
    dnf) $SUDO dnf install -y "$@" ;;
    yum) $SUDO yum install -y "$@" ;;
    apk) $SUDO apk add --no-cache "$@" ;;
  esac
}

ensure_install_or_die() {
  # $1 = 缺失描述；其余 = 安装包名
  local what="$1"
  shift
  if (( AUTO_INSTALL == 0 )); then
    die "缺少 $what；自动安装已关闭（--no-install / --check），请手动安装后重试"
  fi
  step "安装 $what（$*）"
  ensure_pm_install "$@"
}

ensure_service_start() {
  local name="$1"
  command -v systemctl >/dev/null 2>&1 || return 0
  $SUDO systemctl enable --now "$name" >/dev/null 2>&1 || true
}

ensure_curl() {
  command -v curl >/dev/null 2>&1 && return 0
  ensure_install_or_die curl curl
  command -v curl >/dev/null 2>&1 || die "curl 安装失败"
}

ensure_tar() {
  command -v tar >/dev/null 2>&1 && return 0
  ensure_install_or_die tar tar
  command -v tar >/dev/null 2>&1 || die "tar 安装失败"
}

ensure_nginx() {
  if command -v nginx >/dev/null 2>&1; then
    ensure_info "已检测到 nginx（$(nginx -v 2>&1 | sed 's/^nginx version: //')），跳过安装"
    return 0
  fi
  if (( AUTO_INSTALL == 0 )); then
    warn "缺少 nginx（自动安装已关闭）；若由外部反向代理托管可忽略"
    return 0
  fi
  ensure_install_or_die nginx nginx
  command -v nginx >/dev/null 2>&1 || die "nginx 安装失败"
  ensure_info "nginx 已安装；站点配置与 TLS 仍需按 docs 配置并 reload"
}

ensure_node() {
  if command -v node >/dev/null 2>&1; then
    local major
    major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
    if (( major >= 20 )); then
      return 0
    fi
    ensure_info "当前 Node $(node -v) 低于 20，安装/升级到 22 LTS"
  else
    ensure_info "未检测到 Node.js，安装 22 LTS"
  fi

  if (( AUTO_INSTALL == 0 )); then
    die "缺少 Node.js >= 20；自动安装已关闭，请手动安装后重试"
  fi

  step "安装 Node.js 22 LTS"
  ensure_curl
  ensure_pm
  case "$ENSURE_PM" in
    apt)
      ensure_pm_install ca-certificates gnupg || true
      local nodesource_ok=0
      if curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource-setup.sh; then
        if $SUDO bash /tmp/nodesource-setup.sh; then
          nodesource_ok=1
        else
          warn "NodeSource 脚本执行失败，尝试发行版 nodejs"
        fi
        rm -f /tmp/nodesource-setup.sh
      else
        warn "NodeSource 下载失败，尝试发行版 nodejs（可能低于 20）"
      fi
      if (( nodesource_ok == 1 )); then
        ensure_pm_install nodejs || true
      else
        ensure_pm_install nodejs npm || true
      fi
      ;;
    dnf | yum)
      local nodesource_ok=0
      if curl -fsSL https://rpm.nodesource.com/setup_22.x -o /tmp/nodesource-setup.sh; then
        if $SUDO bash /tmp/nodesource-setup.sh; then
          nodesource_ok=1
        else
          warn "NodeSource 脚本执行失败，尝试发行版 nodejs"
        fi
        rm -f /tmp/nodesource-setup.sh
      else
        warn "NodeSource 下载失败，尝试发行版 nodejs（可能低于 20）"
      fi
      if (( nodesource_ok == 1 )); then
        ensure_pm_install nodejs || true
      else
        ensure_pm_install nodejs npm || true
      fi
      ;;
    apk) ensure_pm_install nodejs npm ;;
    *) die "无法自动安装 Node.js，请手动安装 Node >= 20" ;;
  esac

  command -v node >/dev/null 2>&1 || die "Node.js 安装失败"
  local major
  major="$(node -p 'process.versions.node.split(".")[0]')"
  (( major >= 20 )) || die "Node.js 仍是 $(node -v)，需要 >= 20（推荐 22 LTS）"
}

ensure_pnpm() {
  command -v pnpm >/dev/null 2>&1 && return 0
  if (( AUTO_INSTALL == 0 )); then
    die "缺少 pnpm；自动安装已关闭，请手动安装（npm i -g pnpm@10）"
  fi
  ensure_node
  step "安装 pnpm 10"
  $SUDO npm install -g pnpm@10 || die "pnpm 安装失败（npm i -g pnpm@10）"
  command -v pnpm >/dev/null 2>&1 || die "pnpm 安装失败"
}

ensure_mysql_redis() {
  # 参数：DATABASE_URL、REDIS_URL（可空，空按本机处理）。
  # 只装软件包，不建库 / 建账号 / 改密码——这些仍按 docs/部署-v1.md 手工做；
  # URL 指向外部主机时不装本机服务，避免在应用机上多装一套 MySQL/Redis。
  local db_url="${1:-}" redis_url="${2:-}"
  local db_local=1 redis_local=1
  if [[ -n "$db_url" && "$db_url" != *localhost* && "$db_url" != *127.0.0.1* ]]; then
    db_local=0
  fi
  if [[ -n "$redis_url" && "$redis_url" != *localhost* && "$redis_url" != *127.0.0.1* ]]; then
    redis_local=0
  fi

  if ! command -v mysqld >/dev/null 2>&1 && ! command -v mariadbd >/dev/null 2>&1; then
    if (( db_local == 0 )); then
      ensure_info "DATABASE_URL 指向外部数据库，跳过本机 MySQL 安装"
    elif (( AUTO_INSTALL == 0 )); then
      warn "缺少 MySQL/MariaDB Server（自动安装已关闭）"
    else
      step "安装 MySQL/MariaDB Server"
      ensure_pm
      case "$ENSURE_PM" in
        apt) ensure_pm_install mysql-server || ensure_pm_install mariadb-server || true ;;
        dnf | yum) ensure_pm_install mysql-server || true ;;
        apk) ensure_pm_install mariadb || true ;;
      esac
      ensure_service_start mysql
      ensure_service_start mysqld
      ensure_service_start mariadb
      if ! command -v mysqld >/dev/null 2>&1 && ! command -v mariadbd >/dev/null 2>&1; then
        warn "MySQL/MariaDB 未安装成功；若 DATABASE_URL 是外部库可忽略，否则请手动安装"
      else
        ensure_info "MySQL 已安装；请按 docs/部署-v1.md 创建库与账号后再重启后端"
      fi
    fi
  else
    ensure_info "已检测到 MySQL/MariaDB，跳过安装"
  fi

  if ! command -v redis-server >/dev/null 2>&1; then
    if (( redis_local == 0 )); then
      ensure_info "REDIS_URL 指向外部 Redis，跳过本机安装"
    elif (( AUTO_INSTALL == 0 )); then
      warn "缺少 redis-server（自动安装已关闭）"
    else
      step "安装 Redis"
      ensure_pm
      ensure_pm_install redis-server || ensure_pm_install redis || true
      ensure_service_start redis-server
      ensure_service_start redis
      command -v redis-server >/dev/null 2>&1 ||
        warn "Redis 未安装成功；若 REDIS_URL 是外部实例可忽略"
    fi
  else
    ensure_info "已检测到 Redis，跳过安装"
  fi
}

# ---- Docker ---------------------------------------------------------------

ensure_docker() {
  if command -v docker >/dev/null 2>&1; then
    if docker info >/dev/null 2>&1 || $SUDO docker info >/dev/null 2>&1; then
      return 0
    fi
    if (( AUTO_INSTALL == 0 )); then
      die "Docker daemon 不可用（--check / --no-install 不会启动服务）"
    fi
    ensure_info "docker 命令存在但 daemon 不可用，尝试启动"
    ensure_service_start docker
    ensure_service_start docker.service
    if docker info >/dev/null 2>&1 || $SUDO docker info >/dev/null 2>&1; then
      return 0
    fi
    die "Docker daemon 无法启动，请检查 systemctl status docker"
  fi

  if (( AUTO_INSTALL == 0 )); then
    die "缺少 Docker；自动安装已关闭，请手动安装 Docker Engine 24+ 与 compose 插件"
  fi

  ensure_curl
  step "安装 Docker Engine（官方脚本，失败时回退发行版包）"
  local installed=0
  if curl -fsSL https://get.docker.com -o /tmp/get-docker.sh; then
    if $SUDO sh /tmp/get-docker.sh; then
      installed=1
    fi
    rm -f /tmp/get-docker.sh
  fi
  if (( installed == 0 )); then
    warn "官方脚本失败，改用发行版包（可能没有 compose 插件）"
    ensure_pm
    case "$ENSURE_PM" in
      apt) ensure_pm_install docker.io || true ;;
      dnf | yum) ensure_pm_install docker || true ;;
      apk) ensure_pm_install docker || true ;;
    esac
  fi

  ensure_service_start docker
  ensure_service_start docker.service

  # 让后续免 sudo 使用 docker；当前会话不一定生效，脚本会自动检测并回退 sudo
  if [[ "$(id -u)" -ne 0 ]]; then
    $SUDO usermod -aG docker "$(id -un)" >/dev/null 2>&1 || true
  fi
  ensure_info "Docker 已安装；当前用户已加入 docker 组（重新登录后免 sudo 生效）"

  command -v docker >/dev/null 2>&1 || die "Docker 安装失败"
  docker info >/dev/null 2>&1 || $SUDO docker info >/dev/null 2>&1 ||
    die "Docker daemon 仍不可用"
}

ensure_compose() {
  if docker compose version >/dev/null 2>&1 || $SUDO docker compose version >/dev/null 2>&1; then
    return 0
  fi
  if (( AUTO_INSTALL == 0 )); then
    die "缺少 docker compose 插件；自动安装已关闭"
  fi

  step "安装 Docker Compose 插件"
  ensure_pm
  if [[ "$ENSURE_PM" != "none" ]]; then
    case "$ENSURE_PM" in
      apt) ensure_pm_install docker-compose-plugin || ensure_pm_install docker-compose-v2 || true ;;
      dnf | yum) ensure_pm_install docker-compose-plugin || true ;;
      apk) ensure_pm_install docker-cli-compose || true ;;
    esac
  fi
  if docker compose version >/dev/null 2>&1 || $SUDO docker compose version >/dev/null 2>&1; then
    return 0
  fi

  # 发行版没有插件包：按官方发布下载二进制到 cli-plugins
  ensure_curl
  local arch version
  arch="$(uname -m)"
  case "$arch" in
    x86_64 | amd64) arch=x86_64 ;;
    aarch64 | arm64) arch=aarch64 ;;
    *) die "不支持的 CPU 架构：$arch（请手动安装 docker compose 插件）" ;;
  esac
  version="${COMPOSE_PLUGIN_VERSION:-v2.29.7}"
  ensure_info "下载 compose 插件 $version（$arch）"
  $SUDO mkdir -p /usr/local/lib/docker/cli-plugins
  $SUDO curl -fsSL \
    "https://github.com/docker/compose/releases/download/${version}/docker-compose-linux-${arch}" \
    -o /usr/local/lib/docker/cli-plugins/docker-compose ||
    die "compose 插件下载失败（网络 / 代理）；请手动安装 docker compose 插件"
  $SUDO chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

  docker compose version >/dev/null 2>&1 || $SUDO docker compose version >/dev/null 2>&1 ||
    die "docker compose 插件安装失败"
}

# ---- 汇总 -----------------------------------------------------------------

# 用法：ensure_environment docker | native [DATABASE_URL REDIS_URL]
ensure_environment() {
  local mode="$1"
  shift
  step "环境自检（$mode）"
  ensure_curl
  ensure_tar
  ensure_nginx

  case "$mode" in
    docker)
      ensure_docker
      ensure_compose
      ;;
    native)
      ensure_node
      ensure_pnpm
      ensure_mysql_redis "${1:-}" "${2:-}"
      ;;
    *)
      die "未知环境类型：$mode"
      ;;
  esac
  ensure_info "环境检查通过"
}