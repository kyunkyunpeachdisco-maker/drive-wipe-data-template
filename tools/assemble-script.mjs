// 書いたセリフを、映像の記録と合わせて台本にする（Node / 依存なし）
//
// 使い方: node tools/assemble-script.mjs <動画ID> [台本の名前]
//         node tools/assemble-script.mjs <動画ID> --all     その動画の台本を全部組み立て直す（実況を直したとき）
//         node tools/assemble-script.mjs <動画ID> --slots   雑談を置ける静かな区間を並べる（書く前に見る）
//   読むもの: videos/<動画ID>.json（映像の記録）
//             lines/<動画ID>/base.txt（実況と、記事に関係しないひとこと。その動画の台本すべてで使い回す）
//             lines/<動画ID>/<台本の名前>.txt（その台本だけのセリフ。記事のコーナー、入り、締めなど）
//   作るもの: scripts/<動画ID>_0-<記録の長さ>_<台本の名前>.json と scripts/_index.json の追記
//             台本の名前が main のときだけ、後ろに名前を付けない
//   lines/<動画ID>.txt が1つだけある前の形（実況と雑談が混ざったもの）も、そのまま組み立てられる
//
// 1行に1発話:
//   6:28 雑談 長く猫を飼ってた人のブログで読んだんだけど、もとは研究の記事なんだって。
//   8:45 実況 もう浜松町。話してると早いな。
//   2:15 外す                 base.txt のこの時刻のセリフを、この台本では使わない
//   # 題：最新の記事（11/25）  台本の題（台本のファイルの先頭に書く）
//   # 実況：base              使い回す実況のファイル名（書かなければ base）
//   # コーナー1：猫が鳴く理由（6:15〜8:30）
//   そのほかの # で始まる行と空行は読み飛ばす
//
// 台本のセリフとかぶる base.txt のセリフは、自動で外す（外したものは表示する）。
// 点検に1つでも引っかかると、台本は書き出さずに終わる（終了コード1）。直してからもう一度実行する。

import { readFileSync, writeFileSync, existsSync, unlinkSync, readdirSync, mkdirSync } from "node:fs";

const [id, arg] = process.argv.slice(2);
if (!id) { console.error("使い方: node tools/assemble-script.mjs <動画ID> [台本の名前 | --all | --slots]"); process.exit(1); }
const CHARS_PER_SEC = 5.5;   // 読み上げの速さの見積もり（ゆっくりめに見ている）
const MAX_SILENCE = 120;     // これより長い無言は、黙りすぎとみなす（秒）
const MAX_LINE = 70;         // 1発話の長さの上限（文字）

const rec = JSON.parse(readFileSync(`videos/${id}.json`, "utf8"));
const covered = rec.covered;
const fmt = s => { s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
  return (h ? `${h}:${String(m).padStart(2, "0")}` : `${m}`) + `:${String(x).padStart(2, "0")}`; };
const sec = t => { const p = t.split(":").map(Number); return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1]; };
const need = l => l.line.length / CHARS_PER_SEC + 0.5;   // 読み終わるまでの秒数

const dir = `lines/${id}`;
const flat = !existsSync(dir) && existsSync(`lines/${id}.txt`);
const isBase = n => n === "base" || n.startsWith("base-");
const names = flat ? ["main"] : existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith(".txt")).map(f => f.slice(0, -4)).filter(n => !isBase(n)) : [];

if (arg === "--slots") { showSlots(); process.exit(0); }

let todo;
if (arg === "--all") todo = names;
else if (arg) todo = [arg.replace(/\.txt$/, "")];
else if (names.length === 1) todo = names;
else {
  console.error(names.length ? `台本の名前を指定してください: ${names.join(" / ")}（全部なら --all）` : `lines/${id}/ に台本のファイルがありません`);
  process.exit(1);
}
let bad = 0;
for (const n of todo) { if (todo.length > 1) console.log(`\n== ${n}`); if (!build(n)) bad++; }
process.exit(bad ? 1 : 0);

// 1つのファイルを読む
function readLines(path, errors) {
  const out = { lines: [], drop: new Set(), title: "", base: "base" };
  // 「# コーナー1：題（…）」の見出しから次の見出しまでを、1本の記事のコーナーとして覚える
  // （画面の「いま話している記事」の札と、再生バーの色分けに使う）
  let topicNow = null;
  readFileSync(path, "utf8").split(/\r?\n/).forEach((raw, i) => {
    const l = raw.trim();
    const at = `${path} ${i + 1}行目`;
    if (l.startsWith("#")) {
      const head = l.match(/^#+\s*(題|実況)\s*[：:]\s*(.+?)\s*$/);
      if (head) { if (head[1] === "題") out.title = head[2]; else out.base = head[2].replace(/\.txt$/, ""); return; }
      const h = l.match(/^#+\s*コーナー\s*\d*\s*[：:]\s*(.+?)\s*(?:[（(][^）)]*[）)])?\s*$/);
      topicNow = h ? h[1] : null;
      return;
    }
    if (!l) return;
    const off = l.match(/^(\d+:\d{2}(?::\d{2})?)\s+外す$/);
    if (off) { out.drop.add(sec(off[1])); return; }
    const m = l.match(/^(\d+:\d{2}(?::\d{2})?)\s+(実況|雑談)\s+(.+)$/);
    if (!m) { errors.push(`${at}: 「時刻 実況|雑談 セリフ」の形になっていません → ${l.slice(0, 30)}`); return; }
    out.lines.push({ abs: sec(m[1]), kind: m[2] === "実況" ? "scene" : "chat", line: m[3].trim(), at, topic: topicNow });
  });
  out.lines.sort((a, b) => a.abs - b.abs);
  return out;
}

function build(name) {
  const errors = [];
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(name) || isBase(name)) {
    console.error(`台本の名前「${name}」は使えません。半角の小文字・数字・ハイフンで付けてください（例: 20261125、theme-cat）`);
    return false;
  }
  const file = flat ? `lines/${id}.txt` : `${dir}/${name}.txt`;
  if (!existsSync(file)) { console.error(`${file} がありません`); return false; }
  const own = readLines(file, errors);

  // 使い回す実況を重ねる。この台本のセリフとかぶるもの、コーナーの途中のひとことは外す
  let base = [];
  if (!flat) {
    const bf = `${dir}/${own.base}.txt`;
    if (existsSync(bf)) base = readLines(bf, errors).lines;
    else if (own.base !== "base") errors.push(`${bf} がありません（# 実況：${own.base}）`);
  }
  for (const t of own.drop) if (!base.some(b => b.abs === t)) errors.push(`${file}: 「${fmt(t)} 外す」に当たるセリフが ${own.base}.txt にありません`);
  const spans = [];   // コーナーの始まりと終わり
  for (const l of own.lines) {
    if (!l.topic) continue;
    const last = spans[spans.length - 1];
    if (last && last.topic === l.topic) {
      if (l.abs - last.end > MAX_SILENCE) errors.push(`${l.at}: コーナー「${l.topic}」の途中が${Math.round(l.abs - last.end)}秒空いています（コーナーが終わったら、次の見出し（# 締め など）を書く）`);
      last.end = l.abs + need(l);
    } else spans.push({ topic: l.topic, start: l.abs, end: l.abs + need(l) });
  }
  const dropped = [];
  base = base.filter(b => {
    if (own.drop.has(b.abs)) return false;
    const hit = own.lines.some(o => b.abs < o.abs + need(o) && o.abs < b.abs + need(b));
    const inside = b.kind === "chat" && spans.some(s => b.abs >= s.start && b.abs < s.end);
    if (hit || inside) dropped.push(b);
    return !(hit || inside);
  });
  const lines = [...own.lines, ...base].sort((a, b) => a.abs - b.abs);
  if (dropped.length) {
    console.log(`この台本のセリフを優先して、使い回しの ${dropped.length}件を外しました:`);
    for (const d of dropped) console.log(`  ${fmt(d.abs)} ${d.kind === "scene" ? "実況" : "雑談"} ${d.line}`);
  }

  // 点検
  for (const l of lines) {
    if (l.abs > covered - 3) errors.push(`${l.at}: ${fmt(l.abs)} は記録の終わり（${fmt(covered)}）を超えています`);
    if (l.line.length > MAX_LINE) errors.push(`${l.at}: ${l.line.length}字あります（${MAX_LINE}字まで。2つに分ける）`);
    if (/https?:\/\//.test(l.line)) errors.push(`${l.at}: URLが入っています`);
    // 止まっている記録（stop/start）の時刻に実況を置かない。信号待ちは雑談の時間
    const it = rec.items.find(x => x.abs === l.abs);
    if (it && (it.act === "stop" || it.act === "start") && l.kind === "scene")
      errors.push(`${l.at}: ${fmt(l.abs)} は停止・発進の時刻です。実況ではなく雑談にするか、時刻をずらす`);
  }
  for (let i = 1; i < lines.length; i++) {
    const a = lines[i - 1], b = lines[i];
    if (b.abs - a.abs < need(a))
      errors.push(`${b.at}: ${fmt(a.abs)} の発話（${a.line.length}字・約${Math.ceil(need(a))}秒）が終わる前に ${fmt(b.abs)} が始まります`);
    if (b.abs - a.abs > MAX_SILENCE)
      errors.push(`${fmt(a.abs)}〜${fmt(b.abs)}: 無言が${b.abs - a.abs}秒続きます（${MAX_SILENCE}秒まで）`);
  }
  if (lines.length && lines[0].abs > 20) errors.push(`最初の発話が ${fmt(lines[0].abs)} です（冒頭20秒以内に導入を入れる）`);
  if (lines.length && covered - lines[lines.length - 1].abs > MAX_SILENCE) errors.push(`最後の発話のあと、終わりまで無言が長すぎます`);
  const seen = new Map();
  for (const l of lines) {
    if (seen.has(l.line)) errors.push(`${l.at}: ${seen.get(l.line)} と同じセリフです`);
    seen.set(l.line, l.at);
  }
  if (!flat && name !== "main" && !own.title) errors.push(`${file}: 先頭に「# 題：…」を書いてください（アプリの一覧に出ます）`);

  const nScene = lines.filter(l => l.kind === "scene").length, nChat = lines.length - nScene;
  const gaps = lines.slice(1).map((b, i) => b.abs - lines[i].abs);
  console.log(`発話 ${lines.length}件（実況 ${nScene}・雑談 ${nChat}／使い回し ${base.length}）／ いちばん長い無言 ${gaps.length ? Math.max(...gaps) : 0}秒 ／ 記録の長さ ${fmt(covered)}`);
  if (!lines.length) errors.push("セリフが1件もありません");
  if (errors.length) {
    console.error(`\n点検で ${errors.length}件 引っかかりました。台本は書き出していません。`);
    for (const e of errors) console.error("- " + e);
    return false;
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
  const edition = name === "main" ? "" : name;
  const key = `${id}_0-${Math.round(covered)}` + (edition ? `_${edition}` : "");
  const now = new Date().toISOString();
  const script = {
    promptVersion: "claude-code-3", generatedAt: now, writer: "claude-code", model: rec.model,
    videoId: id, start: 0, end: covered, covered, ...(edition ? { edition } : {}), ...(own.title ? { title: own.title } : {}),
    viewType: rec.viewType || "pov",
    persona, chatStyle: "podcast", useComments: false, maxReplies: null,
    meta: rec.meta, chapters: rec.chapters || [], topics, items, comments: []
  };
  mkdirSync("scripts", { recursive: true });
  const path = `scripts/${key}.json`;
  let index = {};
  try { index = JSON.parse(readFileSync("scripts/_index.json", "utf8")); } catch {}
  // セリフが前と同じなら、保存した日時は変えない（一覧の新しい順が動かないように）
  let savedAt = now;
  try {
    const old = JSON.parse(readFileSync(path, "utf8"));
    if (JSON.stringify(old.items) === JSON.stringify(items) && index[key]?.savedAt) { savedAt = index[key].savedAt; script.generatedAt = old.generatedAt; }
  } catch {}
  writeFileSync(path, JSON.stringify(script, null, 2) + "\n");
  // 記録が伸びて名前が変わったら、同じ台本の古いものは片づける（音声は本文のハッシュで紐づくので作り直しにならない）
  let before = index[key];
  for (const k of Object.keys(index)) {
    const v = index[k];
    if (k === key || v.videoId !== id || v.writer !== "claude-code" || (v.edition || "") !== edition) continue;
    before = before || v;
    delete index[k];
    if (existsSync(`scripts/${k}.json`)) unlinkSync(`scripts/${k}.json`);
    console.log(`記録が伸びたので、古い台本 ${k} を ${key} に置き換えました`);
  }
  index[key] = { label: before?.label || rec.meta?.title || key, videoId: id, start: 0, end: covered,
                 savedAt, fav: before?.fav || false, writer: "claude-code",
                 ...(edition ? { edition } : {}), ...(own.title ? { title: own.title } : {}),
                 videoTitle: rec.meta?.title || "", channel: rec.meta?.channelTitle || "", topics: topics.map(t => t.title) };
  writeFileSync("scripts/_index.json", JSON.stringify(index, null, 2) + "\n");
  console.log(`書き出しました: ${path}`);
  return true;
}

// 静かな区間（mood が quiet か stop）のつながりを並べる。雑談はここに置く
function showSlots() {
  const spans = [];
  rec.items.forEach((it, i) => {
    const end = rec.items[i + 1]?.abs ?? covered;
    const calm = it.mood === "quiet" || it.mood === "stop";
    const last = spans[spans.length - 1];
    if (calm && last && last.end === it.abs) last.end = end;
    else if (calm) spans.push({ start: it.abs, end });
  });
  // 途切れが20秒以内なら、ひと続きとみなす
  const joined = [];
  for (const s of spans) {
    const last = joined[joined.length - 1];
    if (last && s.start - last.end <= 20) last.end = s.end;
    else joined.push({ ...s });
  }
  const base = !flat && existsSync(`${dir}/base.txt`) ? readLines(`${dir}/base.txt`, []).lines : [];
  console.log(`静かな区間（記録の長さ ${fmt(covered)}。60秒以上のもの）:`);
  for (const s of joined.filter(s => s.end - s.start >= 60)) {
    console.log(`  ${fmt(s.start)}〜${fmt(s.end)}（${Math.round(s.end - s.start)}秒）`);
    for (const b of base.filter(b => b.abs >= s.start && b.abs < s.end)) console.log(`      ${fmt(b.abs)} ${b.kind === "scene" ? "実況" : "雑談"} ${b.line}`);
  }
}
