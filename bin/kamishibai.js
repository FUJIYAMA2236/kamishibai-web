#!/usr/bin/env node
/*
 * kamishibai — コマンドライン（開発・自動化用）。ふだんはデスクトップアプリ（Kamishibai.exe）を使う。
 * 使い方は `node bin/kamishibai.js help`。
 *
 * <プロジェクト> には、プロジェクトのフォルダ（slides.md があるフォルダ）か .kami ファイルを指定する。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

if (Number(process.versions.node.split('.')[0]) < 18) {
  console.error('Node.js 18 以上が必要です（現在: ' + process.version + '）');
  process.exit(1);
}

const { createBackend, VERSION } = require('../src/app/backend');
const { createNodeHost, TOOL_ROOT } = require('../src/node/host');
const { createServer, listen } = require('../src/node/server');
const { openDefault } = require('../src/node/browser');
const { removeDir } = require('../src/node/fsutil');

/** バックエンド（プロジェクトの読み書き・書き出し）を Node の上で作る */
function newBackend(workRoot) {
  return createBackend(createNodeHost(), {
    workRoot,
    markdownit: require(path.join(TOOL_ROOT, 'vendor', 'markdown-it.min.js')),
    hljs: require(path.join(TOOL_ROOT, 'vendor', 'highlight.min.js')),
  });
}

const HELP = `Kamishibai ${VERSION} — Markdown で書いて GUI で整えるスライドツール（コマンドライン版）

使い方（<プロジェクト> はフォルダか .kami ファイル）:
  kamishibai serve [<プロジェクト>]      エディタをブラウザで開く（http://localhost:4321）
  kamishibai new <フォルダ | 名前.kami>  新しいプロジェクトを作る
  kamishibai build <プロジェクト>        スライドを HTML に書き出す
  kamishibai pdf <プロジェクト>          スライドを PDF に書き出す（Chrome か Edge が必要）
  kamishibai doc <プロジェクト>          資料（読み物形式）を HTML に。--pdf で PDF、--notes でノートも載せる
  kamishibai pack <フォルダ> [出力.kami] プロジェクトのフォルダを 1 ファイル（.kami）にまとめる
  kamishibai unpack <入力.kami> <フォルダ> .kami をフォルダに展開する

オプション:
  --out <file>     書き出し先（既定: フォルダなら <フォルダ>/dist/、.kami ならその隣）
  --no-embed       build / doc で画像を埋め込まず「<名前>_files/」フォルダに置いて参照する
  --port <n>       serve のポート番号（既定: 4321。使用中なら次の番号を試す）
  --no-open        serve でブラウザを自動で開かない
  --title <text>   new で付けるタイトル
  --theme <ID>     new で使うテーマ
`;

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') out.help = true;
    else if (a === '-v' || a === '--version') out.version = true;
    else if (a.startsWith('--no-')) out[a.slice(5)] = false;
    else if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) out[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out[a.slice(2)] = argv[++i];
      else out[a.slice(2)] = true;
    } else out._.push(a);
  }
  return out;
}

const kb = (bytes) => (bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + ' MB' : Math.ceil(bytes / 1024) + ' KB');
const need = (value, message) => { if (!value) { console.error(message); process.exit(1); } return value; };
const str = (v) => (typeof v === 'string' ? v : undefined);

/** フォルダ・.kami のどちらでも開く。.kami は一時フォルダに展開する（終わったら消す） */
function withProject(p, fn) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'kamishibai-cli-'));
  const backend = newBackend(work);
  return Promise.resolve()
    .then(async () => fn(await backend.open(need(p, 'プロジェクト（フォルダか .kami）を指定してください')), backend))
    .finally(() => removeDir(work));
}

function report(r) {
  (r.warnings || []).forEach((w) => console.warn('  注意: ' + w));
  console.log('書き出しました: ' + r.file + '  (' + kb(r.bytes) + ')' + (r.files && r.files.length ? '  ＋ 参照ファイル ' + r.files.length + ' 個' : ''));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || 'help';
  if (args.version) return console.log(VERSION);
  if (args.help || cmd === 'help') return console.log(HELP);
  const target = args._[1];
  const embed = args.embed !== false;

  switch (cmd) {
    case 'serve': {
      const server = createServer();
      const backend = server.backend;
      if (target) await backend.open(target);
      const port = await listen(server, Number(args.port) || 4321, args.port ? 0 : 20);
      const url = 'http://localhost:' + port + '/';
      console.log('Kamishibai ' + VERSION);
      console.log('  エディタ    : ' + url);
      if (backend.project) console.log('  プロジェクト: ' + (backend.project.kamiFile || backend.project.dir));
      console.log('  終了するには Ctrl+C');
      if (args.open !== false) openDefault(url);
      const stop = () => { backend.flush().then(() => process.exit(0)); };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      process.on('SIGHUP', stop);
      break;
    }
    case 'new': {
      const p = need(target, '作る場所を指定してください: kamishibai new <フォルダ | 名前.kami>');
      const o = { title: str(args.title), theme: str(args.theme) };
      const backend = newBackend();
      const project = p.toLowerCase().endsWith('.kami') ? await backend.createKami(p, o) : await backend.createFolder(p, o);
      await backend.flush();
      console.log('作成しました: ' + (project.kamiFile || project.dir));
      break;
    }
    case 'build':
      await withProject(target, async (p, b) => report(await b.exportDeck(p, { out: str(args.out), embed })));
      break;
    case 'pdf':
      await withProject(target, async (p, b) => report(await b.exportPdf(p, { out: str(args.out) })));
      break;
    case 'doc':
      await withProject(target, async (p, b) => {
        const o = { out: str(args.out), notes: !!args.notes, embed };
        report(args.pdf ? await b.exportPdf(p, Object.assign({ kind: 'doc' }, o)) : await b.exportDocument(p, o));
      });
      break;
    case 'pack': {
      const dir = path.resolve(need(target, 'フォルダを指定してください: kamishibai pack <フォルダ> [出力.kami]'));
      const out = path.resolve(args._[2] || dir.replace(/[\\/]+$/, '') + '.kami');
      await withProject(dir, async (p, b) => { await b.packProject(p, out); console.log('作成しました: ' + out); });
      break;
    }
    case 'unpack': {
      const file = need(target, '.kami を指定してください: kamishibai unpack <入力.kami> <フォルダ>');
      const dir = path.resolve(need(args._[2], '展開先のフォルダを指定してください'));
      if (fs.existsSync(dir) && fs.readdirSync(dir).length) need(false, '空のフォルダを指定してください: ' + dir);
      await newBackend().unpackKami(path.resolve(file), dir);
      console.log('展開しました: ' + dir);
      break;
    }
    default:
      console.error('不明なコマンドです: ' + cmd + '\n');
      console.log(HELP);
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(e && e.expose ? 'エラー: ' + e.message : e);
  process.exit(1);
});
