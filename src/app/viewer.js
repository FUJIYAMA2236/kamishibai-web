/*
 * viewer.js — Web 版の発表・資料・印刷のウィンドウ（/viewer/）。
 * 開いたエディタ（window.opener）から組み立て済みの HTML を受け取り、このページに書き込む。
 * 書き込む HTML には、その HTML 自身の CSP（<meta>。こちらで入れたスクリプトのハッシュだけを許す）が入っている。
 */
(function () {
  'use strict';
  const kind = new URLSearchParams(location.search).get('k') || '';
  let html = null;
  const from = window.opener || (window.parent !== window ? window.parent : null);
  try { html = from && from.KSDesktop && from.KSDesktop.page(kind); } catch (e) { /* 別のオリジン */ }
  if (typeof html !== 'string') {
    document.body.textContent = '表示する内容がありません。エディタからもう一度開いてください。';
    return;
  }
  // 読み込みが終わってから書き込む（読み込みの途中だと、文書を置き換えずに body の中へ足されてしまい、<meta> の CSP も効かない）
  window.addEventListener('load', () => setTimeout(() => {
    document.open();
    document.write(html);
    document.close();
  }, 0));
})();
