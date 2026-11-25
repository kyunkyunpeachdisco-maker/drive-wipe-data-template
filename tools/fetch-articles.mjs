// 記事の取り込み（Node 20 / 依存なし・AIを使わない）
//
// データリポジトリの character/feeds.md に書かれたフィード（RSS/Atom）や一覧ページから新着を拾い、
// 本文をそのまま articles/<記事>.md に置く。要約や感想はここでは作らない。
// 台本を書くときに、Claude Code がこの本文を読んで雑談の材料にする。
//
// 使い方: データリポジトリの中で実行する（GitHub Actions の watch-video.yml から）。
//   PER_FEED      1つのフィードから拾う本数（既定3）
//   ARTICLE_URLS  空白区切りの記事のURL。書くと、フィードは見ずに、その記事だけを取り込む
//
// 出力: articles/<記事>.md（タイトル・URL・取得日・本文）。同じURLは取り直さない

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";

const PER_FEED = parseInt(process.env.PER_FEED || "3", 10) || 3;
const BODY_MAX = 8000;
const readSafe = p => { try { return readFileSync(p, "utf8"); } catch { return ""; } };

function slug(url) {
  let h = 0;
  for (let i = 0; i < url.length; i++) h = (h * 31 + url.charCodeAt(i)) >>> 0;
  const base = url.replace(/^https?:\/\//, "").replace(/[?#].*$/, "").replace(/\/+$/, "")
    .replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  const day = (url.match(/#(\d{4}-\d{2}-\d{2})$/) || [])[1];   // 一覧ページは日ごとに別の名前にする
  return `${base || "page"}${day ? "-" + day : ""}-${h.toString(36)}`;
}

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decode = t => t
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, n) => ENT[n]);
const cdata = t => t.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
// 段落の切れ目は残して、タグを落とす
const toText = html => decode(decode(cdata(html))
  .replace(/<(script|style|noscript|svg|nav|header|footer|form)[\s\S]*?<\/\1>/gi, " ")
  .replace(/<\/(p|div|li|h[1-6]|blockquote|tr)>|<br\s*\/?>/gi, "\n")
  .replace(/<[^>]+>/g, " "))
  .replace(/[ \t　]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{2,}/g, "\n").trim();

// botを弾くサイトがあるので、一般的なブラウザのUAで取りに行く
async function fetchPage(url) {
  const get = async (u, more = {}) => {
    const res = await fetch(u, { headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", ...more,
    }, redirect: "follow" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  };
  // Actions からの読み取りを断るサイト（ココログなど）は、回り道をせずに読まない。
  // 読みたいときは、自分のPCで node tools/fetch-articles.mjs を実行して、articles/ を保存する
  return get(url);
}

// フィードなら項目を読む。本文がフィードに入っていればそれも持ち帰る
async function listFeed(url) {
  const body = await fetchPage(url);
  const out = [];
  if (/<(rss|feed|rdf:RDF)[\s>]/i.test(body)) {
    for (const [, , b] of body.matchAll(/<(item|entry)[\s>]([\s\S]*?)<\/\1>/gi)) {
      const link = (b.match(/<link[^>]*rel="alternate"[^>]*href="([^"]+)"/i) || b.match(/<link[^>]*href="([^"]+)"/i)
                 || b.match(/<link[^>]*>([^<]+)<\/link>/i) || [])[1];
      const title = (b.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "";
      const content = (b.match(/<content:encoded[^>]*>([\s\S]*?)<\/content:encoded>/i)
                    || b.match(/<content[^>]*>([\s\S]*?)<\/content>/i) || [])[1] || "";
      if (link) out.push({ url: decode(cdata(link)).trim(), title: toText(title), text: toText(content) });
      if (out.length >= PER_FEED * 3) break;
    }
    return out;
  }
  if (/\.(xml|rdf|rss|atom)(\?|$)/i.test(url)) throw new Error("フィードの形で読めませんでした");
  // ふつうのページ（人気順の一覧など）は、記事を1本ずつ見分けられないので、ページの文章をまるごと1件として持ち帰る
  const title = toText((body.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "") || url;
  const main = (body.match(/<main[\s>][\s\S]*<\/main>/i) || body.match(/<body[\s>][\s\S]*<\/body>/i) || [body])[0];
  const day = new Date().toISOString().slice(0, 10);
  out.push({ url: `${url}#${day}`, title: `${title}（${day} の一覧）`, text: toText(main), whole: true });
  return out;
}

async function articleText(url) {
  const html = await fetchPage(url);
  const main = (html.match(/<article[\s>][\s\S]*<\/article>/i) || html.match(/<main[\s>][\s\S]*<\/main>/i) || [html])[0];
  const title = toText((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "");
  return { title, text: toText(main) };
}

/* ---------- 本体 ---------- */
const feeds = [...new Set(readSafe("character/feeds.md").replace(/<!--[\s\S]*?-->/g, "").match(/https?:\/\/\S+/g) || [])];
const urls = (process.env.ARTICLE_URLS || "").match(/https?:\/\/\S+/g) || [];
if (!feeds.length && !urls.length) { console.log("character/feeds.md にフィードがありません。"); process.exit(0); }

// すでに取り込んだURL（以前の方式で読んだ character/reads も含める）
const known = new Set();
for (const dir of ["articles", "character/reads"]) {
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir)) {
    const u = (readSafe(`${dir}/${f}`).match(/^-\s*URL:\s*(\S+)/m) || [])[1];
    if (u) known.add(u);
  }
}

function save(url, title, text) {
  if (text.length < 200) throw new Error("本文がほとんど取れませんでした");
  mkdirSync("articles", { recursive: true });
  writeFileSync(`articles/${slug(url)}.md`,
    `# ${title || url}

- URL: ${url}
- 取得日: ${new Date().toISOString().slice(0, 10)}
- 使った台本: （まだ）

## 本文

${text.slice(0, BODY_MAX)}
`);
  known.add(url);
}

if (urls.length) {
  let failed = 0;
  for (const url of urls) {
    if (known.has(url)) { console.log(`もうあります: ${url}`); continue; }
    try {
      const a = await articleText(url);
      save(url, a.title, a.text);
      console.log(`取り込み: ${a.title || url}`);
    } catch (e) { failed++; console.log(`読めませんでした: ${url}（${e.message}）`); }
  }
  process.exit(failed ? 5 : 0);
}

let added = 0;
for (const f of feeds) {
  console.log(`フィードを見ています: ${f}`);
  let items = [];
  try { items = await listFeed(f); }
  catch (e) { console.log(`  読めませんでした（${e.message}）`); continue; }
  let n = 0;
  for (const it of items) {
    if (n >= PER_FEED) break;
    if (known.has(it.url)) continue;
    try {
      let { title, text } = it;
      if (text.length < 400 && !it.whole) {   // フィードに本文が入っていなければ、記事のページを読む
        const a = await articleText(it.url);
        text = a.text; title = title || a.title;
      }
      save(it.url, title, text);
      n++; added++;
      console.log(`  取り込み: ${title || it.url}`);
    } catch (e) { console.log(`  読めませんでした: ${it.title || it.url}（${e.message}）`); }
  }
}
console.log(`新しく ${added}件を取り込みました`);
