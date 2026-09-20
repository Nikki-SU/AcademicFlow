#!/usr/bin/env bash
# 给一个 Trae 任务开独立工作区（git worktree）
# ------------------------------------------------------------
# 背景：多个 Trae 会话的工作目录都是 /workspace。只要有一个任务习惯用
# `git add -A`，就会把**别的任务还没提交的改动**一起卷进它自己的 commit
# —— 2026-09-20 就发生过一次：一个 MinerU 任务的提交里装的全是 LaTeX 那条线的改动。
#
# 这个脚本把每个任务隔到自己的目录里：
#   · 独立目录 .worktrees/<任务名>/      —— 不在主工作区根上，别人的 add -A 扫不到
#   · 独立分支 <任务名>                  —— 互不抢 HEAD
#   · 软链 node_modules                  —— 不用重复装依赖
#
# 用法：
#   bash scripts/new-task-worktree.sh latex-pipeline
#   cd .worktrees/latex-pipeline        # 之后所有改动都在这里做
#
# 收工：
#   git worktree remove .worktrees/<任务名>     # 分支留着，下次还能用
set -euo pipefail

name="${1:-}"
if [ -z "$name" ]; then
  echo "用法：bash scripts/new-task-worktree.sh <任务名>" >&2
  echo "例：  bash scripts/new-task-worktree.sh latex-pipeline" >&2
  exit 1
fi

case "$name" in
  *[!a-zA-Z0-9._-]*)
    echo "任务名只能用字母、数字、点、下划线、连字符：$name" >&2
    exit 1
    ;;
esac

root="$(git rev-parse --show-toplevel)"
wt="$root/.worktrees/$name"

if [ -d "$wt" ]; then
  echo "已经存在，直接用：cd $wt"
  exit 0
fi

# 分支已存在（比如上次收工后保留着）就复用，否则基于当前 HEAD 新建
if git -C "$root" show-ref --quiet "refs/heads/$name"; then
  git -C "$root" worktree add "$wt" "$name"
else
  git -C "$root" worktree add "$wt" -b "$name"
fi

# worktree 是干净的 checkout，没有 node_modules；软链一份，tsc / vite 直接能跑
if [ -d "$root/node_modules" ] && [ ! -e "$wt/node_modules" ]; then
  ln -s "$root/node_modules" "$wt/node_modules"
fi

echo
echo "工作区已就绪：$wt"
echo "  · 分支        ：$name"
echo "  · 下一步      ：cd $wt"
echo "  · 收工（保留分支）：git worktree remove $wt"
echo "  · 收工（连分支一起删）：git worktree remove $wt && git branch -D $name"
