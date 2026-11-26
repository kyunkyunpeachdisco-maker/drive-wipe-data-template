// URL で見せる台本の、公開用のファイルを作る（Node / 依存なし）
//
// 使い方: node tools/build-share.mjs <出力先のフォルダ>
//   読むもの: share/list.txt（見せる台本の名前を1行に1つ）、scripts/ audio/ articles/ avatar/
//   作るもの: <出力先>/index.json・scripts/<名前>.json・audio/<名前>/…・avatar/…
//   Actions の share.yml が、作ったフォルダを GitHub Pages に出す。リポジトリそのものは非公開のまま。
//
// 公開されるのは、share/list.txt に書いた台本と、その声、話した記事の題とURL、アバターだけ。
// 広告のあいだの小話も、少し入れる（共有している動画の話と、新しいものから）。
// 映像の記録（scene）・人物像（persona）・記事の本文は入れない。
// アバターのモデルは、VRM の中に「再配布してよい」と書かれているときだけ入れる。

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, copyFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const out = process.argv[2];
if (!out) { console.error("使い方: node tools/build-share.mjs <出力先のフォルダ>"); process.exit(1); }
const readSafe = p => { try { return readFileSync(p, "utf8"); } catch { return ""; } };
const json = p => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
const put = (p, data) => { mkdirSync(p.replace(/\/[^/]*$/, ""), { recursive: true }); writeFileSync(p, data); };

// 公開するのは日付まで。作った時刻は出さない
const dayOf = iso => { const d = new Date(iso || ""); return isNaN(d) ? "" : d.toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" }); };

const keys = [...new Set(readSafe("share/list.txt").split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith("#")))];
const index = json("scripts/_index.json") || {};
const settings = json("avatar/settings.json") || {};

// 話した記事（articles/ の「使った台本:」に、この台本の名前があるもの）
const articles = existsSync("articles") ? readdirSync("articles").filter(f => f.endsWith(".md")).map(f => {
  const t = readSafe(`articles/${f}`);
  return { title: (t.match(/^#\s*(.+)$/m) || [])[1] || "", url: ((t.match(/^-\s*URL:\s*(\S+)/m) || [])[1] || "").replace(/#\d{4}-\d{2}-\d{2}$/, ""),
           used: ((t.match(/^-\s*使った台本:\s*(.*)$/m) || [])[1] || "").split(/[、,\s]+/) };
}) : [];

// 声：アプリで選んでいる声（VOICEVOX）があればそれ、なければフォルダ名の降順で最初のもの。
// 自分の声（own-）は、avatar/settings.json の "share-own-voice": true のときだけ公開する
function pickVoice(key) {
  const dir = `audio/${key}`;
  if (!existsSync(dir)) return null;
  const all = readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory() && existsSync(`${dir}/${d.name}/index.json`)).map(d => d.name).sort().reverse();
  const own = all.filter(t => t.startsWith("own-")), takes = all.filter(t => !t.startsWith("own-"));
  if (settings["share-own-voice"] === true && own.length) return own[0];
  const want = `voicevox-${settings["player-voice-voicevox"] || ""}`;
  return takes.find(t => t === want || t.startsWith(want + "_")) || takes[0] || null;
}

const items = [];
for (const key of keys) {
  if (!/^[\w-]{1,80}$/.test(key)) { console.log(`名前の形が違うので飛ばします: ${key}`); continue; }
  const s = json(`scripts/${key}.json`);
  if (!s) { console.log(`台本が見つからないので飛ばします: ${key}`); continue; }
  const info = index[key] || {};
  const ok = a => a && typeof a.url === "string" && /^https?:\/\//.test(a.url);
  const sources = Array.isArray(s.sources) && s.sources.some(ok)
    ? s.sources.filter(ok).map(a => ({ title: String(a.title || ""), url: a.url }))
    : articles.filter(a => a.used.includes(key) && ok(a)).map(a => ({ title: a.title, url: a.url }));
  let voice = null;
  const take = pickVoice(key);
  if (take) {
    const meta = json(`audio/${key}/${take}/index.json`);
    const lines = new Set(s.items.filter(it => it.line).map(it => it.line));
    const use = (meta?.items || []).filter(it => lines.has(it.text) && /^[0-9a-f]{6,64}$/.test(it.h) && /^[a-z0-9]{2,5}$/.test(it.ext || "") && existsSync(`audio/${key}/${take}/${it.h}.${it.ext}`));
    for (const it of use) { mkdirSync(`${out}/audio/${key}`, { recursive: true }); copyFileSync(`audio/${key}/${take}/${it.h}.${it.ext}`, `${out}/audio/${key}/${it.h}.${it.ext}`); }
    voice = { engine: meta.engine || "", name: meta.voiceName || meta.label || "", count: use.length };
    put(`${out}/audio/${key}/index.json`, JSON.stringify({ ...voice, items: use.map(({ h, ext, enc, rate }) => ({ h, ext, enc, rate })) }));
  }
  // アプリが再生に使うものだけを写す
  put(`${out}/scripts/${key}.json`, JSON.stringify({
    videoId: s.videoId, start: s.start || 0, end: s.end, covered: s.covered, ...(s.edition ? { edition: s.edition } : {}), ...(s.title ? { title: s.title } : {}),
    meta: { title: s.meta?.title || "", channelTitle: s.meta?.channelTitle || "", duration: s.meta?.duration || 0 },
    generatedAt: dayOf(s.generatedAt), chapters: s.chapters || [],
    topics: (s.topics || []).map(({ title, start, end, url, article }) => ({ title, start, end, ...(ok({ url }) ? { url, article: String(article || "") } : {}) })), sources, voice,
    items: s.items.map(({ t, abs, line, kind, act, amount, place, face, gesture, marks, follow }) =>
      ({ t, abs, line, kind, act, amount, place, ...(face ? { face } : {}), ...(gesture ? { gesture } : {}), ...(Array.isArray(marks) ? { marks } : {}), ...(follow ? { follow: true } : {}) })),
  }));
  items.push({ key, videoId: s.videoId, label: info.label || s.meta?.title || key, title: s.title || "", end: s.covered ?? s.end, topics: (s.topics || []).map(t => t.title) });
  console.log(`入れました: ${key}（声 ${voice ? voice.count + "件・" + voice.name : "なし"}／記事 ${sources.length}本）`);
}

// 広告のあいだの小話。共有している動画の話と、いつでも使える話・記事の話の新しいものから
const all = json("talks/index.json")?.talks || [];
const vids = new Set(items.map(i => i.videoId));
// 声がまだできていない話は、新しくても後回しにする（見る人には字幕だけで出てしまう）
const tTake = pickVoice("talks"), tMeta = tTake ? json(`audio/talks/${tTake}/index.json`) : null;
const voiced = new Set((tMeta?.items || []).filter(it => existsSync(`audio/talks/${tTake}/${it.h}.${it.ext}`)).map(it => it.text));
const hasVoice = t => !tMeta || t.lines.every(l => voiced.has(l.line));
const newest = kind => all.filter(t => t.kind === kind && t.when !== "go" && t.when !== "back" && hasVoice(t)).sort((a, b) => (b.addedAt || "").localeCompare(a.addedAt || "")).slice(0, 10);
const talks = items.length ? [...new Set([...all.filter(t => t.kind === "video" ? vids.has(t.videoId) : t.when === "go" || t.when === "back"), ...newest("any"), ...newest("article")])] : [];
if (talks.length) {
  put(`${out}/talks.json`, JSON.stringify({ version: 1, talks: talks.map(t => ({ ...t, addedAt: dayOf(t.addedAt) })) }));
  const take = tTake;
  if (take) {
    const meta = tMeta, want = new Set(talks.flatMap(t => t.lines.map(l => l.line)));
    const use = (meta?.items || []).filter(it => want.has(it.text) && /^[0-9a-f]{6,64}$/.test(it.h) && /^[a-z0-9]{2,5}$/.test(it.ext || "") && existsSync(`audio/talks/${take}/${it.h}.${it.ext}`));
    mkdirSync(`${out}/audio/talks`, { recursive: true });
    for (const it of use) copyFileSync(`audio/talks/${take}/${it.h}.${it.ext}`, `${out}/audio/talks/${it.h}.${it.ext}`);
    put(`${out}/audio/talks/index.json`, JSON.stringify({ engine: meta.engine || "", name: meta.voiceName || "", items: use.map(({ h, ext, enc, rate }) => ({ h, ext, enc, rate })) }));
  }
  console.log(`小話を入れました: ${talks.length}本`);
}

// アバター。調整値は player- で始まるものだけ。モデルは、再配布が許されているときだけ
const avatar = { settings: false, vrm: false };
if (items.length) {
  const mine = Object.fromEntries(Object.entries(settings).filter(([k, v]) => k.startsWith("player-") && typeof v === "string" && v.length < 200));
  if (Object.keys(mine).length) { put(`${out}/avatar/settings.json`, JSON.stringify(mine)); avatar.settings = true; }
  if (existsSync("avatar/model.vrm")) {
    const why = vrmCanShare(readFileSync("avatar/model.vrm"));
    if (why === true) {
      // 中身が変わったときだけ名前が変わるので、見る人の端末に取っておける
      const name = `model-${createHash("sha256").update(readFileSync("avatar/model.vrm")).digest("hex").slice(0, 10)}.vrm`;
      mkdirSync(`${out}/avatar`, { recursive: true });
      if (!lighten("avatar/model.vrm", `${out}/avatar/${name}`)) copyFileSync("avatar/model.vrm", `${out}/avatar/${name}`);
      avatar.vrm = true; avatar.vrmFile = name;
    }
    else console.log(`アバターのモデルは入れません（${why}）。見る人には、簡単な絵の顔で出ます。`);
  }
}
put(`${out}/index.json`, JSON.stringify({ version: 1, items, avatar }));
put(`${out}/index.html`, `<!doctype html><meta charset="utf-8"><title>ドライブ実況ワイプ</title><p>ドライブ実況ワイプで公開している台本の置き場です。</p>`);
console.log(`公開する台本: ${items.length}本`);

// 絵を縮めた軽いモデルを作る。Python と Pillow が使えないときは false（元のまま公開する）
function lighten(from, to) {
  const py = ["python3", "python"].find(c => spawnSync(c, ["--version"]).status === 0);
  if (!py) return false;
  if (spawnSync(py, ["-c", "import PIL"]).status !== 0) spawnSync(py, ["-m", "pip", "install", "--quiet", "--user", "--break-system-packages", "pillow"]);
  const r = spawnSync(py, ["tools/light-vrm.py", from, to], { encoding: "utf8", env: { ...process.env, PYTHONUTF8: "1" } });
  console.log((r.stdout || r.stderr || "").trim().split("\n").pop());
  return r.status === 0 && existsSync(to);
}

// VRM の中の利用条件を読む。再配布してよいと読み取れたときだけ true。そうでなければ理由の文
function vrmCanShare(buf) {
  try {
    if (buf.toString("latin1", 0, 4) !== "glTF") return "VRM の形で読めません";
    const len = buf.readUInt32LE(12);
    const ext = JSON.parse(buf.toString("utf8", 20, 20 + len)).extensions || {};
    const m1 = ext.VRMC_vrm?.meta, m0 = ext.VRM?.meta;
    if (m1) return m1.allowRedistribution === true ? true : "モデルの利用条件で、再配布が許されていません";
    if (m0) {
      const urls = `${m0.otherLicenseUrl || ""} ${m0.otherPermissionUrl || ""}`;
      if (/[?&]redistribution=allow(&|$|\s)/.test(urls)) return true;
      if (["CC0", "CC_BY", "CC_BY_NC", "CC_BY_SA", "CC_BY_NC_SA"].includes(m0.licenseName)) return true;
      return "モデルの利用条件から、再配布してよいと読み取れません";
    }
    return "モデルに利用条件が書かれていません";
  } catch (e) { return "モデルの利用条件を読めません"; }
}
