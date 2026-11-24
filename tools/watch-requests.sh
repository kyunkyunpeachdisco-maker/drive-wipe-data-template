#!/usr/bin/env bash
# videos/request.txt の依頼を上から順に片づけて、結果を保存する（Actions の watch-video から呼ばれる）。
# 依頼の書き方は .github/workflows/watch-video.yml の先頭。
# 必要な環境変数: GEMINI_API_KEY, YOUTUBE_API_KEY
set -u
REQ=videos/request.txt
HEADER="# 1行に1つ。終わった依頼は自動で消えます（書き方は .github/workflows/watch-video.yml の先頭）"

mkdir -p videos; touch "$REQ"
n=$(grep -v '^\s*#' "$REQ" | grep -c '\S' || true)
echo "依頼: ${n}件"; grep -v '^\s*#' "$REQ" | grep '\S' || true
[ "$n" = "0" ] && exit 0

[ -n "${GEMINI_API_KEY:-}" ] || echo "::warning::Secrets に GEMINI_API_KEY がありません（動画の記録に要ります）"
[ -n "${YOUTUBE_API_KEY:-}" ] || echo "::warning::Secrets に YOUTUBE_API_KEY がありません（動画の長さと候補探しに要ります）"

node tools/fetch-articles.mjs || echo "記事の取り込みは失敗しました（動画の記録は続けます）"
keep=""; failed=0
while IFS= read -r line || [ -n "$line" ]; do
  l=$(echo "$line" | sed 's/^\s*//; s/\s*$//')
  case "$l" in ''|'#'*) continue ;; esac
  set -- $l
  echo "::group::$l"
  rc=0
  if [ "$1" = "記事" ]; then
    :
  elif [ "$1" = "候補" ]; then
    shift
    LIST_ONLY=true QUERY="$*" node tools/watch-video.mjs || rc=$?
  else
    VIDEO_URL="$1" MINUTES="${2:-}" node tools/watch-video.mjs || rc=$?
  fi
  echo "::endgroup::"
  case $rc in
    0) echo "済み: $l" ;;
    2) echo "運転者や話し声が入っている動画のため取りやめました: $l" ;;
    3) echo "途中まで（続きは次の実行で）: $l"; keep="$keep$l"$'\n' ;;
    *) echo "失敗しました: $l"; keep="$keep$l"$'\n'; failed=1 ;;
  esac
done < "$REQ"
{ echo "$HEADER"; printf '%s' "$keep"; } > "$REQ"

git config user.email "github-actions[bot]@users.noreply.github.com"
git config user.name "github-actions[bot]"
git add videos
[ -d articles ] && git add articles
if git diff --cached --quiet; then
  echo "変更なし"
else
  git commit -q -m "追加: 台本の材料（記事・映像の記録）"
  # Actions 自身の保存では、ワークフローは再び動かない
  ok=0; for i in 1 2 3 4; do git push -q && { ok=1; break; }; git pull -q --rebase; done
  [ $ok = 1 ] || { echo "保存（push）に失敗しました"; exit 1; }
fi

if [ $failed = 1 ]; then
  echo "失敗した依頼があります。上のログを見てください。失敗した依頼は $REQ に残っています。"
  exit 1
fi
