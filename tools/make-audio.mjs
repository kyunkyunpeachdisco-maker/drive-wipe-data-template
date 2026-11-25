// 台本の音声をVOICEVOXで作り、audio/ に置く（Node / 依存なし）
//
// 使い方: node tools/make-audio.mjs <台本の名前> <話者ID> [エンジンURL]
//   例:   node tools/make-audio.mjs BvjXJuwZZTg_0-3399 8
//   ふだんは Actions（.github/workflows/make-audio.yml）が、台本が保存されるたびに実行する。
//   PCで手元のVOICEVOXを使うこともできる（起動してから実行する）。
//         node tools/make-audio.mjs --voices [エンジンURL]
//   選べる声の一覧（話者IDと名前）を audio/voices.json に書く。アプリの設定の画面と、AIエージェントが読む。
//
// - すでにある音声は作り直さない（ファイル名が本文のハッシュなので、書き換えた発話だけ作る）
// - 同じ声・同じセリフの音声がほかの台本にあれば、作らずに写す（同じ動画の台本を作り足したときの実況など）
// - 台本から消えた発話の音声は片づける
// - アプリの保存形式に合わせる：16kHzモノラルのwav、index.json は {engine, voice, rate, style, title, items[]}

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync, copyFileSync } from "node:fs";
import { createHash } from "node:crypto";

if (process.argv[2] === "--voices") {
  const url = process.argv[3] || "http://127.0.0.1:50021";
  const voices = [];
  for (const sp of await (await fetch(`${url}/speakers`)).json())
    for (const st of sp.styles || []) voices.push({ id: st.id, name: `${sp.name}（${st.name}）`, speaker: sp.name, style: st.name });
  voices.sort((a, b) => a.id - b.id);
  mkdirSync("audio", { recursive: true });
  // 1行に1つ。差分が読みやすく、AIエージェントが名前で探しやすい
  writeFileSync("audio/voices.json", `{\n  "voices": [\n${voices.map(v => "    " + JSON.stringify(v)).join(",\n")}\n  ]\n}\n`);
  console.log(`声の一覧を書きました: ${voices.length}件`);
  process.exit(0);
}
const [key, speakerId, engineUrl = "http://127.0.0.1:50021"] = process.argv.slice(2);
if (!key || !speakerId) { console.error("使い方: node tools/make-audio.mjs <台本の名前> <話者ID> [エンジンURL]"); process.exit(1); }

const script = JSON.parse(readFileSync(`scripts/${key}.json`, "utf8"));
const lines = [...new Set(script.items.filter(it => it.line).map(it => it.line))];
const hash12 = text => createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12);

// 話者IDがこのエンジンにあるか確かめ、表示名を控える
const speakers = await (await fetch(`${engineUrl}/speakers`)).json();
let voiceName = "";
for (const sp of speakers) for (const st of sp.styles) if (String(st.id) === String(speakerId)) voiceName = `${sp.name}（${st.name}）`;
if (!voiceName) { console.error(`話者ID ${speakerId} は、このVOICEVOXにありません。`); process.exit(1); }
console.log(`台本: ${script.meta?.title || key} ／ 発話 ${lines.length}件 ／ 声: ${voiceName}`);

async function synth(text) {
  const q = await fetch(`${engineUrl}/audio_query?text=${encodeURIComponent(text)}&speaker=${speakerId}`, { method: "POST" });
  if (!q.ok) throw new Error(`audio_query ${q.status}`);
  const query = await q.json();
  query.speedScale = 1;
  query.outputSamplingRate = 16000;   // アプリと同じ。24kHzステレオのままだと台本1本で13MBを超える
  query.outputStereo = false;
  const s = await fetch(`${engineUrl}/synthesis?speaker=${speakerId}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(query)
  });
  if (!s.ok) throw new Error(`synthesis ${s.status}`);
  return Buffer.from(await s.arrayBuffer());
}

const dir = `audio/${key}/voicevox-${speakerId}`;
mkdirSync(dir, { recursive: true });
const items = [];
// ほかの台本の同じ声の置き場
const others = readdirSync("audio", { withFileTypes: true }).filter(d => d.isDirectory() && d.name !== key)
  .map(d => `audio/${d.name}/voicevox-${speakerId}`).filter(d => existsSync(d));
let made = 0, kept = 0, shared = 0;
for (const text of lines) {
  const h = hash12(text);
  if (existsSync(`${dir}/${h}.wav`)) kept++;
  else if (others.some(d => existsSync(`${d}/${h}.wav`))) {
    copyFileSync(`${others.find(d => existsSync(`${d}/${h}.wav`))}/${h}.wav`, `${dir}/${h}.wav`);
    shared++;
  } else {
    writeFileSync(`${dir}/${h}.wav`, await synth(text));
    made++;
    if (made % 10 === 0) console.log(`  ${made}件 作りました`);
  }
  items.push({ h, ext: "wav", enc: "file", rate: 0, text });
}
const want = new Set(items.map(x => `${x.h}.wav`));
let removed = 0;
for (const f of readdirSync(dir)) if (f.endsWith(".wav") && !want.has(f)) { unlinkSync(`${dir}/${f}`); removed++; }

let createdAt = new Date().toISOString();
if (!made && !shared && !removed) {
  try { createdAt = JSON.parse(readFileSync(`${dir}/index.json`, "utf8")).createdAt || createdAt; } catch {}
}
writeFileSync(`${dir}/index.json`, JSON.stringify({
  engine: "voicevox", voice: String(speakerId), voiceName, rate: "1", style: "",
  title: script.meta?.title || script.videoId, createdAt, items
}, null, 2) + "\n");
console.log(`完了: ${dir}（新しく ${made}件・ほかの台本から ${shared}件・そのまま ${kept}件・片づけ ${removed}件）`);
