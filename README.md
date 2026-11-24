# ドライブ実況ワイプの台本と声を置くリポジトリ

[ドライブ実況ワイプ](https://kyunkyunpeachdisco-maker.github.io/drive-wipe/) は、YouTube のドライブ動画に、キャラクターの実況と雑談を重ねて流すアプリです。
キャラクターは、映っている景色について話したり、ブログやニュースの記事の話をしたりします。
キャラクターが話すセリフを時刻の順に並べたものを、台本と呼びます。

台本と、セリフの声は、自分のリポジトリに置きます。自分のリポジトリは、ひな形から作ります。
台本は、AI エージェントが書きます。
動画に何が映っているかを記録するのと、声を作るのは、GitHub Actions が行います。GitHub Actions は、GitHub がプログラムを動かしてくれる仕組みです。非公開のリポジトリで GitHub Actions を無料で使える時間は、月ごとに決まっています。

## 用意するもの

- GitHub のアカウント
- Google のアカウント
- AI エージェント。GitHub にある自分のリポジトリのファイルを、読み書きできるもの。たとえば Claude Code、Codex、Antigravity

## 最初に1回やること

### 1. ひな形から、自分のリポジトリを作る

1. [ひな形のページ](https://github.com/kyunkyunpeachdisco-maker/drive-wipe-data-template) で［Use this template］を押して、［Create a new repository］を押します
2. リポジトリの名前を、たとえば `drive-wipe-data` と入れます
3. ［Private］を選んで、［Create repository］を押します

### 2. キーを2つ作る

キーは、Google のサービスをプログラムから使うための文字列です。2つとも無料で作れます。

Gemini のキーは、GitHub Actions が動画を見て、何分何秒に何が映っているかを記録するのに使います。

1. [Google AI Studio のキーのページ](https://aistudio.google.com/apikey) を開きます
2. ［Create API key］を押して、表示されたキーをコピーします

YouTube のキーは、GitHub Actions が動画の長さを調べたり、動画の候補を探したりするのに使います。

1. [Google Cloud のページ](https://console.cloud.google.com/projectcreate) で、［作成］を押して、プロジェクトを作ります
2. [YouTube Data API v3 のページ](https://console.cloud.google.com/apis/library/youtube.googleapis.com) で、作ったプロジェクトを選んで、［有効にする］を押します
3. [認証情報のページ](https://console.cloud.google.com/apis/credentials) で［認証情報を作成］を押し、［API キー］を押して、表示されたキーをコピーします

### 3. キーを、自分のリポジトリに登録する

1. 自分のリポジトリで［Settings］を押し、［Secrets and variables］の［Actions］を開きます
2. ［New repository secret］を押し、Name に「GEMINI_API_KEY」と入れ、Secret に Gemini のキーを貼って、［Add secret］を押します
3. 同じように、Name を「YOUTUBE_API_KEY」にして、YouTube のキーも登録します

Name を1文字でも間違えると、GitHub Actions が動画を記録できません。

### 4. アプリ用のトークンを作る

トークンは、アプリが自分のリポジトリを読み書きするための文字列です。

1. [トークンの発行ページ](https://github.com/settings/personal-access-tokens/new?name=drive-wipe) を開きます。Token name には drive-wipe が入力されています
2. Expiration で期限を選びます
3. Repository access で［Only select repositories］を押し、自分のリポジトリを選びます
4. Repository permissions の Contents を［Read and write］にします
5. ［Generate token］を押して、表示された `github_pat_…` をコピーします。ページを閉じると、トークンは二度と表示されません

トークンの期限が切れたときと、トークンが手元に残っていないときは、「4. アプリ用のトークンを作る」と「5. リポジトリとトークンをアプリに入れる」をもう一度やります。

### 5. リポジトリとトークンをアプリに入れる

1. [アプリ](https://kyunkyunpeachdisco-maker.github.io/drive-wipe/) を開いて［台本を選ぶ］を押します
2. ［接続する］を押します
3. 「リポジトリ」に `自分のユーザー名/リポジトリの名前` を、「トークン」にコピーしたトークンを入れて、［保存して読み込む］を押します

「つながりました。まだ台本がありません。」と表示されれば、準備は終わりです。
スマホや別のパソコンでもアプリを使うときは、それぞれで「5. リポジトリとトークンをアプリに入れる」をやります。

## 台本を作るたびにやること

AI エージェントで、自分のリポジトリを開きます。Claude Code では、[claude.ai/code](https://claude.ai/code) で自分のリポジトリを選びます。
Claude Code 以外の AI エージェントでは、git clone で自分のリポジトリの写しをパソコンに作り、写しのフォルダを開きます。AI エージェントに「CLAUDE.md と台本の書き方.md を読んで」と伝えます。

AI エージェントに、次のように頼みます。

> この動画で台本と声を作って。https://www.youtube.com/watch?v=...

AI エージェントは、動画の記録を GitHub Actions に頼み、記録と記事を読んで台本を書き、声を作るのを GitHub Actions に頼みます。30分の動画なら、記録は10分ほど、声は十数分かかります。
できあがった台本は、アプリで［台本を選ぶ］を押すと表示されます。

動画が決まっていないときは、AI エージェントに「候補を出して 北海道 海沿い」のように頼むと、キーワードで探した動画を並べてくれます。

台本を直したいときは、AI エージェントに「12分あたりのセリフを、もっと短くして」のように頼みます。台本を直しても、声は自動では作り直されません。AI エージェントに「声を作って」と頼むと、直したセリフの声だけが作り直されます。

## キャラクターを好みで変える

- `character/persona.md` は、キャラクターの人物像です
- `character/feeds.md` には、キャラクターが雑談の話題にするブログやニュースの RSS の URL を、1行に1つ書きます

persona.md と feeds.md は、AI エージェントに「キャラをこういう人にして」「このブログの記事を取り込んで」と頼めば、書き換えてくれます。

キャラクターの 3D モデルには、VRM という形式のファイルを使えます。3D モデルを入れなければ、キャラクターは簡単な絵の顔で表示されます。

1. アプリの最初の画面で［声・アバターの設定］を押します
2. ［アバター］のタブを開き、「VRMファイル」で 3D モデルを選びます
3. ［データ］のタブを開き、［まとめて保存］を押します。3D モデルは、自分のリポジトリの `avatar/model.vrm` に保存されます

## 知っておくこと

- Gemini を無料で使えるのは1日20回で、動画10分の記録に1回使います。回数を使い切ると、GitHub Actions は記録できたところまでを保存して止まり、次の17時ごろに続きを記録します。自分のリポジトリの `videos/request.txt` から動画の URL が消えれば、記録は終わっています。回数を使い切ったときは、記録が終わってから、AI エージェントに「台本書いて」と頼みます
- `tools/` と `台本の書き方.md` は、毎週自動で、ひな形の最新のものに入れ替わるので、書き換えないでください
