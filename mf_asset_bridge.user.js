// ==UserScript==
// @name         マネフォ資産 → FIREシミュレーター 資産ブリッジ
// @namespace    fire-simulator-bridge
// @version      1.0
// @description  マネーフォワードの資産内訳（預金・株式・投信）を読み取り、FIREシミュレーターへ自動反映する
// @match        https://moneyforward.com/*
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
  const isMF = location.hostname === 'moneyforward.com';

  const num = (s) => {
    const m = String(s == null ? '' : s).replace(/[,，円\s]/g, '').match(/-?\d+(\.\d+)?/);
    return m ? parseFloat(m[0]) : 0;
  };

  /* ============ アプリ側 ============ */
  if (!isMF) {
    const announce = () => document.dispatchEvent(new CustomEvent('mf-asset-ready'));
    document.addEventListener('mf-asset-ping', announce);
    announce();

    document.addEventListener('mf-asset-request', () => {
      GM_deleteValue('mfAssetRes');
      GM_setValue('mfAssetReq', { ts: Date.now() });
      window.open('https://moneyforward.com/bs/portfolio', '_blank');
    });

    const flush = (v) => {
      if (!v) return;
      document.dispatchEvent(new CustomEvent('mf-asset-result', { detail: v }));
      GM_deleteValue('mfAssetRes');
    };
    const pending = GM_getValue('mfAssetRes', null);
    if (pending && Date.now() - pending.ts < 10 * 60 * 1000) setTimeout(() => flush(pending), 800);
    GM_addValueChangeListener('mfAssetRes', (k, o, v) => flush(v));
    return;
  }

  /* ============ マネフォ側 ============ */
  const req = GM_getValue('mfAssetReq', null);
  if (!req || Date.now() - req.ts > 10 * 60 * 1000) return;

  const banner = document.createElement('div');
  banner.style.cssText =
    'position:fixed;top:0;left:0;right:0;z-index:999999;background:#0d6e6e;color:#fff;' +
    'padding:11px 16px;font-size:14px;font-weight:700;text-align:center;font-family:sans-serif;';
  banner.textContent = 'FIREシミュレーター連携: 資産内訳を読み取り中…';
  (document.body || document.documentElement).appendChild(banner);

  // ログイン画面なら待機（ログイン後に再実行される）
  if (document.querySelector('input[type=password]') || /sign_in|login/i.test(location.pathname)) {
    banner.textContent = 'FIREシミュレーター連携: ログイン後、自動で資産を読み取ります';
    return;
  }

  // 資産内訳ページ以外なら移動（moneyforward.com内の遷移はセッションに影響しない）
  if (!/\/bs\/portfolio/.test(location.pathname)) {
    banner.textContent = 'FIREシミュレーター連携: 資産内訳ページへ移動中…';
    location.href = 'https://moneyforward.com/bs/portfolio';
    return;
  }

  const waitFor = async (fn, ms) => {
    const end = Date.now() + (ms || 20000);
    while (Date.now() < end) {
      const v = fn(); if (v) return v;
      await new Promise(r => setTimeout(r, 400));
    }
    return null;
  };

  (async () => {
    // 資産総額が出るまで待つ
    const totalOk = await waitFor(() => /資産総額/.test(document.body.innerText), 20000);
    if (!totalOk) {
      GM_setValue('mfAssetRes', { error: '資産内訳ページを読み込めませんでした', ts: Date.now() });
      banner.style.background = '#b8413d';
      banner.textContent = '❌ 資産内訳ページを読み込めませんでした';
      return;
    }
    await new Promise(r => setTimeout(r, 800));

    const total = num((document.body.innerText.match(/資産総額[：:]\s*([\d,]+)円/) || [])[1]);

    // ページ内の各テーブルをヘッダで分類して読む
    const cash = [], stocks = [], funds = [];
    document.querySelectorAll('table').forEach(tb => {
      const heads = [...tb.querySelectorAll('th')].map(th => (th.textContent || '').replace(/\s/g, ''));
      const rows = [...tb.querySelectorAll('tbody tr')].map(tr => [...tr.querySelectorAll('td')].map(td => (td.textContent || '').trim()));
      const hIdx = (kw) => heads.findIndex(h => h.includes(kw));
      if (hIdx('残高') >= 0 && hIdx('種類') >= 0) {
        // 預金・現金
        const iN = hIdx('種類'), iV = hIdx('残高'), iB = hIdx('保有金融機関');
        rows.forEach(r => { if (r.length > Math.max(iV, iB)) cash.push({ name: r[iN], yen: num(r[iV]), bank: r[iB] }); });
      } else if (hIdx('銘柄コード') >= 0) {
        // 株式(現物)
        const iC = hIdx('銘柄コード'), iN = hIdx('銘柄名'), iS = hIdx('保有数'), iCost = hIdx('平均取得単価'),
              iP = hIdx('現在値'), iE = hIdx('評価額'), iPL = heads.findIndex(h => h === '評価損益' || (h.includes('評価損益') && !h.includes('率'))),
              iB = hIdx('保有金融機関');
        rows.forEach(r => { if (r.length > Math.max(iE, iB))
          stocks.push({ code: (r[iC] || '').toUpperCase(), name: r[iN], shares: num(r[iS]), cost: num(r[iCost]),
                        price: num(r[iP]), evalv: num(r[iE]), pl: num(r[iPL]), bank: r[iB] }); });
      } else if (hIdx('基準価額') >= 0) {
        // 投資信託
        const iN = hIdx('銘柄名'), iS = hIdx('保有数'), iE = hIdx('評価額'),
              iPL = heads.findIndex(h => h === '評価損益' || (h.includes('評価損益') && !h.includes('率'))),
              iB = hIdx('保有金融機関');
        rows.forEach(r => { if (r.length > Math.max(iE, iB))
          funds.push({ name: r[iN], shares: num(r[iS]), evalv: num(r[iE]), pl: num(r[iPL]), bank: r[iB] }); });
      }
    });

    if (!total && !cash.length && !stocks.length && !funds.length) {
      GM_setValue('mfAssetRes', { error: '資産テーブルを読み取れませんでした（ページ構造が変わった可能性）', ts: Date.now() });
      banner.style.background = '#b8413d';
      banner.textContent = '❌ 資産テーブルを読み取れませんでした';
      return;
    }

    GM_deleteValue('mfAssetReq');
    GM_setValue('mfAssetRes', { ts: Date.now(), total, cash, stocks, funds });
    banner.style.background = '#16a34a';
    banner.textContent = `✅ 読み取り完了（現金${cash.length}件・株式${stocks.length}件・投信${funds.length}件）。3秒後にこのタブを閉じます…`;
    setTimeout(() => window.close(), 3000);
  })();
})();
