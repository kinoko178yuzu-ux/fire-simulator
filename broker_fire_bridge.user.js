// ==UserScript==
// @name         証券会社 → FIREシミュレーター CSVブリッジ（SBI・楽天）
// @namespace    fire-simulator-bridge
// @version      1.9
// @description  SBI証券・楽天証券の配当CSVをFIREシミュレーターへ自動転送する
// @updateURL    https://kinoko178yuzu-ux.github.io/fire-simulator/broker_fire_bridge.user.js
// @downloadURL  https://kinoko178yuzu-ux.github.io/fire-simulator/broker_fire_bridge.user.js
// @match        https://site.sbisec.co.jp/*
// @match        https://site2.sbisec.co.jp/*
// @match        https://member.rakuten-sec.co.jp/*
// @match        http://localhost:7799/*
// @match        https://kinoko178yuzu-ux.github.io/fire-simulator/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_addValueChangeListener
// @grant        unsafeWindow
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

  // ── 証券会社側共通：CSVダウンロードを多方式で横取り ──────────────────
  //   ① blob URL（URL.createObjectURL）
  //   ② XMLHttpRequest のCSVレスポンス
  //   ③ fetch のCSVレスポンス
  function interceptDownload() {
    let resolve;
    const promise = new Promise(res => { resolve = res; });
    const looksCsvText = (s) => /受渡日|入金日|約定日|銘柄コード|受取/.test(String(s).slice(0, 300));
    // ★重要: Tampermonkeyはサンドボックスで動くため、ページ本体(unsafeWindow)に網を張る。
    //   これをしないと、サイトのJSが行うfetch/XHR/blob生成が一切見えない。
    const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;

    // ① blob（ページ本体の URL.createObjectURL）
    try {
      const orig = W.URL.createObjectURL.bind(W.URL);
      W.URL.createObjectURL = function (blob) {
        try {
          blob.arrayBuffer().then(buf => {
            if (new Uint8Array(buf)[0] !== 0x3C && buf.byteLength > 100) resolve(buf);
          }).catch(() => {});
        } catch {}
        return orig(blob);
      };
    } catch {}

    // ② XHR（ページ本体のプロトタイプ）
    try {
      const XP = W.XMLHttpRequest.prototype;
      const XO = XP.open, XS = XP.send;
      XP.open = function (m, u) { this._fireUrl = String(u || ''); return XO.apply(this, arguments); };
      XP.send = function () {
        this.addEventListener('load', () => {
          try {
            const ct = (this.getResponseHeader('content-type') || '') + ';' + (this.getResponseHeader('content-disposition') || '');
            const hit = /csv|attachment|octet-stream/i.test(ct) || /csv|download/i.test(this._fireUrl || '');
            if (!hit) return;
            const r = this.response;
            if (r instanceof W.ArrayBuffer || r instanceof ArrayBuffer) { if (r.byteLength > 100) resolve(r); }
            else if ((W.Blob && r instanceof W.Blob) || r instanceof Blob) r.arrayBuffer().then(b => { if (b.byteLength > 100) resolve(b); });
            else if (typeof r === 'string' && looksCsvText(r)) resolve(new TextEncoder().encode(r).buffer);
          } catch {}
        });
        return XS.apply(this, arguments);
      };
    } catch {}

    // ③ fetch（ページ本体）
    try {
      const OF = W.fetch;
      W.fetch = function (...a) {
        const p = OF.apply(this, a);
        try {
          p.then(res => {
            try {
              const url = String((a[0] && a[0].url) || a[0] || '');
              const ct = (res.headers.get('content-type') || '') + ';' + (res.headers.get('content-disposition') || '');
              if (/csv|attachment|octet-stream/i.test(ct) || /csv|download/i.test(url)) {
                res.clone().arrayBuffer().then(buf => {
                  if (buf.byteLength > 100 && new Uint8Array(buf)[0] !== 0x3C) resolve(buf);
                }).catch(() => {});
              }
            } catch {}
          }).catch(() => {});
        } catch {}
        return p;
      };
    } catch {}

    return promise;
  }

  /** 失敗時の診断情報：ページ上のCSVらしき要素の正体を返す */
  function csvBtnDiag() {
    const cands = [...document.querySelectorAll('a, button, input, span')]
      .filter(el => /CSV/i.test(el.textContent || el.value || ''))
      .slice(0, 3)
      .map(el => `${el.tagName}${el.href ? '(href=' + String(el.href).slice(0, 70) + ')' : ''}${el.className ? '.' + String(el.className).slice(0, 40) : ''}`);
    return cands.length ? cands.join(' ｜ ') : 'CSV要素なし';
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

  /** Reactサイト向け：本物のマウス操作に近いイベント列でクリック */
  function fullClick(el) {
    try {
      ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(t =>
        el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window })));
    } catch { try { el.click(); } catch {} }
  }

  /** クリック後にページが行った通信URL（診断用・直近6件のパス） */
  function netDiag(W, t0) {
    try {
      const ents = W.performance.getEntriesByType('resource').filter(e => e.startTime > t0).slice(-6)
        .map(e => String(e.name).replace(/^https?:\/\/[^\/]+/, '').slice(0, 60));
      return ents.length ? ents.join(' , ') : 'クリック後の通信なし（ボタンの処理が発火していない可能性）';
    } catch { return 'net計測不可'; }
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
      const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
      const t0 = (W.performance && W.performance.now) ? W.performance.now() : 0;
      fullClick(btn);

      // 追加の網：クリック後に発生したCSVらしき通信URLを見つけて、直接取りに行く
      const resourceHunt = (async () => {
        const tried = new Set();
        for (let i = 0; i < 36; i++) {
          await new Promise(r => setTimeout(r, 500));
          try {
            const cands = W.performance.getEntriesByType('resource')
              .filter(e => e.startTime > t0)
              .map(e => String(e.name))
              .filter(u => /csv|download|export|attach/i.test(u) && !tried.has(u));
            for (const u of cands) {
              tried.add(u);
              try {
                const r = await fetch(u, { credentials: 'include' });
                if (r.ok) {
                  const b = await r.arrayBuffer();
                  if (b.byteLength > 100 && new Uint8Array(b)[0] !== 0x3C) return b;
                }
              } catch {}
            }
          } catch {}
        }
        return null;
      })();

      buf = await Promise.race([
        downloadPromise,
        resourceHunt.then(b => b ? b : new Promise(() => {})),   // 見つからなければタイムアウト側に任せる
        new Promise((_, rej) => setTimeout(() =>
          rej(new Error('ダウンロードがタイムアウトしました(v1.8)。ボタン: ' + csvBtnDiag() +
            ' ／ 通信: ' + netDiag(W, t0) +
            ' ／ CSVがダウンロードフォルダに保存されていれば📁ファイル選択で取込できます')), 10000))
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

      const finishSbi = (buf) => {
        GM_deleteValue('sbiReq');
        GM_setValue('sbiRes', { csv: toB64(buf), ts: Date.now() });
        banner.style.background = '#16a34a';
        banner.textContent = '✅ CSV取得完了。3秒後にこのタブを閉じます…';
        setTimeout(() => window.close(), 3000);
      };

      try {
        const buf = await downloadCsv(dlPromise);
        finishSbi(buf);
      } catch (e) {
        // 自動クリックが効かないサイト対策：本物の1クリックを待ち受ける（5分）
        // ユーザーが「CSVダウンロード」を押せば、ページ本体に張った網が捕まえて自動取込する
        banner.style.background = '#d97706';
        banner.textContent = '👆 あと1クリック：この画面の「CSVダウンロード」を押してください（押せば自動で取り込みます）';
        try {
          const buf2 = await Promise.race([
            dlPromise,
            new Promise((_, rej) => setTimeout(() =>
              rej(new Error('待機時間切れ（5分）。CSVがダウンロードフォルダに保存されている場合は、アプリの📁ファイル選択で取込してください')), 300000))
          ]);
          finishSbi(buf2);
        } catch (e2) {
          GM_setValue('sbiRes', { error: e2.message, ts: Date.now() });
          banner.style.background = '#b8413d';
          banner.textContent = '❌ ' + e2.message;
        }
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
