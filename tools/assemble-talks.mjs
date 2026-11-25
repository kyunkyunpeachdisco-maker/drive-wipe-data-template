// 広告のあいだに話す小話（talks/*.txt）を点検して、talks/index.json にまとめる（Node / 依存なし）
//
// 使い方: node tools/assemble-talks.mjs
//   読むもの: talks/any.txt（いつでも使える話）、talks/articles.txt（記事の話）、talks/<動画ID>.txt（その動画の話）
//   作るもの: talks/index.json（アプリと、声を作る道具が読む）
//
// 書き方:
//   # 話：題                    ここから次の「# 話：」までが1つの話。題は、同じファイルの中で重ねない
//   # 場面：出発前              出発前／途中／いつでも（書かなければ「いつでも」）／行こう／戻ろう
//   # 区間：6:00〜20:00         途中の話だけ。この区間で広告が出たときに話す（書かなければ、どこでも）
//   # 記事：https://…           記事の話だけ。articles/ にある記事の URL
//   [笑う] セリフ               1行が1つのセリフ。表情・しぐさの印は、台本と同じ書き方
//   「行こう」「戻ろう」は、話し終えて映像に戻るときのひとこと（セリフは1つ）。それぞれ、出発前・途中の広告のあとに使う

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { parseMarks } from "./marks.mjs";

const WHEN = { "出発前": "start", "途中": "mid", "いつでも": "any", "行こう": "go", "戻ろう": "back" };
const CHARS_PER_SEC = 5.5;      // 声の速さの目安
const MIN_SEC = 6, MAX_SEC = 22;

const sec = s => s.split(":").map(Number).reduce((a, b) => a * 60 + b, 0);
const errors = [], notes = [];
const readSafe = p => { try { return readFileSync(p, "utf8"); } catch { return ""; } };
const bare = u => u.replace(/#\d{4}-\d{2}-\d{2}$/, "").replace(/\/$/, "");

if (!existsSync("talks")) { console.error("talks/ がありません"); process.exit(1); }
const arts = existsSync("articles") ? readdirSync("articles").filter(f => f.endsWith(".md")).map(f => {
  const t = readSafe(`articles/${f}`);
  return { title: (t.match(/^#\s*(.+)$/m) || [])[1]?.trim() || "", url: (t.match(/^-\s*URL:\s*(\S+)/m) || [])[1] || "" };
}) : [];
let old = [];
try { old = JSON.parse(readSafe("talks/index.json")).talks || []; } catch {}

const talks = [];
for (const f of readdirSync("talks").filter(f => f.endsWith(".txt")).sort()) {
  const name = f.slice(0, -4);
  const kind = name === "any" ? "any" : name === "articles" ? "article" : /^[\w-]{11}$/.test(name) ? "video" : "";
  if (!kind) { errors.push(`talks/${f}: ファイル名は any.txt、articles.txt、<動画ID>.txt のどれかにします`); continue; }
  let cur = null;
  readSafe(`talks/${f}`).split(/\r?\n/).forEach((raw, i) => {
    const l = raw.trim(), at = `talks/${f} ${i + 1}行目`;
    if (!l) return;
    if (l.startsWith("#")) {
      const m = l.match(/^#+\s*(話|場面|区間|記事)\s*[：:]\s*(.+?)\s*$/);
      if (!m) return;   // ただの覚え書き
      if (m[1] === "話") {
        if (talks.some(t => t.file === f && t.title === m[2])) errors.push(`${at}: 同じ題の話があります（${m[2]}）`);
        cur = { file: f, at, title: m[2], kind, when: "any", lines: [], ...(kind === "video" ? { videoId: name } : {}) };
        talks.push(cur);
        return;
      }
      if (!cur) { errors.push(`${at}: 「# ${m[1]}：」は、「# 話：」のあとに書きます`); return; }
      if (m[1] === "場面") {
        if (!WHEN[m[2]]) errors.push(`${at}: 場面は ${Object.keys(WHEN).join("／")} のどれかにします`);
        else cur.when = WHEN[m[2]];
      } else if (m[1] === "区間") {
        const r = m[2].match(/^(\d+:\d{2}(?::\d{2})?)\s*[〜~－-]\s*(\d+:\d{2}(?::\d{2})?)$/);
        if (!r || sec(r[1]) >= sec(r[2])) errors.push(`${at}: 区間は 6:00〜20:00 の形で書きます`);
        else { cur.from = sec(r[1]); cur.to = sec(r[2]); }
      } else {
        if (!/^https?:\/\/\S+$/.test(m[2])) { errors.push(`${at}: 記事の URL の形が違います`); return; }
        cur.url = bare(m[2]);
        const a = arts.find(x => bare(x.url) === cur.url);
        if (a) cur.article = a.title;
        else errors.push(`${at}: articles/ に、この URL の記事がありません（本文を読まずに書かない）`);
      }
      return;
    }
    if (!cur) { errors.push(`${at}: 先に「# 話：題」を書きます`); return; }
    const { line: text, errors: bad, ...mark } = parseMarks(l, { hands: true });
    for (const e of bad) errors.push(`${at}: ${e}`);
    if (!text) { if (!bad.length) errors.push(`${at}: セリフがありません`); return; }
    if (text.length > 70) errors.push(`${at}: 1つのセリフは70字までです（${text.length}字）`);
    if (/https?:\/\//.test(text)) errors.push(`${at}: セリフに URL を書かない`);
    cur.lines.push({ line: text, ...mark });
  });
}

const now = new Date().toISOString();
for (const t of talks) {
  const s = t.lines.reduce((a, l) => a + l.line.length / CHARS_PER_SEC + 0.4, 0);
  const bridge = t.when === "go" || t.when === "back";
  if (bridge ? t.lines.length !== 1 : t.lines.length < 2 || t.lines.length > 5) errors.push(`${t.at}「${t.title}」: セリフは${bridge ? "1つ" : "2〜5つ"}にします（今は${t.lines.length}）`);
  else if (bridge ? s > 5 : s < MIN_SEC || s > MAX_SEC) errors.push(`${t.at}「${t.title}」: 話す長さが約${Math.round(s)}秒です。${bridge ? "5秒まで" : `${MIN_SEC}〜${MAX_SEC}秒`}にします`);
  if (bridge && t.kind === "article") errors.push(`${t.at}「${t.title}」: 「行こう」「戻ろう」は articles.txt に書かない`);
  if (t.kind === "article" && !t.url) errors.push(`${t.at}「${t.title}」: 記事の話には「# 記事：URL」が要ります`);
  if (t.from != null && (t.kind !== "video" || t.when === "start")) errors.push(`${t.at}「${t.title}」: 区間は、動画の話の「途中」だけに書けます`);
  if (t.kind === "video" && !existsSync(`videos/${t.videoId}.json`)) errors.push(`${t.at}: videos/${t.videoId}.json がありません（映像の記録を読まずに書かない）`);
  t.sec = Math.round(s);
  t.id = createHash("sha256").update(`${t.file}/${t.title}`, "utf8").digest("hex").slice(0, 10);
  t.addedAt = old.find(o => o.id === t.id)?.addedAt || now;
}
const seen = new Map();
for (const t of talks) for (const l of t.lines) {
  if (seen.has(l.line)) notes.push(`同じセリフが2か所にあります: 「${l.line.slice(0, 20)}」（${seen.get(l.line)} と ${t.title}）`);
  seen.set(l.line, t.title);
}
if (errors.length) {
  console.error(`点検で ${errors.length}件 引っかかりました。talks/index.json は書き出していません。`);
  for (const e of errors) console.error("  " + e);
  process.exit(1);
}
for (const n of notes) console.log(n);
const out = talks.map(({ id, title, kind, when, videoId, from, to, url, article, addedAt, sec: s, lines }) =>
  ({ id, title, kind, when, ...(videoId ? { videoId } : {}), ...(from != null ? { from, to } : {}), ...(url ? { url, article } : {}), addedAt, sec: s, lines }));
writeFileSync("talks/index.json", JSON.stringify({ version: 1, talks: out }, null, 1) + "\n");
const n = k => out.filter(t => t.kind === k && t.when !== "go" && t.when !== "back").length;
console.log(`書き出しました: talks/index.json（いつでも ${n("any")}・記事 ${n("article")}・動画 ${n("video")}／行こう・戻ろう ${out.filter(t => t.when === "go" || t.when === "back").length}）`);
if (!out.some(t => t.when === "go") || !out.some(t => t.when === "back")) console.log("「行こう」「戻ろう」のひとことがありません。なくても動きますが、話のあと、すぐ映像に戻ります。");
