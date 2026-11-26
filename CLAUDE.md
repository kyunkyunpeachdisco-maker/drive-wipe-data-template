# データリポジトリ

ドライブ実況ワイプ（drive-wipe）の台本と、その材料・音声の置き場です。
**台本のセリフは、このリポジトリを開いたAIエージェントが書きます**（手順は `台本の書き方.md`）。

## 全体の流れ

1. **材料が届く**（自動・AIの課金なし）：`videos/request.txt` に動画のURLを書いて保存すると、Actions `watch-video` が
   - フィードの新着記事の本文を `articles/` に置く
   - 動画を Gemini に見せて「何分何秒に何が映っているか」を `videos/` に記録する（動画1本につき1度きり）
2. **セリフを書く**（AIエージェント）：`videos/` と `articles/` を読んで `lines/<動画ID>/` にセリフを書き、
   `node tools/assemble-script.mjs <動画ID> <台本の名前>` で `scripts/` の台本にする
3. **声を付ける**（頼まれたとき・無料）：`audio/request.txt` に台本の名前を書いて保存すると、Actions `make-audio` が VOICEVOX で音声を作る
4. **見る**：アプリの「保存済みから選ぶ」に台本が並ぶ

セリフの書き直しは 2 だけをやり直せばよく、Gemini の枠は使いません。
**1本の動画に、台本を何本でも持てます。** 実況（`base.txt`）は使い回し、記事のコーナーだけが違う台本を作り足します。

## 構造

- `videos/<動画ID>.json` … 映像の記録。`items[]` に時刻（`t` `abs`）・見えているもの（`scene`）・読めた文字（`text`）・
  場所（`place`）・運転操作（`act` `amount`）・その区間の様子（`mood`: busy / quiet / stop）。**手で書き換えない**
- `articles/<記事>.md` … フィードから取り込んだ記事の本文（タイトル・URL・取得日・使った台本・本文）
- `lines/<動画ID>/base.txt` … その動画の台本すべてで使い回すセリフ（実況と、記事に関係しないひとこと）
- `lines/<動画ID>/<台本の名前>.txt` … その台本だけのセリフ（記事のコーナーなど）。1行に1発話（`時刻 実況|雑談 セリフ`）
- `scripts/<動画ID>_<開始>-<終了>_<台本の名前>.json` … 台本。アプリが読む。`lines/` から組み立てたもの（名前が `main` のときは、後ろに名前が付かない）
- `scripts/_index.json` … 台本の一覧（アプリの表示名・お気に入り）
- `playlists.json` … アプリのプレイリスト
- `share/list.txt` … URL で見せる台本の名前（1行に1つ）。ここに書いた台本だけが、`tools/build-share.mjs` と `.github/workflows/share.yml` で公開される。リポジトリそのものは非公開のまま
- `tools/refresh-meta.mjs` … 動画の題などを、25日ごとに取り直す（YouTube の決まりで、API の情報は30日まで）。Actions `watch-video` が毎日呼ぶ
- `talks/*.txt` … 広告のあいだに話す小話。`node tools/assemble-talks.mjs` で `talks/index.json` にまとめる。声は `audio/talks/`
- `character/persona.md` … キャラクター設定。セリフを書くときの人物像
- `character/interests.md` … 興味・関心。雑談の引き出し
- `character/feeds.md` … 記事を取り込むフィード（RSS/Atom）や一覧ページのURL。1行に1つ
- `character/channels.md` … YouTube のチャンネルかプレイリストの URL を、1行に1つ書く。`tools/fetch-youtube.mjs` が、書いたチャンネルとプレイリストの動画を Gemini にまとめさせ、まとめを `articles/youtube-<動画ID>.md` に置く
- `audio/<台本と同じ名前>/<声>/` … 音声。ファイル名は本文のハッシュ。`index.json` が一覧
- `avatar/` … アバターの設定（`settings.json`）と、置いてあればモデル（`model.vrm`）
- `台本の書き方.md` … 台本を書く手順と書き方（どのAIエージェントでも共通）
- `tools/assemble-script.mjs` … セリフを台本に組み立てて点検する道具
- `tools/make-audio.mjs` `tools/audio-requests.sh` と `.github/workflows/make-audio.yml` … 音声を作る仕掛け。`audio/request.txt` の保存で動く
- `tools/watch-video.mjs` `tools/fetch-articles.mjs` `tools/watch-requests.sh` と `.github/workflows/watch-video.yml` … 材料を用意する仕掛け。
  `videos/request.txt` の保存で動く。Secrets の `GEMINI_API_KEY` と `YOUTUBE_API_KEY` を使う
- `tools/update-tools.sh` と `.github/workflows/update-tools.yml` … 道具を公開リポジトリ drive-wipe の data-template/ の最新に入れ替える。毎週動く
- `videos/request.txt` `videos/candidates.md` … 動画の依頼と、候補の一覧

## 台本を書く・声を付ける

手順と書き方は **[台本の書き方.md](台本の書き方.md)** にあります。「新しい台本作って」「台本書いて」「ここを直して」「声を付けて」と
頼まれたら、まずそれを読んでください。どのAIエージェントでも同じ手順で書けるよう、このファイルとは分けてあります。

## 最初の準備・道具の更新

- 「準備を手伝って」と頼まれたら、`README.md` の「最初に1回やること」を一緒に進める。キーやトークンの値はユーザーが自分で貼る（AIは見ない・書かない）
- 「道具を更新して」と頼まれたら、`bash tools/update-tools.sh --workflows` を実行して、`tools/` `台本の書き方.md` `.github/workflows/` を保存する
- `tools/` `台本の書き方.md` `.github/workflows/` は更新で上書きされる。好みは `character/` と `avatar/` に書く

## そのほかの決まり

### キャラクター（character/）
- `persona.md` `interests.md` `feeds.md` `channels.md` は自由に書き換えてよい。次に書く台本から反映する

### 音声（audio/）
- 生成物。中身の音声ファイルは手で編集しない
- **声の整理は頼まれたらここでやる**：アプリの選択肢は「人」（エンジン＋話者）単位。同じ人の取り置きが複数あるとき、
  使われるのは**フォルダ名の降順で最初のもの**（`voicevox-102_2` ＞ `voicevox-102`）。
  「古いほうを正にして」と頼まれたら、不要な取り置きフォルダを消すか、名前を付け替える
