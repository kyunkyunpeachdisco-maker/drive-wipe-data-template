// 書いたセリフを、映像の記録と合わせて台本にする（Node / 依存なし）
//
// 使い方: node tools/assemble-script.mjs <動画ID>
//   読むもの: videos/<動画ID>.json（映像の記録）と lines/<動画ID>.txt（書いたセリフ）
//   作るもの: scripts/<動画ID>_0-<記録の長さ>.json と scripts/_index.json の追記
//
// lines/<動画ID>.txt の書き方（1行に1発話）:
//   6:28 雑談 長く猫を飼ってた人のブログで読んだんだけど、もとは研究の記事なんだって。
//   8:45 実況 もう浜松町。話してると早いな。
//   # で始まる行と空行は読み飛ばす（コーナーの見出しやメモに使う）
//
// 点検に1つでも引っかかると、台本は書き出さずに終わる（終了コード1）。直してからもう一度実行する。

import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";

const id = process.argv[2];
if (!id) { console.error("使い方: node tools/assemble-script.mjs <動画ID>"); process.exit(1); }
const CHARS_PER_SEC = 5.5;   // 読み上げの速さの見積もり（ゆっくりめに見ている）
const MAX_SILENCE = 120;     // これより長い無言は、黙りすぎとみなす（秒）
const MAX_LINE = 70;         // 1発話の長さの上限（文字）

const rec = JSON.parse(readFileSync(`videos/${id}.json`, "utf8"));
const fmt = s => { s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
  return (h ? `${h}:${String(m).padStart(2, "0")}` : `${m}`) + `:${String(x).padStart(2, "0")}`; };
const sec = t => { const p = t.split(":").map(Number); return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1]; };

const errors = [];
const lines = [];
// 「# コーナー1：題（…）」の見出しから次の見出しまでを、1本の記事のコーナーとして覚える
// （画面の「いま話している記事」の札と、再生バーの色分けに使う）
let topicNow = null;
readFileSync(`lines/${id}.txt`, "utf8").split(/\r?\n/).forEach((raw, i) => {
  const l = raw.trim();
  if (l.startsWith("#")) {
    const h = l.match(/^#+\s*コーナー\s*\d*\s*[：:]\s*(.+?)\s*(?:[（(][^）)]*[）)])?\s*$/);
    topicNow = h ? h[1] : null;
    return;
  }
  if (!l) return;
  const m = l.match(/^(\d+:\d{2}(?::\d{2})?)\s+(実況|雑談)\s+(.+)$/);
  if (!m) { errors.push(`${i + 1}行目: 「時刻 実況|雑談 セリフ」の形になっていません → ${l.slice(0, 30)}`); return; }
  lines.push({ abs: sec(m[1]), kind: m[2] === "実況" ? "scene" : "chat", line: m[3].trim(), no: i + 1, topic: topicNow });
});
lines.sort((a, b) => a.abs - b.abs);

// 点検
const covered = rec.covered;
for (const l of lines) {
  if (l.abs > covered - 3) errors.push(`${l.no}行目: ${fmt(l.abs)} は記録の終わり（${fmt(covered)}）を超えています`);
  if (l.line.length > MAX_LINE) errors.push(`${l.no}行目: ${l.line.length}字あります（${MAX_LINE}字まで。2つに分ける）`);
  if (/https?:\/\//.test(l.line)) errors.push(`${l.no}行目: URLが入っています`);
}
for (let i = 1; i < lines.length; i++) {
  const a = lines[i - 1], b = lines[i];
  const need = a.line.length / CHARS_PER_SEC + 0.5;
  if (b.abs - a.abs < need)
    errors.push(`${b.no}行目: ${fmt(a.abs)} の発話（${a.line.length}字・約${Math.ceil(need)}秒）が終わる前に ${fmt(b.abs)} が始まります`);
  if (b.abs - a.abs > MAX_SILENCE)
    errors.push(`${fmt(a.abs)}〜${fmt(b.abs)}: 無言が${b.abs - a.abs}秒続きます（${MAX_SILENCE}秒まで）`);
}
if (lines.length && lines[0].abs > 20) errors.push(`最初の発話が ${fmt(lines[0].abs)} です（冒頭20秒以内に導入を入れる）`);
if (lines.length && covered - lines[lines.length - 1].abs > MAX_SILENCE) errors.push(`最後の発話のあと、終わりまで無言が長すぎます`);
const seen = new Map();
for (const l of lines) {
  if (seen.has(l.line)) errors.push(`${l.no}行目: ${seen.get(l.line)}行目と同じセリフです`);
  seen.set(l.line, l.no);
}
// 止まっている記録（stop/start）の時刻に実況を置かない。信号待ちは雑談の時間
for (const l of lines) {
  const it = rec.items.find(x => x.abs === l.abs);
  if (it && (it.act === "stop" || it.act === "start") && l.kind === "scene")
    errors.push(`${l.no}行目: ${fmt(l.abs)} は停止・発進の時刻です。実況ではなく雑談にするか、時刻をずらす`);
}

const nScene = lines.filter(l => l.kind === "scene").length, nChat = lines.length - nScene;
const gaps = lines.slice(1).map((b, i) => b.abs - lines[i].abs);
console.log(`発話 ${lines.length}件（実況 ${nScene}・雑談 ${nChat}）／ いちばん長い無言 ${gaps.length ? Math.max(...gaps) : 0}秒 ／ 記録の長さ ${fmt(covered)}`);
if (!lines.length) errors.push("セリフが1件もありません");
if (errors.length) {
  console.error(`\n点検で ${errors.length}件 引っかかりました。台本は書き出していません。`);
  for (const e of errors) console.error("- " + e);
  process.exit(1);
}

// 組み立て：記録の各項目は残す（アバターの運転操作に使う）。同じ時刻のセリフはその項目に、それ以外は足す
const items = rec.items.map(it => ({ t: fmt(it.abs), scene: it.scene, line: "", kind: "none",
  act: it.act, amount: it.amount || 0, place: it.place || "", abs: it.abs }));
for (const l of lines) {
  const hit = items.find(x => x.abs === l.abs && !x.line);
  if (hit) { hit.line = l.line; hit.kind = l.kind; continue; }
  const prev = [...rec.items].reverse().find(x => x.abs <= l.abs) || rec.items[0];
  items.push({ t: fmt(l.abs), scene: prev?.scene || "", line: l.line, kind: l.kind,
    act: prev?.act === "stop" ? "stop" : "straight", amount: 0, place: "", abs: l.abs });
}
items.sort((a, b) => a.abs - b.abs);

// コーナーごとに、最初の発話から最後の発話が終わるまで
const topics = [];
for (const l of lines) {
  if (!l.topic) continue;
  const end = Math.min(covered, Math.round(l.abs + l.line.length / CHARS_PER_SEC + 1));
  const last = topics[topics.length - 1];
  if (last && last.title === l.topic) last.end = Math.max(last.end, end);
  else topics.push({ title: l.topic, start: l.abs, end });
}

const persona = (() => { try { return readFileSync("character/persona.md", "utf8").trim(); } catch { return ""; } })();
const key = `${id}_0-${Math.round(covered)}`;
const now = new Date().toISOString();
const script = {
  promptVersion: "claude-code-2", generatedAt: now, writer: "claude-code", model: rec.model,
  videoId: id, start: 0, end: covered, covered, viewType: rec.viewType || "pov",
  persona, chatStyle: "podcast", useComments: false, maxReplies: null,
  meta: rec.meta, chapters: rec.chapters || [], topics, items, comments: []
};
writeFileSync(`scripts/${key}.json`, JSON.stringify(script, null, 2) + "\n");

let index = {};
try { index = JSON.parse(readFileSync("scripts/_index.json", "utf8")); } catch {}
// 記録が伸びて名前が変わったら、同じ動画の古い台本は片づける（音声は本文のハッシュで紐づくので作り直しにならない）
for (const k of Object.keys(index)) {
  if (k !== key && index[k].videoId === id && index[k].writer === "claude-code") {
    delete index[k];
    if (existsSync(`scripts/${k}.json`)) unlinkSync(`scripts/${k}.json`);
  }
}
index[key] = { label: index[key]?.label || rec.meta?.title || key, videoId: id, start: 0, end: covered,
               savedAt: now, fav: index[key]?.fav || false, writer: "claude-code",
               channel: rec.meta?.channelTitle || "", topics: topics.map(t => t.title) };
writeFileSync("scripts/_index.json", JSON.stringify(index, null, 2) + "\n");
console.log(`書き出しました: scripts/${key}.json`);
