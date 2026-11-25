// 動画の題・チャンネル名などを取り直す（Node / 依存なし。Gemini は使わない）
//
// YouTube の決まりで、API で取った情報は30日までしか取っておけない。過ぎる前に取り直す。
//   https://developers.google.com/youtube/terms/developer-policies （III.E.4）
// 使い方: node tools/refresh-meta.mjs [何日たったものを取り直すか（既定 25）]
//   ふだんは Actions（watch-video の毎日の実行）が呼ぶ。必要な環境変数: YOUTUBE_API_KEY
//   書き換えるもの: videos/*.json・scripts/*.json の meta と chapters、scripts/_index.json の題とチャンネル名
//   動画が見られなくなっていたら、題や説明を消す（台本と声は残る）

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";

const KEY = process.env.YOUTUBE_API_KEY || "";
const DAYS = Number(process.argv[2] || 25);
if (!KEY) { console.log("YOUTUBE_API_KEY がないので、動画の題は取り直しません"); process.exit(0); }
const json = p => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
const save = (p, d) => writeFileSync(p, JSON.stringify(d, null, 2) + "\n");
const list = d => existsSync(d) ? readdirSync(d).filter(f => f.endsWith(".json") && !f.startsWith("_")) : [];

// watch-video.mjs と同じ読み方
const parseTime = t => { const p = t.split(":").map(Number); return p.some(isNaN) ? null : p.reduce((a, b) => a * 60 + b, 0); };
function parseChapters(desc) {
  const found = [];
  for (const raw of String(desc).split(/\r?\n/)) {
    const m = raw.match(/^\s*[[(（]?(\d{1,3}:\d{2}(?::\d{2})?)[\])）]?\s*(.+?)\s*$/);
    if (!m) continue;
    const t = parseTime(m[1]), label = m[2].replace(/^[-–—~〜:：・\s]+/, "").trim();
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

const now = Date.now();
const old = r => { const t = Date.parse(r?.metaAt || r?.recordedAt || r?.generatedAt || ""); return !(now - t < DAYS * 86400000); };
const recs = new Map(list("videos").map(f => [f.slice(0, -5), json(`videos/${f}`)]).filter(([, r]) => r?.meta));
const scripts = list("scripts").map(f => [f, json(`scripts/${f}`)]).filter(([, s]) => s?.videoId && s.meta);
const due = [...new Set([...[...recs].filter(([, r]) => old(r)).map(([id]) => id), ...scripts.filter(([, s]) => old(s)).map(([, s]) => s.videoId)])];
if (!due.length) { console.log("動画の題は、まだ新しいので取り直しません"); process.exit(0); }

const got = new Map();
for (let i = 0; i < due.length; i += 50) {
  const q = new URLSearchParams({ part: "snippet", id: due.slice(i, i + 50).join(","), key: KEY });
  const res = await fetch(`https://www.googleapis.com/youtube/v3/videos?${q}`);
  if (!res.ok) { console.error(`動画の題を取り直せませんでした（YouTube API ${res.status}）`); process.exit(1); }
  for (const v of (await res.json()).items || []) got.set(v.id, v.snippet);
}
const stamp = new Date(now).toISOString();
const index = json("scripts/_index.json") || {};
for (const id of due) {
  const s = got.get(id);
  const apply = r => {
    const before = r.meta;
    r.meta = s
      ? { ...before, title: s.title, channelTitle: s.channelTitle, tags: (s.tags || []).slice(0, 10), descriptionExcerpt: cleanDescription(s.description) }
      : { title: "見られなくなった動画", channelTitle: "", tags: [], descriptionExcerpt: "", duration: before.duration };
    r.chapters = s ? parseChapters(s.description) : [];
    r.metaAt = stamp;
    return before.title;
  };
  if (recs.has(id)) { const r = recs.get(id); apply(r); save(`videos/${id}.json`, r); }
  for (const [f, sc] of scripts) if (sc.videoId === id) {
    const was = apply(sc);
    save(`scripts/${f}`, sc);
    const e = index[f.slice(0, -5)];
    if (e) {
      if (!e.label || e.label === was || e.label === e.videoTitle) e.label = sc.meta.title;   // 自分で付けた名前は変えない
      e.videoTitle = sc.meta.title; e.channel = sc.meta.channelTitle;
    }
  }
  console.log(`${s ? "取り直しました" : "見られなくなっていたので消しました"}: ${id}`);
}
if (Object.keys(index).length) save("scripts/_index.json", index);
