#!/usr/bin/env bash
# 台本の音声を VOICEVOX で作って audio/ に保存する（Actions の make-audio から呼ばれる）。
# 対象は環境変数 KEY（と VOICE）か、なければ audio/request.txt の「台本の名前 [話者ID]」。
set -u
DEF=$(node -e 'try{const s=JSON.parse(require("fs").readFileSync("avatar/settings.json","utf8"));process.stdout.write(String(s["player-voice-voicevox"]||""))}catch(e){}')
[ -z "$DEF" ] && DEF=8
if [ -n "${KEY:-}" ]; then
  echo "$KEY ${VOICE:-$DEF}" > /tmp/jobs.txt
else
  touch audio/request.txt 2>/dev/null || { mkdir -p audio; touch audio/request.txt; }
  grep -v '^\s*#' audio/request.txt | awk -v d="$DEF" 'NF{print $1, (NF>1?$2:d)}' > /tmp/jobs.txt || true
fi
echo "対象:"; cat /tmp/jobs.txt
[ -s /tmp/jobs.txt ] || exit 0

docker run -d --name vv -p 50021:50021 voicevox/voicevox_engine:cpu-latest >/dev/null
for i in $(seq 90); do curl -sf http://127.0.0.1:50021/version >/dev/null && break; sleep 5; done
curl -sf http://127.0.0.1:50021/version >/dev/null || { echo "VOICEVOXが起動しませんでした"; docker logs vv | tail -20; exit 1; }

failed=0
while read -r k v; do
  [ -f "scripts/$k.json" ] || { echo "台本がありません: $k"; continue; }
  node tools/make-audio.mjs "$k" "$v" || { echo "音声を作れませんでした: $k"; failed=1; }
done < /tmp/jobs.txt

git config user.email "github-actions[bot]@users.noreply.github.com"
git config user.name "github-actions[bot]"
git add audio
if git diff --cached --quiet; then
  echo "変更なし"
else
  git commit -q -m "追加: 音声"
  ok=0; for i in 1 2 3 4; do git push -q && { ok=1; break; }; git pull -q --rebase; done
  [ $ok = 1 ] || { echo "保存（push）に失敗しました"; exit 1; }
fi
exit $failed
