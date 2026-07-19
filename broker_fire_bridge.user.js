// ==UserScript==
// @name         証券会社 → FIREシミュレーター CSVブリッジ（SBI・楽天）
// @namespace    fire-simulator-bridge
// @version      1.4
// @description  SBI証券・楽天証券の配当CSVをFIREシミュレーターへ自動転送する
// @match        https://site.sbisec.co.jp/*
// @match        https://site2.sbisec.co.jp/*
// @match        https://member.rakuten-sec.co.jp/*
// @match        http://localhost:7799/*
// @match        https://kinoko178yuzu-ux.github.io/fire-simulator/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_addValueChangeListener
// @run-at       document-idle
// ==/UserScript==
(function () {
  'use strict';

  const isSBI     = location.hostname.includes('sbisec.co.jp');
  const isRakuten = location.hostname.includes('rakuten-sec.co.jp');
  const isApp     = !isSBI && !isRakuten;

  function toB64(buf) {
    const u = new Uint8Array(buf); let s = '';
    for (let i = 0; i < u.length; i += 0x8000)
      s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return btoa(s);
  }

  function makeBanner(text, color) {
    const el = document.createElement('div');
    el.id = 'fire-broker-banner';
    el.style.cssText =
      `position:fixed;top:0;left:0;right:0;z-index:999999;` +
      `background:${color || '#0d6e6e'};color:#fff;` +
      `padding:12px 16px;font-size:14px;font-weight:700;` +
      `text-align:center;font-family:sans-serif;`;
    el.textContent = text;
    (document.body || document.documentElement).appendChild(el);
    return el;
  }

  // ── 証券会社側共通：blob URLダウンロードを横取り ──────────────────
  function interceptDownload() {
    let resolve;
    const promise = new Promise(res => { resolve = res; });
    const orig = URL.createObjectURL.bind(URL);
    URL.createObjectURL = function (blob) {
      blob.arrayBuffer().then(buf => {
        // HTMLでなく、かつ100バイト超ならCSVとみなす
        if (new Uint8Array(buf)[0] !== 0x3C && buf.byteLength > 100) resolve(buf);
      }).catch(() => {});
      return orig(blob);
    };
    return promise;
  }

  async function waitFor(fn, ms) {
    const end = Date.now() + (ms || 15000);
    while (Date.now() < end) {
      const v = fn(); if (v) return v;
      await new Promise(r => setTimeout(r, 400));
    }
    return null;
  }

  function findCsvBtn() {
    return [...document.querySelectorAll('a[href], button, input[type=button], input[type=submit]')]
      .find(el => /CSV/i.test(el.textContent || el.value || el.getAttribute('aria-label') || ''));
  }

  async function downloadCsv(downloadPromise) {
    let buf = null;
    const btn = findCsvBtn();
    if (!btn) return null;

    // リンクなら直接 fetch
    if (btn.tagName === 'A' && btn.href && !/^javascript/i.test(btn.href)) {
      try {
        const r = await fetch(btn.href, { credentials: 'include' });
        if (r.ok) buf = await r.arrayBuffer();
      } catch {}
    }

    if (!buf) {
      btn.click();
      buf = await Promise.race([
        downloadPromise,
        new Promise((_, rej) => setTimeout(() => rej(new Error('ダウンロードがタイムアウトしました')), 12000))
      ]);
    }
    return buf;
  }

  // ── App 側（localhost:7799 / GitHub Pages）────────────────────────
  if (isApp) {
    const announce = () => document.dispatchEvent(new CustomEvent('broker-bridge-ready'));
    document.addEventListener('broker-bridge-ping', announce);
    announce();

    document.addEventListener('broker-fetch-request', (e) => {
      const { broker, from, to } = e.detail;
      GM_deleteValue(broker + 'Res');
      GM_setValue(broker + 'Req', { ts: Date.now(), from, to });
      const urls = {
        sbi:     'https://site.sbisec.co.jp/',
        rakuten: 'https://member.rakuten-sec.co.jp/',
      };
      window.open(urls[broker], '_blank');
    });

    ['sbi', 'rakuten'].forEach(broker => {
      const resKey = broker + 'Res';
      // ページ開き直しで未消費の結果が残っていれば流す
      const pending = GM_getValue(resKey, null);
      if (pending && Date.now() - pending.ts < 5 * 60 * 1000) {
        setTimeout(() => {
          document.dispatchEvent(new CustomEvent('broker-fetch-result', { detail: { broker, ...pending } }));
          GM_deleteValue(resKey);
        }, 800);
      }
      GM_addValueChangeListener(resKey, (k, _old, v) => {
        if (!v) return;
        document.dispatchEvent(new CustomEvent('broker-fetch-result', { detail: { broker, ...v } }));
        GM_deleteValue(resKey);
      });
    });
    return;
  }

  // ── SBI 側 ───────────────────────────────────────────────────────
  if (isSBI) {
    const req = GM_getValue('sbiReq', null);
    if (!req || Date.now() - req.ts > 10 * 60 * 1000) return;

    const dlPromise = interceptDownload();
    const banner = makeBanner('FIREシミュレーター連携: 準備中…');

    const fmt = d => `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`;
    const today = new Date();
    const fromDate = req.from || fmt(new Date(+today - 365 * 86400e3));
    const toDate   = req.to   || fmt(today);
    const TARGET = `https://site.sbisec.co.jp/account/assets/dividends` +
                   `?dispositionDateFrom=${fromDate}&dispositionDateTo=${toDate}`;

    // ログインページなら待機（ログイン後にスクリプトが再実行される）
    const isLoginPage = () =>
      document.querySelector('input[type=password]') !== null ||
      /login/i.test(location.pathname);

    if (isLoginPage()) {
      banner.textContent = 'FIREシミュレーター連携: ログイン後、自動でCSVを取得します';
      return;
    }

    // 配当ページ以外なら移動（site2ログイン後もここで配当ページへ誘導）。
    // 無限ループ防止：このリクエストでの遷移回数を上限4回に制限。
    if (!location.href.includes('/account/assets/dividends')) {
      const navKey = 'fireSbiNav_' + req.ts;
      let navCount = 0; try { navCount = +sessionStorage.getItem(navKey) || 0; } catch {}
      if (navCount >= 4) {
        GM_setValue('sbiRes', { error: '配当ページに到達できませんでした。SBIにログイン後、口座管理→配当金の画面を開いた状態でもう一度お試しください。', ts: Date.now() });
        banner.style.background = '#b8413d';
        banner.textContent = '❌ 配当ページに自動で到達できませんでした（手動で配当画面を開いてください）';
        return;
      }
      try { sessionStorage.setItem(navKey, String(navCount + 1)); } catch {}
      banner.textContent = 'FIREシミュレーター連携: 配当ページへ移動中…';
      location.href = TARGET;
      return;
    }

    (async () => {
      banner.textContent = `FIREシミュレーター連携: CSVを取得中… (${fromDate} 〜 ${toDate})`;
      await waitFor(() => /受取額/.test(document.body?.innerText || ''), 15000);
      await new Promise(r => setTimeout(r, 500));

      if (!findCsvBtn()) {
        GM_setValue('sbiRes', { error: 'CSVボタンが見つかりませんでした', ts: Date.now() });
        banner.style.background = '#b8413d';
        banner.textContent = '❌ CSVボタンが見つかりませんでした';
        return;
      }

      try {
        const buf = await downloadCsv(dlPromise);
        GM_deleteValue('sbiReq');
        GM_setValue('sbiRes', { csv: toB64(buf), ts: Date.now() });
        banner.style.background = '#16a34a';
        banner.textContent = '✅ CSV取得完了。3秒後にこのタブを閉じます…';
        setTimeout(() => window.close(), 3000);
      } catch (e) {
        GM_setValue('sbiRes', { error: e.message, ts: Date.now() });
        banner.style.background = '#b8413d';
        banner.textContent = '❌ ' + e.message;
      }
    })();
    return;
  }

  // ── 楽天側 ──────────────────────────────────────────────────────
  // 楽天は自動遷移しない（URL直打ちでセッションが切れる／リンクがjavascriptで辿れない）。
  // 手順を画面上部に常時表示し、ユーザーが配当明細を開いたらCSVを自動取得する。
  if (isRakuten) {
    const req = GM_getValue('rakutenReq', null);
    if (!req || Date.now() - req.ts > 10 * 60 * 1000) return;

    const dlPromise = interceptDownload();

    // CSV保存ボタン（楽天は「CSVで保存」）が見える配当明細ページか判定
    const isCsvPage = () => !!findCsvBtn() && /(配当|分配金)/.test(document.body?.innerText || '');

    // 手順バナー（CSVボタンが現れるまで常時表示）
    const banner = document.createElement('div');
    banner.id = 'fire-broker-banner';
    banner.style.cssText =
      'position:fixed;top:0;left:0;right:0;z-index:999999;' +
      'background:#0d6e6e;color:#fff;padding:10px 16px;' +
      'font-size:13px;font-weight:700;text-align:center;font-family:sans-serif;' +
      'box-shadow:0 2px 8px rgba(0,0,0,.25);line-height:1.5;';
    banner.innerHTML =
      'FIREシミュレーター連携 — 下記の手順でCSVを出力してください（明細が表示されると自動で取込みます）<br>' +
      '<span style="font-weight:400;font-size:12px;">' +
      '① 右上 <b>マイメニュー</b> → ② <b>配当・分配金</b> → ③ 期間を選んで <b>照会／表示</b> → ④ 明細の <b>「CSVで保存」</b> が見えればOK' +
      '</span>';
    (document.body || document.documentElement).appendChild(banner);

    async function fetchCsv() {
      banner.style.background = '#0d6e6e';
      banner.innerHTML = 'FIREシミュレーター連携: CSVを取得中…';
      try {
        const buf = await downloadCsv(dlPromise);
        if (!buf) throw new Error('CSVボタンが見つかりませんでした');
        GM_deleteValue('rakutenReq');
        GM_setValue('rakutenRes', { csv: toB64(buf), ts: Date.now() });
        banner.style.background = '#16a34a';
        banner.innerHTML = '✅ CSV取得完了。3秒後にこのタブを閉じます…';
        setTimeout(() => window.close(), 3000);
      } catch (e) {
        GM_setValue('rakutenRes', { error: e.message, ts: Date.now() });
        banner.style.background = '#b8413d';
        banner.innerHTML = '❌ ' + e.message + '（明細ページで「CSVで保存」が表示されているか確認してください）';
      }
    }

    // すでに配当明細ページなら即取得。そうでなければ表示されるまで待つ。
    if (isCsvPage()) { fetchCsv(); return; }
    const tid = setInterval(() => { if (isCsvPage()) { clearInterval(tid); fetchCsv(); } }, 1000);
  }
})();
