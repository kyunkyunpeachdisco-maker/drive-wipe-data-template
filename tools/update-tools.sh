#!/usr/bin/env bash
# 道具（tools/ と 台本の書き方.md）を、公開リポジトリ drive-wipe の data-template/ の最新に入れ替える。
#   bash tools/update-tools.sh              道具だけ（Actions の update-tools が毎週これを行う）
#   bash tools/update-tools.sh --workflows  .github/workflows/ も入れ替える（AIエージェントに頼むとき）
# Actions からはワークフローのファイルを書き換えられないため、ワークフローの更新は AIエージェントの仕事。
# 入れ替えたあとの保存（commit / push）は呼んだ側が行う。
set -eu
SRC_REPO="${TEMPLATE_REPO:-kyunkyunpeachdisco-maker/drive-wipe}"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -sfL "https://codeload.github.com/${SRC_REPO}/tar.gz/HEAD" | tar xz -C "$tmp" --strip-components=1
src="$tmp/data-template"
[ -d "$src/tools" ] || { echo "ひな形を取得できませんでした: $SRC_REPO"; exit 1; }

rm -rf tools
cp -r "$src/tools" tools
cp "$src/台本の書き方.md" 台本の書き方.md
# ひな形そのものでは、案内も新しくする（使う人のリポジトリでは、書き換えられていてもよいように触らない）
case "${GITHUB_REPOSITORY:-}" in */drive-wipe-data-template) cp "$src/README.md" "$src/CLAUDE.md" . ;; esac

stale=""
for f in "$src"/.github/workflows/*.yml; do
  name=$(basename "$f")
  cmp -s "$f" ".github/workflows/$name" && continue
  if [ "${1:-}" = "--workflows" ]; then
    mkdir -p .github/workflows; cp "$f" ".github/workflows/$name"; echo "入れ替えました: .github/workflows/$name"
  else
    stale="$stale $name"
  fi
done
echo "道具を最新にしました（$SRC_REPO）"
if [ -n "$stale" ]; then
  echo "::notice::ワークフローに更新があります:${stale}。AIエージェントに「道具を更新して」と頼むと入れ替わります。"
fi
