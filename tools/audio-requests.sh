#!/usr/bin/env bash
# 台本の音声を VOICEVOX で作って、台本1本ごとに audio/ に保存する（Actions の make-audio から呼ばれる）。
# 対象は環境変数 KEY（と VOICE）か、なければ audio/request.txt の「台本の名前 [話者ID]」。
# 台本の名前の代わりに talks と書けば、広告のあいだの小話（talks/index.json）の声を作る。
# 台本の声を作ったときは、同じ声で小話の声も作る（もうあるものは作らない）。
# 動くたびに、選べる声の一覧を audio/voices.json に書く。request.txt に「声の一覧」とだけ書けば、一覧だけを作る。
set -u
. tools/git-save.sh

jobs_in_file() {
  local def
  def=$(node -e 'try{const s=JSON.parse(require("fs").readFileSync("avatar/settings.json","utf8"));process.stdout.write(String(s["player-voice-voicevox"]||""))}catch(e){}')
  [ -z "$def" ] && def=8
  if [ -n "${KEY:-}" ]; then
    echo "$KEY ${VOICE:-$def}"
  elif [ -f audio/request.txt ]; then
    tr -d '\r' < audio/request.txt | grep -v '^\s*#' | awk -v d="$def" 'NF{print $1, (NF>1?$2:d)}'
  fi
}
src_of() { [ "$1" = talks ] && echo talks/index.json || echo "scripts/$1.json"; }
remake() { [ ! -f "$(src_of "$k")" ] || node tools/make-audio.mjs "$k" "$v"; }

main() {   # 途中でこのファイルが入れ替わってもよいように、全体を読み込んでから動かす
# 依頼は上書きして書かれることがあるので、頼まれた時点のものと、最新のものの両方を対象にする
before=$(jobs_in_file)
sync_latest || { echo "::error::最新の取り込みに失敗しました"; exit 1; }
mkdir -p audio
all=$(printf '%s\n' "$before" "$(jobs_in_file)" | awk 'NF && !seen[$0]++')
echo "対象:"; echo "$all"
[ -z "$all" ] && exit 0
# 小話も、頼まれた台本と同じ声でそろえる
if [ -f talks/index.json ]; then
  all=$(printf '%s
' "$all" "$(echo "$all" | awk '$1 != "声の一覧" { print "talks", $2 }')" | awk 'NF && !seen[$0]++')
fi
mapfile -t jobs <<< "$all"

docker run -d --name vv -p 50021:50021 voicevox/voicevox_engine:cpu-latest >/dev/null
for i in $(seq 90); do curl -sf http://127.0.0.1:50021/version >/dev/null && break; sleep 5; done
curl -sf http://127.0.0.1:50021/version >/dev/null || { echo "VOICEVOXが起動しませんでした"; docker logs vv | tail -20; exit 1; }

voices() { node tools/make-audio.mjs --voices; }
voices && save_work "更新: 声の一覧" voices audio || echo "声の一覧を保存できませんでした（声づくりは続けます）"

failed=0
for job in "${jobs[@]}"; do
  read -r k v <<< "$job"
  [ "$k" = "声の一覧" ] && continue
  [ -f "$(src_of "$k")" ] || { echo "台本がありません: $k"; continue; }
  remake || { echo "音声を作れませんでした: $k"; failed=1; }
  # ぶつかったときは、最新の台本で作り直す（できている音声はそのまま使われ、一覧だけ新しくなる）
  save_work "追加: 音声" remake audio || { echo "::error::保存（push）に失敗しました"; exit 1; }
done
exit $failed
}
main
