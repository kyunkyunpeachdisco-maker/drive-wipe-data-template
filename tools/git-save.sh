# Actions からの取り込みと保存（watch-requests.sh と audio-requests.sh が読み込んで使う）
BR=$(git symbolic-ref -q --short HEAD || echo "${GITHUB_REF_NAME:-}")
git config user.email "github-actions[bot]@users.noreply.github.com"
git config user.name "github-actions[bot]"

# 最新を取り込む。前の実行を待っていた実行は、依頼された時点の古い中身で始まるため
sync_latest() { git fetch -q origin "$BR" </dev/null && git merge -q --ff-only FETCH_HEAD; }

# save_work <メッセージ> <当て直しの命令> <保存するフォルダ…>
# ほかの保存とぶつかったら、最新の上に自分の成果物を置き直し、当て直しの命令（依頼を消すなど）を実行してから、もう一度保存する
save_work() {
  local msg=$1 redo=$2 base tip mine n; shift 2
  base=$(git rev-parse HEAD)
  git add -A -- "$@" || return 1
  git diff --cached --quiet && return 0
  git commit -q -m "$msg" || return 1
  mine=$(git rev-parse HEAD); tip=$base
  for n in 1 2 3 4 5 6 7 8; do
    git push -q origin "HEAD:refs/heads/$BR" </dev/null && return 0
    echo "保存（push）をやり直します（${n}回目）"
    sleep $((n * 3))
    git fetch -q origin "$BR" </dev/null || continue
    [ "$(git rev-parse FETCH_HEAD)" = "$tip" ] && continue   # ほかの保存とはぶつかっていない（通信の失敗など）
    tip=$(git rev-parse FETCH_HEAD)
    # 手元で動かしたとき、まだ送っていないほかのコミットを巻き戻さない
    [ -n "${GITHUB_ACTIONS:-}" ] || git merge-base --is-ancestor "$base" "$tip" || return 1
    git reset -q --keep "$tip" || return 1
    # 依頼のファイルは最新のほうを使う（足された依頼を消さないため）
    (set -o pipefail
     git diff -z --name-only --no-renames --diff-filter=d "$base" "$mine" -- . ':!*/request.txt' \
       | xargs -0 -r git checkout -q "$mine" --) || return 1
    "$redo"
    git add -A -- "$@" || return 1
    git diff --cached --quiet && return 0
    git commit -q -m "$msg" || return 1
  done
  return 1
}
