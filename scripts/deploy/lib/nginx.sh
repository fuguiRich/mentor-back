#!/usr/bin/env bash
# nginx 安全操作（由 deploy.sh source）。
# 服务器上通常已经有别的项目在跑，这里的原则是：
#   1. 只写自己的文件（文件名带 mentor- 前缀 + 标记注释），不碰别人的配置；
#   2. 写之前先 `nginx -t` 确认现有配置合法；
#   3. 写之前检查 server_name 是否已被别的站点占用；
#   4. 写之后 `nginx -t`，失败立刻回滚并中止；
#   5. 全部成功才 reload。

NGINX_MARKER="# managed by mentor deploy"

nginx_cmd() {
  command -v nginx || return 1
}

nginx_test() {
  local bin
  bin="$(nginx_cmd)" || {
    warn "未安装 nginx，跳过配置检查"
    return 0
  }
  $SUDO "$bin" -t 2>&1
}

# 列出 nginx 当前的 (配置文件, server_name) 组合
# 同一个名字在同一个文件里出现两次（HTTP + HTTPS）是正常的，不算冲突
nginx_server_name_files() {
  $SUDO nginx -T 2>/dev/null | awk '
    /^# configuration file / {
      file = $0
      sub(/^# configuration file /, "", file)
      sub(/:$/, "", file)
      next
    }
    /^[[:space:]]*server_name[[:space:]]/ {
      for (i = 2; i <= NF; i++) {
        gsub(/;/, "", $i)
        if ($i != "" && $i != "_") print file "|" $i
      }
    }' | sort -u
}

# 检查目标域名是否已被别的配置文件占用
nginx_assert_unique_names() {
  local names existing conflicts=""
  names="$(printf '%s\n' "$@" | sed '/^$/d')"
  existing="$(nginx_server_name_files)"
  local name files
  while IFS= read -r name; do
    [[ -z "$name" || "$name" == "_" ]] && continue
    files="$(printf '%s\n' "$existing" | awk -F'|' -v n="$name" '$NF == n' | wc -l | tr -d ' ')"
    if (( files > 1 )); then
      conflicts="$conflicts $name"
    fi
  done <<<"$names"
  [[ -z "$conflicts" ]] ||
    die "server_name 已被多个配置文件占用：$conflicts（请先检查现有站点，避免覆盖别人的项目）"
}

# 写站点配置：备份 -> 写入 -> nginx -t -> 失败回滚
nginx_write_site() {
  local file="$1" content="$2" backup=""
  $SUDO mkdir -p "$(dirname "$file")"
  if [[ -f "$file" ]]; then
    backup="$file.bak.$(date +%Y%m%d%H%M%S)"
    $SUDO cp -p "$file" "$backup"
    info "已备份现有配置：$backup"
  fi
  printf '%s\n' "$content" | $SUDO tee "$file" >/dev/null
  if ! nginx_test; then
    if [[ -n "$backup" ]]; then
      $SUDO cp -p "$backup" "$file"
    else
      $SUDO rm -f "$file"
    fi
    die "nginx -t 失败，已回滚 $file"
  fi
  # 确认该文件真的被 nginx 加载（有的 nginx.conf 不 include conf.d）
  if ! $SUDO nginx -T 2>/dev/null | grep -qF "# configuration file $file"; then
    if [[ -n "$backup" ]]; then
      $SUDO cp -p "$backup" "$file"
    else
      $SUDO rm -f "$file"
    fi
    die "配置未被 nginx 加载：$file（检查主配置的 include 路径）"
  fi
  info "已写入：$file"
}

nginx_reload_safe() {
  if ! command -v nginx >/dev/null 2>&1; then
    warn "未安装 nginx，跳过 reload"
    return 0
  fi
  nginx_test || die "nginx 配置校验失败，未 reload"
  if [[ -n "${NGINX_RELOAD_CMD:-}" ]]; then
    # shellcheck disable=SC2086
    $NGINX_RELOAD_CMD
  else
    $SUDO systemctl reload nginx
  fi
  info "nginx 已 reload"
}