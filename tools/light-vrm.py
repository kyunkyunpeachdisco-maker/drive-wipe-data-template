# VRM の絵（テクスチャ）を縮めて、共有用の軽いモデルを作る
#
# 使い方: python3 tools/light-vrm.py <元.vrm> <出力.vrm> [いちばん長い辺のピクセル（既定 1024）]
#   必要なもの: Pillow。build-share.mjs が呼ぶ。形・骨・表情・利用条件は変えない
import io, json, struct, sys
from PIL import Image

src, dst = sys.argv[1], sys.argv[2]
limit = int(sys.argv[3]) if len(sys.argv) > 3 else 1024
b = open(src, "rb").read()
if b[:4] != b"glTF" or b[16:20] != b"JSON":
    sys.exit("VRM の形で読めません")
n = struct.unpack("<I", b[12:16])[0]
j = json.loads(b[20:20 + n])
if b[24 + n:28 + n] != b"BIN\0":
    sys.exit("中身のデータがありません")
size = struct.unpack("<I", b[20 + n:24 + n])[0]
data = b[28 + n:28 + n + size]
views = j["bufferViews"]
raw = [data[v.get("byteOffset", 0):v.get("byteOffset", 0) + v["byteLength"]] for v in views]

done = 0
for im in j.get("images", []):
    i = im.get("bufferView")
    if i is None:
        continue
    try:
        p = Image.open(io.BytesIO(raw[i]))
        p.load()
    except Exception:
        continue
    if max(p.size) > limit:
        k = limit / max(p.size)
        p = p.resize((max(1, round(p.width * k)), max(1, round(p.height * k))), Image.LANCZOS)
    o = io.BytesIO()
    if im.get("mimeType") == "image/jpeg":
        p.convert("RGB").save(o, "JPEG", quality=88)
    else:
        p.save(o, "PNG", optimize=True)
    if len(o.getvalue()) < len(raw[i]):
        raw[i] = o.getvalue()
        done += 1

out, at = [], 0
for v, r in zip(views, raw):
    v["byteOffset"] = at
    v["byteLength"] = len(r)
    pad = b"\0" * (-len(r) % 4)
    out.append(r + pad)
    at += len(r) + len(pad)
binary = b"".join(out)
j["buffers"][0]["byteLength"] = len(binary)
js = json.dumps(j, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
js += b" " * (-len(js) % 4)
with open(dst, "wb") as f:
    f.write(struct.pack("<4sII", b"glTF", 2, 12 + 8 + len(js) + 8 + len(binary)))
    f.write(struct.pack("<I4s", len(js), b"JSON") + js)
    f.write(struct.pack("<I4s", len(binary), b"BIN\0") + binary)
print(f"軽くしました: {len(b) / 1e6:.1f}MB → {(28 + len(js) + len(binary)) / 1e6:.1f}MB（絵 {done}枚）")
