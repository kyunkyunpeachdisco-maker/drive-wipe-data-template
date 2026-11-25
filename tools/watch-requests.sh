#!/usr/bin/env bash
# videos/request.txt の依頼を上から順に片づけて、1件ごとに結果を保存する（Actions の watch-video から呼ばれる）。
# 依頼の書き方は .github/workflows/watch-video.yml の先頭。
# 必要な環境変数: GEMINI_API_KEY, YOUTUBE_API_KEY
set -u
REQ=videos/request.txt
HEADER="# 1行に1つ。終わった依頼は自動で消えます（書き方は .github/workflows/watch-video.yml の先頭）"
. tools/git-save.sh

# 依頼を配列 reqs に読む（外のコマンドを使わない。コマンドの失敗を「依頼なし」と取り違えて消さないため）
read_requests() {
  local l; reqs=()
  while IFS= read -r l || [ -n "$l" ]; do
    l=${l#"${l%%[![:space:]]*}"}; l=${l%"${l##*[![:space:]]}"}
    case "$l" in ''|'#'*) ;; *) reqs+=("$l") ;; esac
  done < "$REQ"
}
# 終わった依頼（$done_line）を、いまの request.txt から消す。ほかの依頼は残す
done_line=""
drop_done() {
  [ -n "$done_line" ] && [ -f "$REQ" ] || return 0
  local l; read_requests
  { echo "$HEADER"; for l in "${reqs[@]}"; do [ "$l" = "$done_line" ] || printf '%s\n' "$l"; done; } > "$REQ"
}
save() {
  drop_done
  local dirs=(videos); [ -d articles ] && dirs+=(articles)
  # Actions 自身の保存では、ワークフローは再び動かない
  save_work "追加: 台本の材料（記事・映像の記録）" drop_done "${dirs[@]}" && return 0
  echo "::error::保存（push）に失敗しました"; exit 1
}

main() {   # 途中でこのファイルが入れ替わってもよいように、全体を読み込んでから動かす
sync_latest || { echo "::error::最新の取り込みに失敗しました"; exit 1; }
mkdir -p videos; touch "$REQ"
# YouTube の決まりで、動画の題などは30日までしか取っておけない。過ぎる前に取り直す（依頼がなくても毎日見る）
refresh_meta() { node tools/refresh-meta.mjs; }
if refresh_meta; then
  dirs=(videos); [ -d scripts ] && dirs+=(scripts)
  save_work "更新: 動画の題など（YouTube の決まりによる取り直し）" refresh_meta "${dirs[@]}" || echo "::warning::動画の題の保存に失敗しました（次の実行でやり直します）"
fi
read_requests; lines=("${reqs[@]}")
echo "依頼: ${#lines[@]}件"; printf '%s\n' "${lines[@]}"
[ ${#lines[@]} = 0 ] && exit 0

[ -n "${GEMINI_API_KEY:-}" ] || echo "::warning::Secrets に GEMINI_API_KEY がありません（動画の記録に要ります）"
[ -n "${YOUTUBE_API_KEY:-}" ] || echo "::warning::Secrets に YOUTUBE_API_KEY がありません（動画の長さと候補探しに要ります）"

node tools/fetch-articles.mjs || echo "記事の取り込みは失敗しました（動画の記録は続けます）"
save
failed=0; left=0
for l in "${lines[@]}"; do
  set -f; set -- $l; set +f
  echo "::group::$l"
  rc=0
  if [ "$1" = "記事" ]; then
    shift
    [ $# -gt 0 ] && { ARTICLE_URLS="$*" node tools/fetch-articles.mjs || rc=$?; }
  elif [ "$1" = "候補" ]; then
    shift
    LIST_ONLY=true QUERY="$*" node tools/watch-video.mjs || rc=$?
  else
    VIDEO_URL="$1" MINUTES="${2:-}" node tools/watch-video.mjs || rc=$?
  fi
  echo "::endgroup::"
  done_line="$l"
  case $rc in
    0) echo "済み: $l" ;;
    2) echo "運転者や話し声が入っている動画のため取りやめました: $l" ;;
    3) echo "途中まで（続きは次の実行で）: $l"; done_line="" ;;
    5) echo "読めない記事がありました（依頼は終わりにします）: $l"; failed=1 ;;
    6) echo "::error::何度やっても成功しない依頼なので、終わりにします（理由は上のログ）: $l"; failed=1 ;;
    *) echo "失敗しました: $l"; done_line=""; failed=1; left=1 ;;
  esac
  save
done

if [ $failed = 1 ]; then
  echo "うまくいかなかった依頼があります。上のログを見てください。"
  [ $left = 1 ] && echo "「失敗しました」の依頼は $REQ に残っていて、次の実行でやり直します。"
  exit 1
fi
exit 0
}
main
