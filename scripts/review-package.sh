#!/usr/bin/env bash
# 评审包拼装器：内容基线 + 工作树 → unified diff 评审包。不需要 git，也不需要 commit。
#
# 存在的理由是一个具体的账单：
#   `scripts/review-package`（superpowers 技能自带）要 `git rev-parse` 一个 commit 区间。
#   本仓库提交由用户自理，在有 commit 之前那条路走不通；零 commit 时代的临时做法是
#   `print-files.sh` 整文件 `cat` —— 单包 20–136 KB，16 个评审包吃掉工作区 62% 的字节。
#   而评审包是**坐在评审者常驻上下文里**的：一个 37k 的包 × 几十轮 × 十几个评审者，
#   纯重发就是千万级 token。整文件是这项浪费的根。
#
# 本工具的做法：派发实现者**之前**打一份内容基线，报告回来后与工作树比对，
# 产出 `diff -U10` 的评审包。改动行一行不少（含 10 行上下文），新增/删除文件也走 diff
# （新增文件的全文就是它的 diff，没有额外特例）。**未改动的区域不进包**——
# 评审者要看完整上下文就直接 Read 那个文件；包头会列出每个路径，保证不漏。
#
# 用法：
#   review-package.sh snap <基线目录>            # 派发实现者之前
#   review-package.sh pack <基线目录> <输出.md>   # 实现者报告回来之后
#
# 路径按调用者的 cwd 解析（本脚本会 cd 到仓库根，所以先把相对路径转成绝对）。
# 基线目录请放在工作区（`.superpowers/sdd/<plan>/...`），不要放仓库根——
# 那既污染它要守护的工作树，又会被用户提交进去（踩过一次）。
#
# 性能注记：比对走**整树哈希**（md5sum 批量），不走逐文件 cmp/stat。
# 逐文件在 Windows/MSYS 上要上千次进程创建，158 个文件能跑上一分钟；
# 这条是实测踩出来的，不要改回去。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MARKER='.review-package-baseline'

# 扫描面。凡是不在清单里的东西，基于清单的检查都会假装它不存在——
# scripts/ 在 2026-10-14 之前不在清单里，于是「scripts/ 零触碰」这类结论**无法被证明**
# （见 snapshot-mtimes.sh 的头注释 / 发现 34）。加目录时记得同步那份清单。
PATHS=(src test prisma docs scripts)
ROOTFILES=(
  package.json
  pnpm-lock.yaml
  eslint.config.mjs
  tsconfig.json
  tsconfig.build.json
  nest-cli.json
  .prettierrc
  README.md
  .env.example
)

die() {
  printf 'review-package: %s\n' "$*" >&2
  exit 2
}

usage() {
  cat >&2 <<'EOF'
用法：
  review-package.sh snap <基线目录>            # 派发实现者之前
  review-package.sh pack <基线目录> <输出.md>   # 实现者报告回来之后
EOF
  exit 2
}

# 相对路径按调用者的 cwd 解析。必须在 cd "$ROOT" **之前**调用。
abspath() {
  case "$1" in
    /* | [A-Za-z]:[/\\]*) printf '%s\n' "$1" ;;
    *) printf '%s\n' "$PWD/$1" ;;
  esac
}

# 从**当前目录**（仓库根或基线根）列出扫描面内的文件，相对路径，无序。
list_files() {
  local p
  for p in "${PATHS[@]}"; do
    if [ -d "$p" ]; then
      find "$p" -type f -not -path '*/node_modules/*' -not -path '*/dist/*'
    fi
  done
  for p in "${ROOTFILES[@]}"; do
    if [ -f "$p" ]; then
      printf '%s\n' "$p"
    fi
  done
}

# 批量哈希：`<md5><TAB><路径>`，一行一个。xargs 分批，进程数与文件数无关。
# md5sum 的分隔是「两空格」或「一空格 + `*`」（binary 标记），两种情况文件名都从
# 第 35 列起。不统一切掉的话，`*` 会被吃进路径里，后面的 comm / diff 全部对不上
# （踩过一次：改动文件被判成 `*scripts/x.ts`，diff 空、mtime 过滤失效）。
hash_list() {
  list_files | LC_ALL=C sort -u | tr '\n' '\0' | xargs -0 -r -n 64 md5sum |
    awk '{ p = substr($0, 35); sub(/^\*/, "", p); print substr($0, 1, 32) "\t" p }'
}

# 批量 mtime：`整数秒<TAB>路径`。find 的 %T@ 带小数、两边可能截断不一致——
# 统一砍到整数秒，与 snapshot-mtimes.sh 的 normalize 同一口径。
mtime_list() {
  local p
  for p in "${PATHS[@]}"; do
    if [ -d "$p" ]; then
      find "$p" -type f -not -path '*/node_modules/*' -not -path '*/dist/*' -printf '%T@\t%p\n'
    fi
  done
  for p in "${ROOTFILES[@]}"; do
    if [ -f "$p" ]; then
      printf '%s\t%s\n' "$(stat -c %Y "$p" 2>/dev/null || echo 0)" "$p"
    fi
  done
  :
}

normalize_mtime() {
  awk -F'\t' 'NF==2 { split($1, a, "."); print a[1] "\t" $2 }'
}

# 拒绝把基线写到会伤到工作树的地方：盘根、仓库根、以及扫描面之内。
# 扫描面之外一律放行——工作区 `.superpowers/sdd/<plan>/` 就在 ROOT 下但不在扫描面里。
assert_safe_base() {
  local base="$1" p
  [ -n "$base" ] || die '基线目录为空'
  case "$base" in
    / | [A-Za-z]:) die "拒绝把基线写到 $base" ;;
    "$ROOT") die "拒绝把基线写到仓库根 $base" ;;
  esac
  for p in "${PATHS[@]}"; do
    case "$base" in
      "$ROOT/$p" | "$ROOT/$p"/*) die "拒绝把基线写进扫描面 $base" ;;
    esac
  done
}

cmd_snap() {
  local base n files
  base="$(abspath "${1:?缺基线目录（见 usage）}")"
  assert_safe_base "$base"

  # 只有本工具自己写的基线才允许被覆盖。防的是「传错目录 → rm -rf 别人的东西」。
  if [ -d "$base" ] && [ ! -f "$base/$MARKER" ]; then
    die "目录已存在且不是本工具的基线（缺少 $MARKER）：$base"
  fi

  rm -rf "$base"
  mkdir -p "$base"
  printf 'review-package baseline\n' >"$base/$MARKER"

  cd "$ROOT"
  # cp --parents 保留相对目录结构；-n 64 分批——逐文件 cp 在 Windows/MSYS 上
  # 158 个文件要 22 秒，分批后是三次进程创建。
  # -p 保留 mtime，供 pack 识别「内容没变但有进程写过它」。
  files=()
  mapfile -t files < <(list_files | LC_ALL=C sort -u)
  n="${#files[@]}"
  if [ "$n" -gt 0 ]; then
    printf '%s\0' "${files[@]}" | xargs -0 -r -n 64 cp -p --parents -t "$base"
  fi

  printf 'WROTE %s  (%s files)\n' "$base" "$n"
}

cmd_pack() {
  local base out tmp n
  base="$(abspath "${1:?缺基线目录（见 usage）}")"
  out="$(abspath "${2:?缺输出文件（见 usage）}")"
  [ -f "$base/$MARKER" ] || die "不是本工具的基线（缺少 $MARKER）：$base"

  tmp="$(mktemp -d)"
  # 双引号让 $tmp **此刻**展开：trap 在函数返回后才触发，那时 local tmp 已经出域
  # （单引号会等触发时再展开，结果是 `set -u` 下的 unbound variable）。
  trap "rm -rf '$tmp'" EXIT

  cd "$ROOT"

  # ---- 清单：新增 / 删除 ----
  list_files | LC_ALL=C sort -u >"$tmp/now"
  (cd "$base" && find . -type f -not -name "$MARKER") |
    sed 's|^\./||' | LC_ALL=C sort -u >"$tmp/old"
  comm -23 "$tmp/now" "$tmp/old" >"$tmp/added"
  comm -13 "$tmp/now" "$tmp/old" >"$tmp/deleted"
  comm -12 "$tmp/now" "$tmp/old" >"$tmp/common"

  # ---- 内容：整树哈希，两侧各一次 ----
  (cd "$base" && hash_list) | LC_ALL=C sort -k2,2 >"$tmp/oldhash"
  hash_list | LC_ALL=C sort -k2,2 >"$tmp/newhash"

  : >"$tmp/changed"
  awk 'NR==FNR { h[$2]=$1; next } ($2 in h) && h[$2]!=$1 { print $2 }' \
    "$tmp/oldhash" "$tmp/newhash" | LC_ALL=C sort -u >"$tmp/changed"

  # ---- mtime：内容没变但被写过（典型：pnpm lint 的 --fix 重写）----
  : >"$tmp/mtimeonly"
  (cd "$base" && mtime_list | normalize_mtime) | LC_ALL=C sort -k2,2 >"$tmp/oldmt"
  (mtime_list | normalize_mtime) | LC_ALL=C sort -k2,2 >"$tmp/newmt"
  awk 'NR==FNR { t[$2]=$1; next } ($2 in t) && t[$2]!=$1 { print $2 }' \
    "$tmp/oldmt" "$tmp/newmt" | LC_ALL=C sort -u >"$tmp/mtimeall"
  # 只保留「内容没变」的那部分——内容变了的已经在 changed 里，不重复列
  comm -23 "$tmp/mtimeall" "$tmp/changed" >"$tmp/mtimeonly"

  # ---- 产出 ----
  cat "$tmp/added" "$tmp/deleted" "$tmp/changed" | LC_ALL=C sort -u >"$tmp/difforder"

  {
    printf '# Review package\n\n'
    printf -- '- 基线：`%s`\n' "$base"
    printf -- '- 生成时间：%s\n' "$(date '+%Y-%m-%d %H:%M:%S')"
    printf -- '- 形态：unified diff（-U10）。**未改动的区域不在本包内**——'
    printf '要看某文件的完整上下文，直接 Read 它；下面每个路径都可打开。\n\n'

    printf '## Files changed\n\n'
    if [ ! -s "$tmp/difforder" ]; then
      printf '（无内容改动）\n'
    else
      printf '```\n'
      # printf 要带 `--`：`- 删除…` 会被当成选项（踩过一次，包写到一半断掉）。
      while IFS= read -r f; do [ -n "$f" ] && printf -- '+ 新增  %s\n' "$f"; done <"$tmp/added"
      while IFS= read -r f; do [ -n "$f" ] && printf -- '- 删除  %s\n' "$f"; done <"$tmp/deleted"
      while IFS= read -r f; do [ -n "$f" ] && printf -- '~ 改动  %s\n' "$f"; done <"$tmp/changed"
      printf '```\n'
    fi

    if [ -s "$tmp/mtimeonly" ]; then
      printf '\n## 仅 mtime 变化（内容未变）\n\n'
      printf '下列文件被写过但内容一致——典型是 `pnpm lint`（带 `--fix`）的重写。\n'
      printf '不影响代码，但**谁在未申报的情况下写了文件**这件事必须看得见。\n\n```\n'
      cat "$tmp/mtimeonly"
      printf '```\n'
    fi

    printf '\n## Diff\n'
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      printf '\n### `%s`\n\n```diff\n' "$f"
      if [ -f "$base/$f" ] && [ -f "$f" ]; then
        diff -U10 --label "a/$f" --label "b/$f" "$base/$f" "$f" || true
      elif [ -f "$f" ]; then
        diff -U10 --label "a/$f" --label "b/$f" /dev/null "$f" || true
      else
        diff -U10 --label "a/$f" --label "b/$f" "$base/$f" /dev/null || true
      fi
      printf '```\n'
    done <"$tmp/difforder"
  } >"$out"

  n="$(wc -l <"$tmp/difforder" | tr -d ' ')"
  printf 'wrote %s: %s file(s) changed, %s bytes\n' \
    "$out" "$n" "$(wc -c <"$out" | tr -d ' ')"
}

case "${1:-}" in
  snap) shift; cmd_snap "$@" ;;
  pack) shift; cmd_pack "$@" ;;
  *) usage ;;
esac
