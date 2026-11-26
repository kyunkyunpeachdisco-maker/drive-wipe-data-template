// YouTube の登録チャンネルの新着を、Gemini に見せてまとめ、記事と同じ形で articles/ に置く（Node 20 / 依存なし）
//
// データリポジトリの character/channels.md に書いたチャンネルの新しい動画と、プレイリストのまだまとめていない動画を拾う。
// Gemini が動画を見てまとめた中身を articles/youtube-<動画ID>.md に書く。台本を書くときは、記事と同じに読む。
//
// 使い方: データリポジトリの中で実行する（GitHub Actions の watch-video.yml から。「記事」の依頼でも動く）。
//   必要な環境変数: GEMINI_API_KEY, YOUTUBE_API_KEY
//   PER_CHANNEL   1つのチャンネルから拾う本数（既定2）
//   MAX_VIDEOS    1回にまとめる本数の上限（既定6）
//   DAYS          何日前までの動画を拾うか（既定10）
//   MAX_MINUTES   これより長い動画は拾わない（既定40）
//
// 外すもの：ショート（90秒未満）・長すぎる動画・配信中や予定の動画・ドライブ動画（記録した動画と同じチャンネル、
// または Gemini が「車の運転の映像」と見たもの）。外した動画は articles/youtube-skipped.txt に書き、次から見ない。
// YouTube の決まりで、API から取った題やチャンネル名は長く取っておけない。そのため、記事の題とチャンネルの呼び名は、
// Gemini が動画を見て付けたものを書く。

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";

const GEMINI_KEY = process.env.GEMINI_API_KEY, YT_KEY = process.env.YOUTUBE_API_KEY;
const MODEL = "gemini-3.6-flash";
const PER_CHANNEL = parseInt(process.env.PER_CHANNEL || "2", 10) || 2;
const MAX_VIDEOS = parseInt(process.env.MAX_VIDEOS || "6", 10) || 6;
const DAYS = parseInt(process.env.DAYS || "10", 10) || 10;
const MAX_MINUTES = parseInt(process.env.MAX_MINUTES || "40", 10) || 40;
const SKIP = "articles/youtube-skipped.txt";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const readSafe = p => { try { return readFileSync(p, "utf8"); } catch { return ""; } };

const lines = readSafe("character/channels.md").replace(/<!--[\s\S]*?-->/g, "").split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith("#"));
if (!lines.length) { console.log("character/channels.md にチャンネルがないので、YouTube の新着は見ません"); process.exit(0); }
if (!GEMINI_KEY || !YT_KEY) { console.error("GEMINI_API_KEY と YOUTUBE_API_KEY が要ります。リポジトリの Secrets に登録してください。"); process.exit(1); }

/* ---------- YouTube ---------- */
async function yt(path, params) {
  const q = new URLSearchParams({ ...params, key: YT_KEY });
  const res = await fetch(`https://www.googleapis.com/youtube/v3/${path}?${q}`);
  if (!res.ok) throw new Error(`YouTube API ${res.status}: ${(await res.json().catch(() => null))?.error?.message || ""}`);
  return res.json();
}
const secOf = d => { const m = String(d).match(/P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/) || []; return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0); };
const fmt = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
// 「https://www.youtube.com/@name」「@name」「…/channel/UC…」のどれでもよい
function channelQuery(line) {
  // プレイリスト（…?list=PL… や …&list=… の URL）。公開か限定公開のものだけ読める
  const pl = line.match(/[?&]list=([\w-]+)/) || line.match(/^((?:PL|OL)[\w-]{10,})$/);
  if (pl) return { playlist: pl[1] };
  const id = line.match(/(UC[\w-]{22})/);
  if (id) return { id: id[1] };
  const h = line.match(/@([\w.\-]+)/);
  if (h) return { forHandle: "@" + h[1] };
  return null;
}

/* ---------- Gemini ---------- */
async function gemini(parts, generationConfig) {
  for (let i = 0; ; i++) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(GEMINI_KEY)}`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig }) }).catch(e => ({ ok: false, status: 0, json: async () => ({ error: { message: e.message } }) }));
    const body = await res.json().catch(() => null);
    if (res.ok) return (body?.candidates?.[0]?.content?.parts || []).map(p => p.text).filter(Boolean).join("").trim();
    const msg = body?.error?.message || "";
    const quota = (body?.error?.details || []).flatMap(d => d.violations || []).map(v => v.quotaId || "").join(" ");
    if (/PerDay/i.test(quota)) { const e = new Error("Gemini の1日の枠が尽きました。日本時間の16〜17時に戻ります"); e.daily = true; throw e; }
    // 見る細かさの指定を受け付けないモデルなら、外してやり直す
    if (res.status === 400 && generationConfig.mediaResolution && /media_?resolution/i.test(msg)) { delete generationConfig.mediaResolution; continue; }
    if (![0, 429, 500, 502, 503, 504].includes(res.status) || i >= 4) throw new Error(`Gemini API ${res.status}：${msg}`);
    const wait = Math.min(120000, 15000 * (i + 1));
    console.log(`  待機 ${wait / 1000}秒（${res.status} ${msg.slice(0, 80)}）`);
    await sleep(wait);
  }
}
const SCHEMA = {
  type: "object",
  properties: {
    drive: { type: "boolean", description: "車の運転の映像（車載カメラ・ドライブの景色）が中心の動画なら true" },
    title: { type: "string", description: "動画の中身が分かる日本語の題。20字くらいまで" },
    channel: { type: "string", description: "動画を作った人やチャンネルの呼び名（動画の中で名乗っているもの。分からなければ空）" },
    summary: { type: "string", description: "何の動画か。3〜5文" },
    points: { type: "array", items: { type: "string" }, description: "中身を具体的に。数字・やり方・例・出てきた言い回し。5〜10個" },
    opinion: { type: "string", description: "作った人の意見や感想。事実と分けて書く。なければ空" },
    chat: { type: "integer", description: "車の中の雑談の種として、どれくらい話しやすいか。1〜5" },
  },
  required: ["drive", "title", "summary", "points", "chat"],
};
const PROMPT = `この YouTube 動画を最後まで見て、日本語でまとめてください。
あとで、この動画を見ていない人に、雑談として中身を話すための材料にします。
- 動画で言っていること・見せていることだけを書く。分からないことを推測で足さない
- 中身は具体的に。数字、やり方、例、面白かった言い回しを拾う
- 作った人の意見は、事実と分けて opinion に書く
- 車の運転の映像（車載カメラやドライブの景色）が中心の動画なら、drive を true にする`;

/* ---------- 外すもの ---------- */
const skipped = new Set(readSafe(SKIP).split(/\r?\n/).map(l => l.split(/\s/)[0]).filter(Boolean));
const haveArticle = new Set(existsSync("articles") ? readdirSync("articles").map(f => (f.match(/^youtube-([\w-]{11})\.md$/) || [])[1]).filter(Boolean) : []);
const driveIds = new Set(), driveChannels = new Set();
for (const f of existsSync("videos") ? readdirSync("videos").filter(f => /^[\w-]{11}\.json$/.test(f)) : []) {
  driveIds.add(f.slice(0, 11));
  try { const c = JSON.parse(readFileSync(`videos/${f}`, "utf8"))?.meta?.channelTitle; if (c) driveChannels.add(c); } catch {}
}
const skipLog = [];
const skip = (id, why) => { skipped.add(id); skipLog.push(`${id} ${why}`); };

/* ---------- 新着を集める ---------- */
const since = Date.now() - DAYS * 86400000;
const picks = [];
for (const line of lines) {
  const q = channelQuery(line);
  if (!q) { console.log(`チャンネルかプレイリストの URL の形が分からないので飛ばします: ${line}`); continue; }
  try {
    // チャンネルは、新しく出た動画（DAYS 日以内）。プレイリストは、並びの上から、まだまとめていないもの
    let ids, addedAt = {};
    if (q.playlist) {
      if (/^(WL|LL|HL)$/.test(q.playlist)) { console.log(`「後で見る」「高く評価した動画」「履歴」は、YouTube の決まりで読めません: ${line}`); continue; }
      const items = (await yt("playlistItems", { part: "contentDetails,snippet", playlistId: q.playlist, maxResults: "50" }).catch(e => {
        if (/ 404/.test(e.message)) throw new Error("見つかりません。非公開のプレイリストは読めないので、公開か限定公開にしてください");
        throw e;
      })).items || [];
      ids = items.map(it => it.contentDetails?.videoId).filter(Boolean);
      for (const it of items) addedAt[it.contentDetails?.videoId] = it.snippet?.publishedAt || "";
    } else {
      const ch = (await yt("channels", { part: "contentDetails", ...q })).items?.[0];
      const up = ch?.contentDetails?.relatedPlaylists?.uploads;
      if (!up) { console.log(`チャンネルが見つかりません: ${line}`); continue; }
      const items = (await yt("playlistItems", { part: "contentDetails", playlistId: up, maxResults: "15" })).items || [];
      ids = items.filter(it => Date.parse(it.contentDetails?.videoPublishedAt || 0) >= since).map(it => it.contentDetails.videoId);
    }
    ids = ids.filter(id => !skipped.has(id) && !haveArticle.has(id) && !picks.some(p => p.id === id)).slice(0, 50);   // チャンネルとプレイリストの両方に出た動画は1回だけ
    if (!ids.length) continue;
    const got = new Map(((await yt("videos", { part: "contentDetails,snippet", id: ids.join(",") })).items || []).map(v => [v.id, v]));
    const vs = ids.map(id => got.get(id)).filter(Boolean);   // 消えた・非公開になった動画は来ない
    let n = 0;
    for (const v of vs) {
      const len = secOf(v.contentDetails?.duration);
      if (driveIds.has(v.id) || driveChannels.has(v.snippet?.channelTitle)) { skip(v.id, "ドライブ動画のチャンネル"); continue; }
      if (v.snippet?.liveBroadcastContent && v.snippet.liveBroadcastContent !== "none") continue;   // 配信中・予定。終わってから拾う
      if (len < 90) { skip(v.id, "ショート"); continue; }
      if (len > MAX_MINUTES * 60) { skip(v.id, `長い（${fmt(len)}）`); continue; }
      // 並べる順は、チャンネルなら出た日、プレイリストなら入れた日
      if (n++ < PER_CHANNEL) picks.push({ id: v.id, len, at: (q.playlist ? addedAt[v.id] : v.snippet?.publishedAt) || "" });
    }
  } catch (e) { console.log(`読めませんでした: ${line}（${e.message}）`); }
}
picks.sort((a, b) => b.at.localeCompare(a.at));
console.log(`まとめる動画: ${Math.min(picks.length, MAX_VIDEOS)}本（候補 ${picks.length}本）`);

/* ---------- 見てまとめる ---------- */
mkdirSync("articles", { recursive: true });
const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
let made = 0, stop = "";
for (const p of picks.slice(0, MAX_VIDEOS)) {
  const url = `https://www.youtube.com/watch?v=${p.id}`;
  console.log(`見ています: ${url}（${fmt(p.len)}）`);
  let r;
  try {
    r = JSON.parse(await gemini([{ fileData: { fileUri: url, mimeType: "video/*" } }, { text: PROMPT }],
      { responseMimeType: "application/json", responseSchema: SCHEMA, mediaResolution: "MEDIA_RESOLUTION_LOW" }));
  } catch (e) {
    console.log(`  打ち切り: ${e.message}`);
    if (e.daily) { stop = e.message; break; }
    continue;
  }
  if (r.drive) { skip(p.id, "ドライブの映像"); console.log("  ドライブの映像なので外しました"); continue; }
  const NL = "\n";
  const body = [
    `# ${r.title || "YouTube の動画"}`, "",
    `- URL: ${url}`,
    `- 種類: YouTube の動画（${[r.channel, fmt(p.len)].filter(Boolean).join("・")}）`,
    `- 取得日: ${today}`,
    `- 雑談の種としての話しやすさ: ${Math.max(1, Math.min(5, r.chat || 3))} / 5`,
    "- 使った台本: （まだ）", "",
    "## 本文", "",
    "Gemini が動画を見てまとめたもの。動画の言葉そのままではない。", "",
    r.summary || "", "",
    "### 中身", "",
    ...(r.points || []).map(x => `- ${x}`), "",
    ...(r.opinion ? ["### 作った人の意見", "", r.opinion, ""] : []),
  ].join(NL);
  writeFileSync(`articles/youtube-${p.id}.md`, body);
  made++;
  console.log(`  書きました: articles/youtube-${p.id}.md（${r.title}）`);
}
if (skipLog.length) {
  const old = readSafe(SKIP).trimEnd();
  const NL = "\n";
  writeFileSync(SKIP, (old ? old + NL : "# 見ないことにした YouTube の動画（tools/fetch-youtube.mjs が書く。消すと、次にまた見る）" + NL) + skipLog.join(NL) + NL);
}
console.log(`YouTube の新着: ${made}本をまとめました${stop ? `（${stop}）` : ""}`);
