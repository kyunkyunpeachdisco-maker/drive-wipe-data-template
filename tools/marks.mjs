// セリフの印（表情・しぐさ・手）を読む。assemble-script.mjs と assemble-talks.mjs が使う
//
//   [笑う] それ、わたしもやったことある。          セリフのはじめから笑う
//   紹介する力と料理する力は別物、って書いてあって、[笑う]笑った。   途中から笑う
//   [驚く] えっ、そうなの。[ふつう]まあ、いいか。    途中で元に戻す
// 印は声にも字幕にも出ない。印を足しても、セリフの文字は変わらないので、声は作り直しにならない。

export const FACES = { "笑う": "smile", "微笑む": "soft", "大笑い": "laugh", "驚く": "surprised", "困る": "troubled", "むっとする": "pout", "ふつう": "none" };
export const GESTURES = { "うなずく": "nod", "首をかしげる": "tilt", "首を振る": "shake", "ちらっと横を見る": "glance" };
export const HANDS = { "手を振る": "wave", "片手を上げる": "raise", "指をさす": "point" };
const PLACES = 3;   // 1つのセリフで、印を書ける場所の数

export function markList(hands) {
  return `表情: ${Object.keys(FACES).join("、")}／しぐさ: ${Object.keys(GESTURES).join("、")}` + (hands ? `／手: ${Object.keys(HANDS).join("、")}` : "");
}

// 返すもの: { line, face, gesture, hand, marks, errors }
//   face・gesture・hand はセリフのはじめの印。marks は途中の印 [{ at: 何文字目の前か, face, gesture, hand }]
export function parseMarks(text, { hands = false } = {}) {
  const errors = [], spots = [];
  let line = "", cur = null;
  const re = /[[［]\s*([^\]］]*?)\s*[\]］]\s*/g;
  let last = 0, m;
  const src = text.trim();
  while ((m = re.exec(src))) {
    line += src.slice(last, m.index);
    last = m.index + m[0].length;
    const w = m[1], at = [...line].length;
    if (!cur || cur.at !== at) { cur = { at }; spots.push(cur); }
    const put = (k, v, what) => { if (cur[k]) errors.push(`${what}の印は、1か所に1つまでです（${w}）`); else cur[k] = v; };
    if (FACES[w]) put("face", FACES[w], "表情");
    else if (GESTURES[w]) put("gesture", GESTURES[w], "しぐさ");
    else if (hands && HANDS[w]) put("hand", HANDS[w], "手");
    else errors.push(`「[${w}]」は使えない印です。使える印 → ${markList(hands)}`);
  }
  line = (line + src.slice(last)).trim();
  if (/[[\]［］]/.test(line)) errors.push(`角かっこは、印だけに使います → ${line.slice(0, 30)}`);
  if (!line && spots.length) errors.push("印のあとにセリフがありません");
  if (spots.length > PLACES) errors.push(`印を書けるのは、1つのセリフに${PLACES}か所までです`);
  if (line && spots.some(s => s.at >= [...line].length)) errors.push("セリフの終わりには、印を書けません");
  const head = spots.find(s => s.at === 0) || {}, marks = spots.filter(s => s.at > 0);
  return { line, errors, ...(head.face ? { face: head.face } : {}), ...(head.gesture ? { gesture: head.gesture } : {}), ...(head.hand ? { hand: head.hand } : {}), ...(marks.length ? { marks } : {}) };
}
