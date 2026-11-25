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
//
// 読みを直す（台本の書き方.md「読みを直す」）
// - セリフに {表記|よみ} と書くと、台本の say に読みが入る。声は say を読む
// - audio/読み辞書.txt に「表記 よみ [アクセント]」を書くと、どの台本でもその読みになる
//     行って いって          … よみだけ：声を作る前に、文を書き換える
//     七里ヶ浜 シチリガハマ 4  … アクセント（高く読む最後の音が何音目か。0は平ら）付き：VOICEVOX の辞書に入れる
// - 読みが変わった発話は、ファイル名（字幕のハッシュ）が同じでも作り直す。index.json の items[].yomi に、作ったときの読みを控える
// - 作るたびに、全部の発話の読み（VOICEVOX がどう読むつもりか）を 読み.txt に書く。読み違いはこれで見つける

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

// talks は、広告のあいだに話す小話（talks/index.json）。台本と同じに扱う
const script = key === "talks"
  ? { meta: { title: "広告のあいだの小話" }, items: JSON.parse(readFileSync("talks/index.json", "utf8")).talks.flatMap(t => t.lines) }
  : JSON.parse(readFileSync(`scripts/${key}.json`, "utf8"));
// 字幕ごとに、読む文（say があればそれ）
const sayOf = new Map();
for (const it of script.items) if (it.line && !sayOf.has(it.line)) sayOf.set(it.line, it.say || it.line);
const lines = [...sayOf.keys()];
const hash12 = text => createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12);

// 話者IDがこのエンジンにあるか確かめ、表示名を控える
const speakers = await (await fetch(`${engineUrl}/speakers`)).json();
let voiceName = "";
for (const sp of speakers) for (const st of sp.styles) if (String(st.id) === String(speakerId)) voiceName = `${sp.name}（${st.name}）`;
if (!voiceName) { console.error(`話者ID ${speakerId} は、このVOICEVOXにありません。`); process.exit(1); }
console.log(`台本: ${script.meta?.title || key} ／ 発話 ${lines.length}件 ／ 声: ${voiceName}`);

// 読み辞書
const kata = s => s.replace(/[ぁ-ゖ]/g, c => String.fromCharCode(c.charCodeAt(0) + 0x60));
const dict = [], dictBad = [];
if (existsSync("audio/読み辞書.txt")) {
  for (const [i, raw] of readFileSync("audio/読み辞書.txt", "utf8").split(/\r?\n/).entries()) {
    const l = raw.replace(/#.*/, "").trim();
    if (!l) continue;
    const [surface, yomi, acc, ...rest] = l.split(/[\s　]+/);
    if (!yomi || rest.length || (acc !== undefined && !/^\d+$/.test(acc))) { dictBad.push(`${i + 1}行目: 「表記 よみ [アクセント]」の形になっていません → ${l}`); continue; }
    if (acc !== undefined && !/^[ァ-ヶー]+$/.test(kata(yomi))) { dictBad.push(`${i + 1}行目: アクセントを書くときは、よみをカナだけで書きます → ${l}`); continue; }
    dict.push({ surface, yomi, acc: acc === undefined ? null : +acc });
  }
}
for (const e of dictBad) console.error("読み辞書 " + e);
dict.sort((a, b) => b.surface.length - a.surface.length);   // 長い言葉を先に
const plain = dict.filter(e => e.acc === null), accented = dict.filter(e => e.acc !== null);
// 読む文と、作り直すかを決める控え（読む文＋効いているアクセント）
function spoken(text) {
  let s = sayOf.get(text) || text;
  for (const e of plain) s = s.split(e.surface).join(e.yomi);
  const acc = accented.filter(e => s.includes(e.surface)).map(e => `${e.surface}=${kata(e.yomi)}${e.acc}`);
  return { say: s, yomi: s + (acc.length ? "／" + acc.join("、") : "") };
}
const dictIds = [];
for (const e of accented) {
  const r = await fetch(`${engineUrl}/user_dict_word?surface=${encodeURIComponent(e.surface)}&pronunciation=${encodeURIComponent(kata(e.yomi))}&accent_type=${e.acc}&priority=10`, { method: "POST" });
  if (r.ok) dictIds.push(await r.json());
  else console.error(`読み辞書: 「${e.surface}」を入れられませんでした（${r.status} ${(await r.text()).slice(0, 120)}）`);
}
// 手元の VOICEVOX を使ったときに、辞書を残さない
async function dictClear() { for (const id of dictIds.splice(0)) await fetch(`${engineUrl}/user_dict_word/${id}`, { method: "DELETE" }).catch(() => {}); }

async function query(text) {
  const q = await fetch(`${engineUrl}/audio_query?text=${encodeURIComponent(text)}&speaker=${speakerId}`, { method: "POST" });
  if (!q.ok) throw new Error(`audio_query ${q.status}`);
  return q.json();
}
async function synth(text) {
  const q = await query(text);
  q.speedScale = 1;
  q.outputSamplingRate = 16000;   // アプリと同じ。24kHzステレオのままだと台本1本で13MBを超える
  q.outputStereo = false;
  const s = await fetch(`${engineUrl}/synthesis?speaker=${speakerId}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(q)
  });
  if (!s.ok) throw new Error(`synthesis ${s.status}`);
  return Buffer.from(await s.arrayBuffer());
}

const dir = `audio/${key}/voicevox-${speakerId}`;
mkdirSync(dir, { recursive: true });
const items = [];
// 前に作ったときの読み（ファイル名 → 読み）。読みを控えていない古い音声は、字幕のとおりに読んだもの
const yomiIn = d => {
  try { return new Map(JSON.parse(readFileSync(`${d}/index.json`, "utf8")).items.map(x => [x.h, x.yomi || x.text])); } catch (e) { return new Map(); }
};
const yomiHere = yomiIn(dir);
// ほかの台本の同じ声の置き場
const others = readdirSync("audio", { withFileTypes: true }).filter(d => d.isDirectory() && d.name !== key)
  .map(d => `audio/${d.name}/voicevox-${speakerId}`).filter(d => existsSync(d));
const yomiOthers = new Map(others.map(d => [d, yomiIn(d)]));
let made = 0, kept = 0, shared = 0, reread = 0;
const readings = [];
try {
  for (const text of lines) {
    const h = hash12(text), { say, yomi } = spoken(text);
    const same = d => existsSync(`${d}/${h}.wav`) && (d === dir ? yomiHere : yomiOthers.get(d)).get(h) === yomi;
    const from = others.find(same);
    if (same(dir)) kept++;
    else if (from) {
      copyFileSync(`${from}/${h}.wav`, `${dir}/${h}.wav`);
      shared++;
    } else {
      if (existsSync(`${dir}/${h}.wav`)) reread++;
      writeFileSync(`${dir}/${h}.wav`, await synth(say));
      made++;
      if (made % 10 === 0) console.log(`  ${made}件 作りました`);
    }
    items.push({ h, ext: "wav", enc: "file", rate: 0, text, ...(yomi !== text ? { yomi } : {}) });
    // VOICEVOX が読むつもりのカナ。' のすぐ前の音が高い。/ と 、 は区切り
    readings.push(`${text}\n    ${(await query(say)).kana}`);
  }
} finally { await dictClear(); }
writeFileSync(`${dir}/読み.txt`, `# ${script.meta?.title || key} の読み（${voiceName}）。tools/make-audio.mjs が書く。手で直さない\n# 各セリフの下が、VOICEVOX の読み。' のすぐ前の音が高く、そのあと下がる。/ と 、 は区切り\n\n${readings.join("\n")}\n`);
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
console.log(`完了: ${dir}（新しく ${made}件（読みを直した ${reread}件を含む）・ほかの台本から ${shared}件・そのまま ${kept}件・片づけ ${removed}件）`);
if (dictBad.length) process.exitCode = 1;
