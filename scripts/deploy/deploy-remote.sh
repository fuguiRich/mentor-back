#!/usr/bin/env bash
# 从本地一键发布到远端 Linux 服务器（需要 SSH 密钥免密登录）。
#
#   bash scripts/deploy/deploy-remote.sh all            # 后端 + 管理端 + 学生端
#   bash scripts/deploy/deploy-remote.sh backend        # 只发后端
#   bash scripts/deploy/deploy-remote.sh web mobile     # 只发两个前端
#   bash scripts/deploy/deploy-remote.sh all --seed     # 首次部署（远端建超管）
#   bash scripts/deploy/deploy-remote.sh all --check    # 远端只做配置检查
#
# 本地配置：scripts/deploy/deploy-remote.env（参考 .example，不入库）。
# 远端真正干活的脚本是 scripts/deploy/deploy.sh（Linux）。
#
# 源码同步策略（BACKEND_SYNC）：
#   git  默认。远端仓库 git pull（要求已推送；.env 不会被碰）
#   tar  上传本地工作区（含未提交改动；保留远端 .env 与 FILE_ROOT 相对目录下的上传文件）
# 前端没有 git 仓库，固定用 tar 上传源码后替换目录。
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CONFIG_FILE="${DEPLOY_REMOTE_CONFIG:-$SCRIPT_DIR/deploy-remote.env}"

step() { printf '\n==> %s\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }
die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}
trap 'die "第 $LINENO 行执行失败，部署中止"' ERR

TARGETS=()
REMOTE_ARGS=()
for arg in "$@"; do
  case "$arg" in
    -h | --help)
      sed -n '2,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    all | backend | web | mobile) TARGETS+=("$arg") ;;
    *) REMOTE_ARGS+=("$arg") ;;
  esac
done
if (( ${#TARGETS[@]} == 0 )); then
  TARGETS=(all)
fi
# 去重（web mobile web -> web mobile）；出现 all 就只按 all 走
mapfile -t TARGETS < <(printf '%s\n' "${TARGETS[@]}" | awk '!seen[$0]++')
if printf '%s\n' "${TARGETS[@]}" | grep -qx all && (( ${#TARGETS[@]} > 1 )); then
  TARGETS=(all)
fi

if [[ -f "$CONFIG_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$CONFIG_FILE"
else
  die "缺少配置文件：$CONFIG_FILE（cp scripts/deploy/deploy-remote.env.example scripts/deploy/deploy-remote.env）"
fi

# ---- 配置项（deploy-remote.env 里覆盖）---------------------------------------
: "${REMOTE_HOST:?REMOTE_HOST 未配置}"
: "${REMOTE_USER:?REMOTE_USER 未配置}"
: "${REMOTE_PORT:=22}"
: "${SSH_OPTS:=-o BatchMode=yes -o ConnectTimeout=10}"

: "${REMOTE_APP_ROOT:=/opt/mentor}"
: "${REMOTE_BACKEND_DIR:=$REMOTE_APP_ROOT/mentor-back}"
: "${REMOTE_WEB_SRC:=$REMOTE_APP_ROOT/mentor-web}"
: "${REMOTE_MOBILE_SRC:=$REMOTE_APP_ROOT/mentor-mobile}"

: "${LOCAL_BACKEND_DIR:=$REPO_ROOT}"
: "${LOCAL_WEB_DIR:=$REPO_ROOT/../mentor-web}"
: "${LOCAL_MOBILE_DIR:=$REPO_ROOT/../mentor-mobile}"

: "${BACKEND_SYNC:=git}" # git | tar
: "${DEPLOY_MODE:=native}" # native（systemd + nginx 静态目录）| docker（compose）
: "${GIT_BRANCH:=$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)}"
: "${REMOTE_DEPLOY_CONFIG:=$REMOTE_BACKEND_DIR/scripts/deploy/deploy.env}"
: "${PUBLIC_WEB_URL:=}"
: "${PUBLIC_MOBILE_URL:=}"

# 远端参数里 --check 不做源码同步；--skip-build 时前端源码不必上传
CHECK_ONLY=0
SKIP_FRONTEND_SYNC=0
for arg in "${REMOTE_ARGS[@]}"; do
  case "$arg" in
    --check) CHECK_ONLY=1 ;;
    --skip-build) SKIP_FRONTEND_SYNC=1 ;;
  esac
done

require_local() {
  local cmd
  for cmd in ssh tar; do
    command -v "$cmd" >/dev/null 2>&1 || die "本地缺少命令：$cmd"
  done
}

SSH=(ssh -p "$REMOTE_PORT" ${SSH_OPTS} "$REMOTE_USER@$REMOTE_HOST")

remote() {
  # shellcheck disable=SC2029
  "${SSH[@]}" "$1"
}

check_local_dirs() {
  # --check 不同步源码；--skip-build 不传前端源码，都不需要本地前端目录
  (( CHECK_ONLY == 1 )) && return 0
  local target
  for target in "${TARGETS[@]}"; do
    case "$target" in
      all)
        if [[ "$BACKEND_SYNC" == "tar" ]]; then
          [[ -d "$LOCAL_BACKEND_DIR" ]] || die "后端源码不存在：$LOCAL_BACKEND_DIR"
        fi
        if (( SKIP_FRONTEND_SYNC == 0 )); then
          [[ -d "$LOCAL_WEB_DIR" ]] || die "管理端源码不存在：$LOCAL_WEB_DIR"
          [[ -d "$LOCAL_MOBILE_DIR" ]] || die "学生端源码不存在：$LOCAL_MOBILE_DIR"
        fi
        ;;
      backend)
        if [[ "$BACKEND_SYNC" == "tar" ]]; then
          [[ -d "$LOCAL_BACKEND_DIR" ]] || die "后端源码不存在：$LOCAL_BACKEND_DIR"
        fi
        ;;
      web)
        if (( SKIP_FRONTEND_SYNC == 0 )); then
          [[ -d "$LOCAL_WEB_DIR" ]] || die "管理端源码不存在：$LOCAL_WEB_DIR"
        fi
        ;;
      mobile)
        if (( SKIP_FRONTEND_SYNC == 0 )); then
          [[ -d "$LOCAL_MOBILE_DIR" ]] || die "学生端源码不存在：$LOCAL_MOBILE_DIR"
        fi
        ;;
    esac
  done
}

# 远端目录原子替换：先解到 .tmp，成功后 mv 旧目录到 .old 再 mv 新目录就位
# 远端 .env 与 .uploads（只在相对 FILE_ROOT 时存在）在替换后保留
sync_backend_tar() {
  [[ -d "$LOCAL_BACKEND_DIR" ]] || die "后端源码不存在：$LOCAL_BACKEND_DIR"
  step "同步后端源码（tar，保留远端 .env / .uploads / deploy.env）"
  tar -czf - -C "$LOCAL_BACKEND_DIR" \
    --exclude=node_modules --exclude=dist --exclude=.env --exclude=.env.test.local \
    --exclude=.uploads --exclude=coverage --exclude='*.log' \
    . | remote "set -e
      mkdir -p '$REMOTE_APP_ROOT'
      rm -rf '$REMOTE_BACKEND_DIR.tmp' '$REMOTE_BACKEND_DIR.old'
      mkdir -p '$REMOTE_BACKEND_DIR.tmp'
      tar -xzf - -C '$REMOTE_BACKEND_DIR.tmp'
      if [ -f '$REMOTE_BACKEND_DIR/.env' ]; then cp -p '$REMOTE_BACKEND_DIR/.env' '$REMOTE_BACKEND_DIR.tmp/.env'; fi
      if [ -d '$REMOTE_BACKEND_DIR/.uploads' ]; then cp -a '$REMOTE_BACKEND_DIR/.uploads' '$REMOTE_BACKEND_DIR.tmp/.uploads'; fi
      # 部署配置是服务器本地文件，源码里没有，必须原样带过去
      if [ -f '$REMOTE_BACKEND_DIR/scripts/deploy/deploy.env' ]; then
        mkdir -p '$REMOTE_BACKEND_DIR.tmp/scripts/deploy'
        cp -p '$REMOTE_BACKEND_DIR/scripts/deploy/deploy.env' '$REMOTE_BACKEND_DIR.tmp/scripts/deploy/deploy.env'
      fi
      if [ -f '$REMOTE_BACKEND_DIR/deploy/.env' ]; then
        mkdir -p '$REMOTE_BACKEND_DIR.tmp/deploy'
        cp -p '$REMOTE_BACKEND_DIR/deploy/.env' '$REMOTE_BACKEND_DIR.tmp/deploy/.env'
      fi
      if [ -d '$REMOTE_BACKEND_DIR' ]; then mv '$REMOTE_BACKEND_DIR' '$REMOTE_BACKEND_DIR.old'; fi
      mv '$REMOTE_BACKEND_DIR.tmp' '$REMOTE_BACKEND_DIR'
      rm -rf '$REMOTE_BACKEND_DIR.old'"
}

sync_backend_git() {
  step "同步后端源码（远端 git pull $GIT_BRANCH）"
  remote "set -e
    test -d '$REMOTE_BACKEND_DIR/.git' || { echo '远端不是 git 仓库；改用 BACKEND_SYNC=tar' >&2; exit 1; }
    git -C '$REMOTE_BACKEND_DIR' fetch --prune
    git -C '$REMOTE_BACKEND_DIR' checkout '$GIT_BRANCH'
    git -C '$REMOTE_BACKEND_DIR' pull --ff-only"
}

sync_frontend() {
  local label="$1" src="$2" dest="$3"
  [[ -d "$src" ]] || die "$label 源码不存在：$src"
  step "同步 $label 源码到 $dest"
  tar -czf - -C "$src" \
    --exclude=node_modules --exclude=dist --exclude=.env.local \
    . | remote "set -e
      mkdir -p '$REMOTE_APP_ROOT'
      rm -rf '$dest.tmp' '$dest.old'
      mkdir -p '$dest.tmp'
      tar -xzf - -C '$dest.tmp'
      if [ -d '$dest' ]; then mv '$dest' '$dest.old'; fi
      mv '$dest.tmp' '$dest'
      rm -rf '$dest.old'"
}

sync_sources() {
  local target
  for target in "${TARGETS[@]}"; do
    case "$target" in
      all)
        if [[ "$BACKEND_SYNC" == "git" ]]; then sync_backend_git; else sync_backend_tar; fi
        if (( SKIP_FRONTEND_SYNC == 0 )); then
          sync_frontend "管理端" "$LOCAL_WEB_DIR" "$REMOTE_WEB_SRC"
          sync_frontend "学生端" "$LOCAL_MOBILE_DIR" "$REMOTE_MOBILE_SRC"
        else
          warn "已跳过前端源码同步（--skip-build 使用远端已有 dist）"
        fi
        ;;
      backend)
        if [[ "$BACKEND_SYNC" == "git" ]]; then sync_backend_git; else sync_backend_tar; fi
        ;;
      web)
        if (( SKIP_FRONTEND_SYNC == 0 )); then
          sync_frontend "管理端" "$LOCAL_WEB_DIR" "$REMOTE_WEB_SRC"
        fi
        ;;
      mobile)
        if (( SKIP_FRONTEND_SYNC == 0 )); then
          sync_frontend "学生端" "$LOCAL_MOBILE_DIR" "$REMOTE_MOBILE_SRC"
        fi
        ;;
    esac
  done
}

main() {
  require_local
  check_local_dirs

  step "远端部署"
  printf '  目标：%s ｜ 主机：%s@%s:%s\n' "${TARGETS[*]}" "$REMOTE_USER" "$REMOTE_HOST" "$REMOTE_PORT"
  printf '  远端后端：%s ｜ 同步方式：%s ｜ 部署模式：%s\n' "$REMOTE_BACKEND_DIR" "$BACKEND_SYNC" "$DEPLOY_MODE"

  step "SSH 连通性检查"
  remote "echo '  ssh ok: '\$(hostname)"

  if (( CHECK_ONLY == 0 )); then
    sync_sources
  else
    warn "远端只做检查（--check），不同步源码"
  fi
  local deploy_cmd
  if [[ "$DEPLOY_MODE" == "docker" ]]; then
    deploy_cmd="cd '$REMOTE_BACKEND_DIR' && bash scripts/deploy/deploy-docker.sh ${TARGETS[*]}"
  elif [[ "$DEPLOY_MODE" == "native" ]]; then
    deploy_cmd="cd '$REMOTE_BACKEND_DIR' && DEPLOY_CONFIG='$REMOTE_DEPLOY_CONFIG' bash scripts/deploy/deploy.sh ${TARGETS[*]}"
  else
    die "DEPLOY_MODE 只能是 native 或 docker（当前：$DEPLOY_MODE）"
  fi
  if (( ${#REMOTE_ARGS[@]} > 0 )); then
    deploy_cmd="$deploy_cmd ${REMOTE_ARGS[*]}"
  fi
  step "执行远端部署（$DEPLOY_MODE）：$deploy_cmd"
  remote "$deploy_cmd"

  step "完成"
  printf '  远端部署结束。入口：\n'
  printf '    管理端 %s\n' "${PUBLIC_WEB_URL:-（按 nginx 配置的 admin 域名）}"
  printf '    学生端 %s\n' "${PUBLIC_MOBILE_URL:-（按 nginx 配置的移动端域名）}"
}

main "$@"