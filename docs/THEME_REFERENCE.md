# テーマのリファレンス（theme.json / theme.css）

> このファイルは `node scripts/theme-reference.js` で `src/core/schema.js` から作っています（手で書き換えないでください）。
> 作り方の流れは [THEMES.md](THEMES.md) を見てください。

## テーマのフォルダ

```
my-brand/            ← フォルダ名がテーマ ID（半角英小文字・数字・ハイフン・下線）
  theme.json         ← 必須。色・フォント・余白などの値
  theme.css          ← 任意。値では表せない飾り
```

使えるようにするには、次のどれかをします。

- アプリの「デザイン」→「テーマ」→「自作テーマを読み込む・書き出す」で、フォルダ・theme.json・zip を読み込む（ユーザーのテーマにコピーされる）
- 「テーマのフォルダを開く」で開いたフォルダ（Windows: `%APPDATA%\Kamishibai\themes`）に、フォルダごと置く
- プロジェクトの `themes/<ID>/` に置く（そのプロジェクトだけで使う。.kami にも入る）

同じ ID のテーマがあるときは「プロジェクト → ユーザー → 同梱」の順に先に見つかったものを使います。同梱テーマと同じ ID は読み込めません。

## theme.json

```json
{
  "$schema": "https://raw.githubusercontent.com/FUJIYAMA2236/kamishibai/main/docs/theme.schema.json",
  "name": "自社ブランド",
  "description": "一覧に出る説明",
  "category": "simple",
  "order": 50,
  "aspect": "16:9",
  "tokens": {
    "bg": "#ffffff",
    "text": "#1f2430",
    "accent": "#d9480f",
    "accent2": "#1971c2",
    "headingStyle": "bar",
    "lineBreak": "phrase"
  },
  "animation": {
    "transition": "fade",
    "entrance": "rise"
  },
  "chrome": {
    "pageNumber": true,
    "progress": true
  }
}
```

| キー | 内容 |
| --- | --- |
| `$schema` | 任意。上の URL を書くと、VS Code などで入力の候補と間違いの指摘が出る（Kamishibai は読み飛ばす） |
| `name` | 一覧に出る名前（省略すると ID） |
| `description` | 一覧・「テーマ」タブに出る説明 |
| `category` | 一覧での分類: `simple`（シンプル）/ `decorative`（装飾あり） |
| `order` | 一覧での並び順（小さいほど先。省略すると 100） |
| `aspect` | スライドの縦横比: `16:9`（1280×720 px） / `16:10`（1152×720 px） / `4:3`（960×720 px）。デッキで選んだものが優先 |
| `tokens` | 色・文字・形の値（下の表）。書かなかったものは既定値 |
| `animation` | 動き（下の表） |
| `chrome` | ページ番号・進捗バー（下の表） |

値の優先順位: 既定値 < テーマ（theme.json）< デッキの調整（deck.json の `tokens`）< スライド個別（deck.json の `slides.<ID>`）

## tokens

### 色

| キー | 内容 | 既定値 | 書ける値 | CSS での名前 |
| --- | --- | --- | --- | --- |
| `bg` | 背景 | `#0b1020` | 色 | `--ks-bg` |
| `surface` | パネル（コード等） | `#141b33` | 色 | `--ks-surface` |
| `text` | 文字 | `#e8ecf8` | 色 | `--ks-text` |
| `muted` | 補助文字 | `#8f9bbd` | 色 | `--ks-muted` |
| `accent` | アクセント | `#7c9cff` | 色 | `--ks-accent` |
| `accent2` | アクセント2 | `#5eead4` | 色 | `--ks-accent2` |

### 文字

| キー | 内容 | 既定値 | 書ける値 | CSS での名前 |
| --- | --- | --- | --- | --- |
| `fontHeading` | 見出しフォント | 既定のフォント（下の「フォント」） | フォント（CSS の font-family） | `--ks-font-heading` |
| `fontBody` | 本文フォント | 既定のフォント（下の「フォント」） | フォント（CSS の font-family） | `--ks-font-body` |
| `fontMono` | コードフォント | 既定のフォント（下の「フォント」） | フォント（CSS の font-family） | `--ks-font-mono` |
| `baseSize` | 本文サイズ | `28` px | 18〜40 px（1 刻み） | `--ks-base-size` |
| `headingScale` | 見出しの大きさ | `1.6` | 1.1〜2.4（0.05 刻み） | `--ks-heading-scale` |
| `titleScale` | タイトルの大きさ | `2.8` | 1.6〜4.5（0.1 刻み） | `--ks-title-scale` |
| `headingWeight` | 見出しの太さ | `700` | 300〜900（100 刻み） | `--ks-heading-weight` |
| `lineHeight` | 行間 | `1.6` | 1.2〜2.2（0.05 刻み） | `--ks-line-height` |
| `letterSpacing` | 見出しの字間 | `0.01` em | -0.05〜0.2 em（0.01 刻み） | `--ks-letter-spacing` |
| `lineBreak` | 日本語の折り返し | `phrase` | `phrase` 文節で（読みやすく）<br>`char` 文字ごと（詰めて） | .ks-deck の `data-line-break` |

### 形・レイアウト

| キー | 内容 | 既定値 | 書ける値 | CSS での名前 |
| --- | --- | --- | --- | --- |
| `padding` | 余白 | `72` px | 32〜120 px（2 刻み） | `--ks-padding` |
| `radius` | 角丸 | `14` px | 0〜40 px（1 刻み） | `--ks-radius` |
| `headingStyle` | 見出しの飾り | `plain` | `plain` なし<br>`bar` 左バー<br>`underline` 下線<br>`gradient` グラデ文字<br>`tag` 帯 | .ks-deck の `data-heading-style` |
| `bulletStyle` | 箇条書きの記号 | `dot` | `dot` ●<br>`dash` –<br>`arrow` →<br>`check` ✓<br>`square` ■<br>`custom` 好きな記号… | .ks-deck の `data-bullet-style` |
| `bulletChar` | 記号（1 段目）（`bulletStyle` が `custom` のとき） | `◆` | 文字（記号 1〜2 文字） | `--ks-bullet-char` |
| `bulletChar2` | 記号（2 段目〜）（`bulletStyle` が `custom` のとき） | `–` | 文字（記号 1〜2 文字） | `--ks-bullet-char2` |
| `titleAlign` | タイトルの位置 | `left` | `left` 左寄せ<br>`center` 中央 | .ks-deck の `data-title-align` |
| `bodyAlign` | 本文の縦位置 | `top` | `top` 上<br>`center` 中央 | .ks-deck の `data-body-align` |

### カラムの囲み

| キー | 内容 | 既定値 | 書ける値 | CSS での名前 |
| --- | --- | --- | --- | --- |
| `colStyle` | 囲み | `none` | `none` なし<br>`outline` 枠線<br>`fill` 塗り<br>`card` カード | .ks-deck の `data-col-style` |
| `colDir` | 並べ方 | `row` | `row` 横に並べる<br>`column` 縦に並べる<br>`grid` 格子（2 列） | （CSS には出ない） |
| `colAlign` | 文字の横位置 | `auto` | `auto` 自動<br>`left` 左<br>`center` 中央 | （CSS には出ない） |
| `colValign` | 文字の縦位置 | `auto` | `auto` 自動<br>`top` 上詰め<br>`center` 中央<br>`bottom` 下詰め | （CSS には出ない） |
| `boxRadius` | 箱の角丸 | `20` px | 0〜48 px（1 刻み） | `--ks-box-radius` |
| `colColor1` | カラム1の色 | （空 = 自動） | 色、または空（自動） | （CSS には出ない） |
| `colColor2` | カラム2の色 | （空 = 自動） | 色、または空（自動） | （CSS には出ない） |
| `colColor3` | カラム3の色 | （空 = 自動） | 色、または空（自動） | （CSS には出ない） |
| `colColor4` | カラム4の色 | （空 = 自動） | 色、または空（自動） | （CSS には出ない） |
| `colText` | 塗りの上の文字 | `auto` | `auto` 自動（色の明るさで）<br>`light` 白<br>`dark` 黒 | （CSS には出ない） |

### 背景（CSS）

| キー | 内容 | 既定値 | 書ける値 | CSS での名前 |
| --- | --- | --- | --- | --- |
| `bgSlide` | 通常スライド背景 | （空） | CSS の background の値 | `--ks-bg-slide` |
| `bgTitle` | タイトル背景 | （空） | CSS の background の値 | `--ks-bg-title` |
| `bgSection` | セクション背景 | （空） | CSS の background の値 | `--ks-bg-section` |

`bgSlide` `bgTitle` `bgSection` の中では、ほかのトークンを `var(--ks-accent)` のように使えます:

```json
"bgTitle": "radial-gradient(900px 520px at 90% -10%, color-mix(in srgb, var(--ks-accent) 34%, transparent), transparent 62%), var(--ks-bg)"
```

### フォント

`fontHeading` `fontBody` `fontMono` は CSS の font-family の形で書きます。テーマのフォントは「見る人の PC に入っているもの」が使われるので、
最後に `sans-serif` などを付け、日本語のフォントを複数並べておくと安全です。デザインパネルの選択肢は次のとおりです。

| 選択肢 | 値 |
| --- | --- |
| ゴシック（標準） | `"Inter", "Segoe UI", "Hiragino Sans", "Hiragino Kaku Gothic ProN", "BIZ UDPGothic", "Yu Gothic UI", "Meiryo", "Noto Sans JP", sans-serif` |
| UDゴシック（太め） | `"BIZ UDPGothic", "Hiragino Sans", "Yu Gothic UI", "Meiryo", "Noto Sans JP", sans-serif` |
| 明朝 | `"Yu Mincho", "YuMincho", "Hiragino Mincho ProN", "BIZ UDPMincho", "Noto Serif JP", "Times New Roman", serif` |
| 丸ゴシック | `"Hiragino Maru Gothic ProN", "Zen Maru Gothic", "Kosugi Maru", "BIZ UDPGothic", "Meiryo UI", "Meiryo", sans-serif` |
| 欧文グロテスク + ゴシック | `"Helvetica Neue", "Arial", "Hiragino Sans", "BIZ UDPGothic", "Yu Gothic UI", "Meiryo", sans-serif` |
| 等幅 | `"Cascadia Code", "SF Mono", "Consolas", "BIZ UDGothic", "MS Gothic", "Osaka-Mono", monospace` |

## animation

| キー | 内容 | 既定値 | 書ける値 |
| --- | --- | --- | --- |
| `transition` | スライド切り替え | `fade` | `none` なし<br>`fade` フェード<br>`slide` スライド<br>`zoom` ズーム<br>`blur` ぼかし |
| `entrance` | 要素の登場 | `rise` | `none` なし<br>`fade` フェード<br>`rise` 下からふわっと<br>`slide` 横からすっと<br>`zoom` ズーム<br>`blur` ぼかし |
| `build` | 段階表示 | `none` | `none` しない（一度に表示）<br>`items` クリックごとに1項目 |
| `duration` | 速さ (ms) | `650` | 200〜1400 |
| `stagger` | ずらし (ms) | `70` | 0〜240 |

## chrome

| キー | 内容 | 既定値 |
| --- | --- | --- |
| `pageNumber` | ページ番号（`true` / `false`） | `true` |
| `progress` | 進捗バー（`true` / `false`） | `true` |

## theme.css

theme.css は、ツールのスタイル（runtime.css）の後ろにそのまま読み込まれます。スライドはすべて `.ks-deck` の中にあるので、
セレクタは `.ks-deck` から書いてください（エディタの画面そのものに効かないように）。

```css
/* タイトルを大文字に */
.ks-deck .ks-layout-title h1 { text-transform: uppercase; }

/* 通常のスライドの右上に、薄い光の飾り */
.ks-deck .ks-slide:not(.ks-layout-title) > .ks-bg::before {
  content: '';
  position: absolute;
  inset: 0;
  background: radial-gradient(600px 300px at 100% 0%, color-mix(in srgb, var(--ks-accent) 12%, transparent), transparent 70%);
}

/* セクションのスライドだけ色を反転 */
.ks-deck .ks-layout-section { --ks-bg: var(--ks-accent); --ks-text: #fff; --ks-muted: #ffffffcc; }
```

### 1 枚のスライドの構造

```html
<div class="ks-deck" data-aspect="16:9" data-heading-style="bar" …>   ← トークンの CSS 変数と data 属性はここに付く
  <div class="ks-stage">
    <section class="ks-slide ks-layout-content" data-layout="content" data-align="left" data-valign="top" …>
      <div class="ks-bg"></div>                   ← 背景。全面の画像もここ。::before / ::after で飾りを足せる
      <div class="ks-inner">
        <div class="ks-main">
          <header class="ks-head"><h2>見出し</h2></header>
          <div class="ks-body"> 本文（p, ul, ol, table, pre.ks-code, figure.ks-figure, div.ks-mermaid, blockquote …）</div>
        </div>
        <div class="ks-media"><img></div>        ← 画像：右 / 左 のときの画像
      </div>
      <div class="ks-chrome"><span class="ks-footer"></span><span class="ks-page"><b>3</b><i> / 12</i></span></div>
    </section>
    <div class="ks-progress"></div>              ← 進捗バー
  </div>
</div>
```

カラムのスライドでは `.ks-body` の中が `.ks-cols-pre`（カラムの前の全幅の部分）→ `.ks-cols` > `.ks-col` × 列数 → `.ks-cols-post`（後ろの全幅の部分）になります。

### クラス

| セレクタ | 対象 |
| --- | --- |
| `.ks-slide` | スライド 1 枚 |
| `.ks-layout-title` `.ks-layout-section` `.ks-layout-content` `.ks-layout-center` `.ks-layout-columns` `.ks-layout-image-right` `.ks-layout-image-left` `.ks-layout-image-full` `.ks-layout-quote` | レイアウト別（タイトル / セクション / 標準 / 中央寄せ / カラム / 画像：右 / 画像：左 / 画像：全面 / 引用） |
| `.ks-bg` / `.ks-inner` / `.ks-main` | 背景 / 中身の外枠 / 見出しと本文 |
| `.ks-head` / `.ks-body` / `.ks-media` | 見出し / 本文 / 横に置いた画像 |
| `.ks-cols` / `.ks-col` / `.ks-cols-pre` / `.ks-cols-post` | カラム全体 / 1 列 / カラムの前後の全幅の部分 |
| `.ks-code` / `.ks-figure` / `.ks-mermaid` | コード / 画像だけの段落（図） / mermaid の図 |
| `.ks-chrome` / `.ks-footer` / `.ks-page` / `.ks-progress` | フッターの帯 / フッターの文 / ページ番号 / 進捗バー |

### data 属性

| 付く場所 | 属性 | 値 |
| --- | --- | --- |
| `.ks-deck` | `data-aspect` | `16:9` `16:10` `4:3` |
| `.ks-deck` | `data-line-break` | `phrase` `char`（トークン `lineBreak`） |
| `.ks-deck` | `data-heading-style` | `plain` `bar` `underline` `gradient` `tag`（トークン `headingStyle`） |
| `.ks-deck` | `data-bullet-style` | `dot` `dash` `arrow` `check` `square` `custom`（トークン `bulletStyle`） |
| `.ks-deck` | `data-title-align` | `left` `center`（トークン `titleAlign`） |
| `.ks-deck` | `data-body-align` | `top` `center`（トークン `bodyAlign`） |
| `.ks-deck` | `data-col-style` | `none` `outline` `fill` `card`（トークン `colStyle`） |
| `.ks-slide` | `data-layout` | `title` `section` `content` `center` `columns` `image-right` `image-left` `image-full` `quote` |
| `.ks-slide` | `data-align` / `data-valign` | `left` `center` / `top` `center` |
| `.ks-slide` | `data-col-style` / `data-col-align` / `data-col-valign` | カラムのスライドだけ。`none` `outline` `fill` `card` / `left` `center` / `top` `center` `bottom` |
| `.ks-slide` | `data-col-dir` | カラムのスライドだけ。並べ方: `row`（横）`column`（縦）`grid`（2 列の格子） |
| `.ks-slide` | `data-transition` / `data-entrance` / `data-build` | アニメーション（上の表の値） |
| `.ks-cols` | `data-count` | 列の数 |

### CSS 変数

トークンの値（上の表の「CSS での名前」）のほかに、次の変数を使えます。

| 変数 | 内容 |
| --- | --- |
| `--ks-w` / `--ks-h` | スライドの幅・高さ（px。縦横比で変わる） |
| `--ks-border` | 文字色を薄くした線の色 |
| `--ks-soft` | 文字色をごく薄くした面の色 |
| `--ks-accent-soft` | アクセント色を薄くした面の色 |
| `--ks-grad` | アクセント → アクセント2 のグラデーション |
| `--ks-px` | 左右の余白（`padding` × 1.15） |
| `--ks-bg-slide` / `--ks-bg-title` / `--ks-bg-section` | 背景（トークン `bgSlide` などを書いたときだけ） |
| `--ks-col-c` / `--ks-on-c` | `.ks-col` の中で: その列の色 / その色の上の文字色 |
| `--ks-progress` | 進捗（0〜1） |

### 気をつけること

- theme.css から外のファイル（画像・フォント）は読めません。画像は `data:` URI で埋め込むか、トークンの背景（グラデーションなど）で表してください。
- .pptx / .odp に書き出すとき、再現されるのは「計算された見た目」のうち、背景色・直線のグラデーション・枠線・角丸・上の帯（`box-shadow: inset 0 N 0 色`）・文字の色や太さです。
  `::before` / `::after` の飾りや、円形のグラデーションは書き出されません（HTML・PDF には出ます）。
- シンプルなテーマ（`category: simple`）は、背景にグラデーションを使わず、`headingStyle` に `gradient` を使わない決まりです（同梱テーマはテストで確認しています）。
- `accent2` を `accent` と同じ色にすると、見出しの下線や進捗バーも単色になります。

