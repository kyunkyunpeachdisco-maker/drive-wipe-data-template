#!/usr/bin/env bash
# 台本の音声を VOICEVOX で作って、台本1本ごとに audio/ に保存する（Actions の make-audio から呼ばれる）。
# 対象は環境変数 KEY（と VOICE）か、なければ audio/request.txt の「台本の名前 [話者ID]」。
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
remake() { [ ! -f "scripts/$k.json" ] || node tools/make-audio.mjs "$k" "$v"; }

main() {   # 途中でこのファイルが入れ替わってもよいように、全体を読み込んでから動かす
# 依頼は上書きして書かれることがあるので、頼まれた時点のものと、最新のものの両方を対象にする
before=$(jobs_in_file)
sync_latest || { echo "::error::最新の取り込みに失敗しました"; exit 1; }
mkdir -p audio
all=$(printf '%s\n' "$before" "$(jobs_in_file)" | awk 'NF && !seen[$0]++')
echo "対象:"; echo "$all"
[ -z "$all" ] && exit 0
mapfile -t jobs <<< "$all"

docker run -d --name vv -p 50021:50021 voicevox/voicevox_engine:cpu-latest >/dev/null
for i in $(seq 90); do curl -sf http://127.0.0.1:50021/version >/dev/null && break; sleep 5; done
curl -sf http://127.0.0.1:50021/version >/dev/null || { echo "VOICEVOXが起動しませんでした"; docker logs vv | tail -20; exit 1; }

failed=0
for job in "${jobs[@]}"; do
  read -r k v <<< "$job"
  [ -f "scripts/$k.json" ] || { echo "台本がありません: $k"; continue; }
  remake || { echo "音声を作れませんでした: $k"; failed=1; }
  # ぶつかったときは、最新の台本で作り直す（できている音声はそのまま使われ、一覧だけ新しくなる）
  save_work "追加: 音声" remake audio || { echo "::error::保存（push）に失敗しました"; exit 1; }
done
exit $failed
}
main
