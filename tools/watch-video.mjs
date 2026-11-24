// 映像の記録づくり（Node 20 / 依存なし）
//
// Geminiに動画を見せて「何分何秒に何が映っているか」だけを記録し、データリポジトリの videos/ に置く。
// セリフはここでは作らない。セリフは、データリポジトリを開いた Claude Code がこの記録をもとに書く
// （データリポジトリの CLAUDE.md「台本を書く」を参照）。
// 動画を見るのは1本につき1度きりなので、セリフを何度書き直しても Gemini の枠は減らない。
//
// 使い方: GitHub Actions（.github/workflows/watch-video.yml）が、videos/request.txt を読んで実行する。
//   GEMINI_API_KEY   必須
//   YOUTUBE_API_KEY  必須。動画の情報取得と新着探しに使う
//   VIDEO_URL        任意。無ければ、過去に使ったチャンネルの新着から未使用の動画を選ぶ
//   QUERY            任意。エリア・キーワードで探す（VIDEO_URL が優先）
//   LIST_ONLY        "true" なら候補を videos/candidates.md に書くだけ（Gemini を使わない）
//   MINUTES          任意。記録する長さの上限（分）。無ければ動画の最後まで
//
// 出力: videos/<videoId>.json（1区間ごとに保存するので、枠切れで止まっても続きから再開できる）

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";

const GEMINI_KEY = process.env.GEMINI_API_KEY;
const YT_KEY = process.env.YOUTUBE_API_KEY;
const MODEL = "gemini-3.6-flash";
const CHUNK_SEC = 600;
if (!GEMINI_KEY) { console.error("GEMINI_API_KEY がありません。リポジトリのSecretsに登録してください。"); process.exit(1); }
if (!YT_KEY) { console.error("YOUTUBE_API_KEY がありません。リポジトリのSecretsに登録してください。"); process.exit(1); }

/* ---------- 小道具 ---------- */
const fmtTime = t => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
function parseTime(v) {
  const s = String(v ?? "").trim();
  let m = s.match(/^(\d+):(\d+):(\d{2})$/);
  if (m) return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
  m = s.match(/^(\d+):(\d{2})$/);
  if (m) return (+m[1]) * 60 + (+m[2]);
  m = s.match(/^\d+$/);
  return m ? +s : null;
}
function parseChapters(desc) {
  const found = [];
  for (const raw of String(desc).split(/\r?\n/)) {
    const m = raw.match(/^\s*[[(（]?(\d{1,3}:\d{2}(?::\d{2})?)[\])）]?\s*(.+?)\s*$/);
    if (!m) continue;
    const t = parseTime(m[1]);
    const label = m[2].replace(/^[-–—~〜:：・\s]+/, "").trim();
    if (t === null || !label) continue;
    found.push({ t, label: label.slice(0, 60) });
  }
  const asc = [];
  for (const c of found) if (!asc.length || c.t > asc[asc.length - 1].t) asc.push(c);
  return asc.length >= 2 ? asc : [];
}
const cleanDescription = desc => String(desc)
  .split(/\r?\n/).filter(l => !/^\s*[[(（]?\d{1,3}:\d{2}/.test(l)).join("\n")
  .replace(/https?:\/\/\S+/g, "").replace(/\n{3,}/g, "\n\n").trim().slice(0, 600);
const readSafe = p => { try { return readFileSync(p, "utf8"); } catch { return ""; } };
const readJson = p => { try { return JSON.parse(readSafe(p)); } catch { return null; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
// 候補の一覧は、ログではなくファイルに残す（スマホのAIはActionsのログを読めないため）
function writeCandidates(heading, rows) {
  mkdirSync("videos", { recursive: true });
  const NL = String.fromCharCode(10);
  const body = `# 動画の候補${NL}${NL}${heading}（${new Date().toISOString().slice(0, 10)}）。`
    + `見たいものの URL を videos/request.txt に書くと記録します。${NL}${NL}`
    + rows.map(r => `- ${fmtTime(r.len)} ${r.title}　https://www.youtube.com/watch?v=${r.id}`).join(NL) + NL;
  writeFileSync("videos/candidates.md", body);
  console.log(body);
}
const listJson = dir => existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith(".json") && f !== "_index.json") : [];

/* ---------- Gemini ---------- */
async function geminiOnce(parts, extra) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(GEMINI_KEY)}`,
    { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts }], ...extra }) });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = body?.error?.message || "";
    const err = new Error(`Gemini API ${res.status}${detail ? "：" + detail : ""}`);
    err.retryable = [429, 500, 502, 503, 504].includes(res.status);
    // 1日の枠が尽きた429は、待っても通らない。すぐ打ち切って、済んだぶんを残す
    const quota = (body?.error?.details || []).flatMap(d => d.violations || []).map(v => v.quotaId || "").join(" ");
    if (/PerDay/i.test(quota)) { err.retryable = false; err.message += "（1日の枠が尽きました。日本時間の16〜17時に戻ります）"; }
    const ri = body?.error?.details?.find(d => String(d["@type"] || "").includes("RetryInfo"));
    const sec = parseFloat(ri?.retryDelay) || parseFloat((detail.match(/retry in ([\d.]+)\s*s/i) || [])[1]);
    if (sec > 0) err.retryAfterMs = Math.round(sec * 1000);
    throw err;
  }
  return body;
}
async function gemini(parts, extra, maxRetries = 5) {
  for (let i = 0; ; i++) {
    try { return await geminiOnce(parts, extra); }
    catch (e) {
      // 通信そのものが切れた（fetch failed など）ときも、待ってやり直す。動画つきの呼び出しは長いので切れやすい
      if (e.retryable === undefined && (e.name === "TypeError" || /fetch failed|network|socket|timeout/i.test(e.message))) e.retryable = true;
      if (!e.retryable || i >= maxRetries) throw e;
      const wait = Math.min(180000, Math.max(e.retryAfterMs || 0, 15000 * (i + 1), i >= 1 ? 60000 : 0));
      console.log(`  待機 ${Math.round(wait / 1000)}秒（${e.message}）`);
      await sleep(wait);
    }
  }
}
const geminiText = d => (d?.candidates?.[0]?.content?.parts || []).map(p => p.text).filter(Boolean).join("").trim();

/* ---------- YouTube ---------- */
async function yt(path, params) {
  const q = new URLSearchParams({ ...params, key: YT_KEY });
  const res = await fetch(`https://www.googleapis.com/youtube/v3/${path}?${q}`);
  if (!res.ok) throw new Error(`YouTube API ${res.status}: ${(await res.json().catch(() => null))?.error?.message || ""}`);
  return res.json();
}
const iso8601 = d => { // PT1H2M3S → 秒
  const m = String(d).match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  return m ? (+(m[1] || 0)) * 3600 + (+(m[2] || 0)) * 60 + (+(m[3] || 0)) : 0;
};
// すでに記録か台本がある動画
const doneVideoIds = () => new Set([
  ...listJson("videos").map(f => f.slice(0, -5)),
  ...listJson("scripts").map(f => f.split("_").slice(0, -1).join("_") || f.slice(0, 11)),
]);

// 記録が途中の動画（枠切れで止まったもの）。あれば新しく選ぶ前に仕上げる
function findIncomplete() {
  let best = null;
  for (const f of listJson("videos")) {
    const d = readJson("videos/" + f);
    if (!d || !d.meta?.duration) continue;
    const goal = d.goal || d.meta.duration;
    if ((d.covered || 0) < goal - 60 && (!best || (d.recordedAt || "") > (best.recordedAt || ""))) best = d;
  }
  return best;
}

async function pickVideo() {
  const url = (process.env.VIDEO_URL || "").trim();
  if (url) {
    const id = (url.match(/[?&]v=([\w-]{11})/) || url.match(/youtu\.be\/([\w-]{11})/) || [])[1];
    if (!id) throw new Error("VIDEO_URL から動画IDを読み取れませんでした: " + url);
    return id;
  }
  const done = doneVideoIds();
  const query = (process.env.QUERY || "").trim();
  if (query) {
    const sr = await yt("search", { part: "snippet", q: query + " ドライブ 車載", type: "video",
      videoDuration: "long", videoEmbeddable: "true", maxResults: "10" });
    const ids = sr.items.map(x => x.id.videoId).filter(id => id && !done.has(id));
    if (!ids.length) throw new Error("検索で候補が見つかりませんでした: " + query);
    const vs = await yt("videos", { part: "contentDetails", id: ids.join(",") });
    const len = new Map(vs.items.map(x => [x.id, iso8601(x.contentDetails.duration)]));
    const okIds = ids.filter(id => (len.get(id) || 0) >= 480);
    if (!okIds.length) throw new Error("検索候補がすべて短すぎました: " + query);
    if (process.env.LIST_ONLY === "true") {
      const titles = new Map(sr.items.map(x => [x.id.videoId, x.snippet.title]));
      writeCandidates(`「${query}」で探した候補`, okIds.map(id => ({ id, len: len.get(id), title: titles.get(id) || "" })));
      process.exit(0);
    }
    // 90分以内を優先する（長編で1日の枠を使い切らないため）
    const within = okIds.filter(id => len.get(id) <= 5400);
    const hit = within.length ? within[0] : okIds.sort((a, b) => len.get(a) - len.get(b))[0];
    console.log(`検索で選択: ${hit}（${fmtTime(len.get(hit))}）`);
    return hit;
  }
  if (!done.size) throw new Error("過去の動画がないため自動では選べません。VIDEO_URL を指定してください。");
  const seed = await yt("videos", { part: "snippet", id: [...done].slice(0, 20).join(",") });
  const channels = [...new Set(seed.items.map(x => x.snippet.channelId))];
  const listOnly = process.env.LIST_ONLY === "true", found = [];
  for (const ch of channels) {
    const cd = await yt("channels", { part: "contentDetails", id: ch });
    const uploads = cd.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    if (!uploads) continue;
    const pl = await yt("playlistItems", { part: "contentDetails", playlistId: uploads, maxResults: "20" });
    const ids = pl.items.map(x => x.contentDetails.videoId).filter(id => !done.has(id));
    if (!ids.length) continue;
    // 8分未満は除く。90分を超える長編も自動では選ばない
    const vs = await yt("videos", { part: "snippet,contentDetails", id: ids.join(",") });
    if (listOnly) {
      for (const x of vs.items) {
        const d = iso8601(x.contentDetails.duration);
        if (d >= 480) found.push({ id: x.id, len: d, title: x.snippet.title });
      }
      continue;
    }
    const ok = new Set(vs.items.filter(x => { const d = iso8601(x.contentDetails.duration); return d >= 480 && d <= 5400; }).map(x => x.id));
    const hit = ids.find(id => ok.has(id));
    if (hit) return hit;
  }
  if (listOnly) {
    if (!found.length) throw new Error("前に使ったチャンネルに、まだ見ていない新着がありませんでした。");
    writeCandidates("前に使ったチャンネルの新着", found.slice(0, 20));
    process.exit(0);
  }
  throw new Error("未使用の新着が見つかりませんでした。VIDEO_URL を指定してください。");
}

/* ---------- 記録の指示 ---------- */
const RECORD_SCHEMA = {
  type: "object",
  properties: {
    viewType: { type: "string", enum: ["pov", "person", "other"] },
    summary: { type: "string" },
    items: { type: "array", items: { type: "object",
      properties: {
        t: { type: "string" }, scene: { type: "string" }, text: { type: "string" }, place: { type: "string" },
        mood: { type: "string", enum: ["busy", "quiet", "stop"] },
        act: { type: "string", enum: ["straight", "turn_left", "turn_right", "curve_left", "curve_right", "stop", "start", "check_left", "check_right", "check_mirror", "bump"] },
        amount: { type: "number" }
      },
      required: ["t", "scene", "text", "place", "mood", "act", "amount"],
      propertyOrdering: ["t", "scene", "text", "place", "mood", "act", "amount"] } }
  },
  required: ["viewType", "summary", "items"],
  propertyOrdering: ["viewType", "summary", "items"]
};

function buildPrompt({ chunkSec, context, meta, chapters }) {
  const metaBlock = `
# 動画の情報
タイトル: ${meta.title}${meta.channelTitle ? `\nチャンネル: ${meta.channelTitle}` : ""}${meta.tags?.length ? `\nタグ: ${meta.tags.join("、")}` : ""}${meta.descriptionExcerpt ? `\n概要:\n${meta.descriptionExcerpt}` : ""}
ここに書かれている地名・道路名は、place に使ってよい。
`;
  const chapterBlock = chapters.length ? `
# この区間の章立て（投稿者による申告）
${chapters.map(c => `${fmtTime(c.t)} ${c.label}`).join("\n")}
` : "";
  return `あなたは車載カメラのドライブ動画を見て、記録を取る係です。**セリフや感想は書きません。**
あとで別の書き手が、この記録だけを頼りに実況と雑談の台本を書きます。書き手は映像を見られないので、
書き手が「いま何が見えているか」を思い浮かべられるように、見えたものをそのまま書き留めてください。
${metaBlock}${chapterBlock}
# 記録の取り方
- **20〜40秒に1件**を目安に記録する。景色・道路の種類・天候・交通の様子・標識が変わった瞬間と、
  停止・発進・右左折は必ず記録する。変化がなくても40秒以上は空けない
- t: この区間の先頭を 0:00 とした MM:SS 形式（区間の長さは約${Math.round(chunkSec / 60)}分。0:00〜${fmtTime(chunkSec)} の範囲で書く）
- scene: その時点で見えているものを、1〜2文で具体的に書く。
  道路の作り（車線の数・高架・トンネル・橋・坂）、周りの車、建物や店、歩行者、空の色と光の当たり方、路面、聞こえる音。
  「きれい」「活気がある」のような感想や評価は書かない。見えた事実だけを書く
- text: 標識・案内板・看板・路面の文字で、**読み取れたもの**をそのまま書く（例：「横浜 26km」「←羽田空港」）。読めなければ空文字
- place: 地名・交差点名・道路名・駅名。読み取れたものか、動画の情報にあるものだけ。分からなければ空文字。
  実在しない地名・施設・道路名を作らない
- mood: その時点から次の記録までの様子
  - "busy"  … 見どころ・標識・曲がり角が続いている
  - "quiet" … 単調で変化が少ない（長い直線、同じ景色、トンネルの中、壁に囲まれた区間）
  - "stop"  … 信号待ちや渋滞で止まっている
- act: その時点の運転操作。amount は turn_left / turn_right / curve_left / curve_right のときのハンドルの切り量（0.0〜1.0）。それ以外は 0
- 季節・時間帯・天候は、最初に判断したものを途中で変えない
${context ? `\n# 直前の区間までの流れ\n${context}\n` : ""}
- summary: 次の区間に引き継ぐために、季節・時間帯・天候の判断と、ここまでの道のりを3行以内で書く
- viewType: 映像の種類
  - "pov"：前方の道路を映した車載視点。運転者は映らず、話し声も入っていない
  - "person"：運転者や同乗者が画面に映っている、または人の話し声が入っている
  - "other"：それ以外（地図の画面だけ、静止画など）`;
}

/* ---------- 本体 ---------- */
const incomplete = (process.env.VIDEO_URL || "").trim() ? null : findIncomplete();
const videoId = incomplete ? incomplete.videoId : await pickVideo();
const path = `videos/${videoId}.json`;
const prev = incomplete || readJson(path);
if (incomplete) console.log(`記録が途中の動画の続きから始めます（${fmtTime(incomplete.covered || 0)} まで済み）`);
console.log("対象動画: https://www.youtube.com/watch?v=" + videoId);

const v = (await yt("videos", { part: "snippet,contentDetails", id: videoId })).items?.[0];
if (!v) throw new Error("動画情報を取得できませんでした");
const duration = iso8601(v.contentDetails.duration);
const meta = {
  title: v.snippet.title, channelTitle: v.snippet.channelTitle,
  tags: (v.snippet.tags || []).slice(0, 10),
  descriptionExcerpt: cleanDescription(v.snippet.description),
  duration
};
const chapters = parseChapters(v.snippet.description);
console.log(`タイトル: ${meta.title} ／ 長さ ${fmtTime(duration)} ／ 章立て ${chapters.length}件`);

const minutes = parseInt(process.env.MINUTES || "0", 10) || 0;
const goal = minutes > 0 ? Math.min(duration, minutes * 60) : duration;
const start = prev?.covered || 0;
if (goal <= start) { console.log("すでに指定の長さまで記録されています。"); process.exit(0); }
console.log(`記録する範囲: ${fmtTime(start)}〜${fmtTime(goal)}`);

const rec = {
  videoId, model: MODEL, recordedAt: new Date().toISOString(),
  goal, covered: start, viewType: prev?.viewType || "", context: prev?.context || "",
  meta, chapters, items: prev?.items ? [...prev.items] : []
};
const save = () => {
  mkdirSync("videos", { recursive: true });
  rec.items.sort((a, b) => a.abs - b.abs);
  rec.recordedAt = new Date().toISOString();
  writeFileSync(path, JSON.stringify(rec, null, 2) + "\n");
};

const nChunks = Math.ceil((goal - start) / CHUNK_SEC);
let failed = "";
for (let i = 0; i < nChunks; i++) {
  const s = start + i * CHUNK_SEC, e = Math.min(goal, s + CHUNK_SEC);
  console.log(`[${i + 1}/${nChunks}] ${fmtTime(s)}〜${fmtTime(e)} を見ています...`);
  let r;
  try {
    const d = await gemini([
      { fileData: { fileUri: `https://www.youtube.com/watch?v=${videoId}`, mimeType: "video/*" },
        videoMetadata: { startOffset: `${s}s`, endOffset: `${e}s` } },
      { text: buildPrompt({ chunkSec: e - s, context: rec.context, meta,
          chapters: chapters.filter(c => c.t >= s && c.t < e).map(c => ({ ...c, t: c.t - s })) }) }
    ], { generationConfig: { responseMimeType: "application/json", responseSchema: RECORD_SCHEMA } });
    r = JSON.parse(geminiText(d));
  } catch (e2) {
    failed = e2.message;
    console.log(`  打ち切り: ${failed}`);
    break;
  }
  if (i === 0 && !start) {
    rec.viewType = r.viewType || "pov";
    if (rec.viewType === "person") {
      console.log("運転者や話し声が入っている動画のため、ここで中止します（別の動画で作り直してください）");
      process.exit(2);
    }
    if (rec.viewType !== "pov") console.log(`  注意: 映像の種類が ${rec.viewType} と判定されました`);
  }
  let n = 0;
  for (const it of (r.items || [])) {
    let rel = parseTime(it.t);
    if (rel === null) continue;
    // 区間の先頭を0:00とせず、動画全体の時刻で返してくることがある。区間の中に収まるほうに読み替える
    if (rel > (e - s) + 5 && rel >= s - 5 && rel <= e + 5) rel -= s;
    if (rel < 0 || rel > (e - s) + 5) continue;   // どちらにも収まらない時刻は捨てる
    const abs = Math.min(e, s + rel);
    rec.items.push({ t: fmtTime(abs), abs, scene: it.scene || "", text: it.text || "", place: it.place || "",
                     mood: it.mood || "busy", act: it.act || "straight", amount: it.amount || 0 });
    n++;
  }
  rec.context = r.summary || rec.context;
  rec.covered = e;
  save();   // 1区間ごとに残す。次の区間で枠が尽きても、ここまでは失われない
  console.log(`  → ${n}件（${fmtTime(e)} まで保存）`);
  // 動画つきの呼び出しは1回で10万トークン級。続けて投げると1分あたりの上限に当たるので間を置く
  if (e < goal) { console.log("  次の区間まで30秒待ちます"); await sleep(30000); }
}

if (rec.covered <= start) { console.error("1区間も記録できませんでした: " + failed); process.exit(1); }
console.log(rec.covered >= goal
  ? `完了: ${path}（${rec.items.length}件・${fmtTime(rec.covered)} まで）`
  : `途中まで: ${path}（${fmtTime(rec.covered)} まで）。もう一度実行すると続きから記録します`);
// 途中で止まったことを呼び出し側（ワークフロー）に伝える。依頼は消さずに残し、次の実行で続きから記録する
if (rec.covered < goal) process.exit(3);
