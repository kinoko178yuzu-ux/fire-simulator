// ==UserScript==
// @name         MF → FIREシミュレーター CSVブリッジ
// @namespace    fire-simulator-bridge
// @version      1.3
// @updateURL    https://kinoko178yuzu-ux.github.io/fire-simulator/mf_fire_bridge.user.js
// @downloadURL  https://kinoko178yuzu-ux.github.io/fire-simulator/mf_fire_bridge.user.js
// @description  マネーフォワードの家計簿CSVを月ごとに自動取得し、FIREシミュレーターの年間収支シートへ自動反映する
// @match        https://moneyforward.com/cf*
// @match        https://kinoko178yuzu-ux.github.io/fire-simulator/*
// @match        http://localhost:8765/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_addValueChangeListener
// @run-at       document-idle
// ==/UserScript==
(function () {
  'use strict';
  const isMF = location.hostname === 'moneyforward.com';

  /** ArrayBuffer → base64（Shift-JISのバイト列をそのまま運ぶ） */
  function toB64(buf) {
    const u = new Uint8Array(buf);
    let s = '';
    const CH = 0x8000;
    for (let i = 0; i < u.length; i += CH) s += String.fromCharCode.apply(null, u.subarray(i, i + CH));
    return btoa(s);
  }

  if (!isMF) {
    /* ============ アプリ側ブリッジ ============ */
    const announce = () => document.dispatchEvent(new CustomEvent('mf-bridge-ready'));
    document.addEventListener('mf-bridge-ping', announce);
    announce();

    // アプリからの取込リクエスト → GM共有ストレージに置いてMFタブを開く
    document.addEventListener('mf-export-request', (e) => {
      const months = (e.detail && e.detail.months) || [];
      if (!months.length) return;
      GM_deleteValue('mfRes');
      GM_setValue('mfReq', { months, ts: Date.now() });
      window.open('https://moneyforward.com/cf#fire-export', '_blank');
    });

    // MFタブからの結果を受けてアプリへ渡す
    GM_addValueChangeListener('mfRes', (k, oldV, v) => {
      if (!v) return;
      document.dispatchEvent(new CustomEvent('mf-export-result', { detail: v }));
      GM_deleteValue('mfRes');
    });
    // タブを開き直した場合、未消費の結果が残っていれば1回だけ流す
    const pending = GM_getValue('mfRes', null);
    if (pending && Date.now() - pending.ts < 5 * 60 * 1000) {
      setTimeout(() => {
        document.dispatchEvent(new CustomEvent('mf-export-result', { detail: pending }));
        GM_deleteValue('mfRes');
      }, 800);
    }
  } else {
    /* ============ マネーフォワード側 ============ */
    const req = GM_getValue('mfReq', null);
    if (!req || Date.now() - req.ts > 10 * 60 * 1000) {
      sessionStorage.removeItem('mf_bridge_state');
      return;
    }

    const banner = document.createElement('div');
    banner.style.cssText =
      'position:fixed;top:0;left:0;right:0;z-index:999999;background:#0d6e6e;color:#fff;' +
      'padding:12px 16px;font-size:14px;font-weight:700;text-align:center;font-family:sans-serif;';
    banner.textContent = 'FIREシミュレーター連携: 準備中…';
    document.body.appendChild(banner);

    /** 集計対象セレクト（家計簿用/資産合計 の option を持つ select）を探す */
    function findKakeiboSelect() {
      for (const sel of document.querySelectorAll('select')) {
        for (const opt of sel.options) {
          if (/家計簿|資産合計/.test(opt.text)) return sel;
        }
      }
      return null;
    }

    /** セレクトが「家計簿用」モードかどうか */
    function isKakeiboMode(sel) {
      return sel ? /家計簿/.test(sel.options[sel.selectedIndex]?.text || '') : true;
    }

    /** 「家計簿用」に切替える。戻り値 = 復元用の元の value（変更不要なら null） */
    async function switchToKakeibo(sel) {
      if (!sel || isKakeiboMode(sel)) return null;
      const original = sel.value;
      for (const opt of sel.options) {
        if (/家計簿/.test(opt.text)) {
          sel.value = opt.value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          await new Promise(r => setTimeout(r, 2000)); // ページ反映待ち
          break;
        }
      }
      return original;
    }

    /** 元のモードに復元する */
    async function restoreKakeibo(sel, originalValue) {
      if (!sel || originalValue === null) return;
      sel.value = originalValue;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 1500));
    }

    (async () => {
      const SS_KEY = 'mf_bridge_state';
      let savedState = null;
      try { savedState = JSON.parse(sessionStorage.getItem(SS_KEY)); } catch {}

      /* ── Phase 1: 集計対象の確認・切替 ───────────────── */
      if (!savedState) {
        // 初回実行: 集計対象を確認
        banner.textContent = 'FIREシミュレーター連携: 集計対象を確認中…';

        let modeSelect = findKakeiboSelect();

        if (!modeSelect) {
          // 収支内訳タブへ移動して確認（ページリロード後に再実行される）
          const tab = [...document.querySelectorAll('a')].find(a => /収支内訳/.test(a.textContent));
          if (tab) {
            sessionStorage.setItem(SS_KEY, JSON.stringify({ phase: 'after_nav' }));
            location.href = tab.href;
            return; // ← ページ移動。スクリプトが収支内訳ページで再実行される
          }
          // タブも見つからない場合はモードチェックをスキップして進む
        }

        const originalValue = await switchToKakeibo(modeSelect);
        sessionStorage.setItem(SS_KEY, JSON.stringify({
          phase: 'downloading',
          originalValue,           // null = 変更しなかった
        }));

      } else if (savedState.phase === 'after_nav') {
        // 収支内訳タブ移動後: ここでセレクトが見つかるはず
        banner.textContent = 'FIREシミュレーター連携: 集計対象を確認中…';
        await new Promise(r => setTimeout(r, 500)); // ページ落ち着き待ち

        const modeSelect = findKakeiboSelect();
        const originalValue = await switchToKakeibo(modeSelect);
        sessionStorage.setItem(SS_KEY, JSON.stringify({
          phase: 'downloading',
          originalValue,
        }));
      }
      // ※ phase === 'downloading' の場合はここをスキップして CSV 取得へ

      /* ── Phase 2: CSV 取得ループ ──────────────────────── */
      let state = null;
      try { state = JSON.parse(sessionStorage.getItem(SS_KEY)); } catch {}

      banner.textContent = `FIREシミュレーター連携: CSVを取得中… 0/${req.months.length}`;
      const items = [], errors = [];

      for (let i = 0; i < req.months.length; i++) {
        const ym = req.months[i];
        const [y, m] = ym.split('-').map(Number);
        // ページ内の実際のCSVリンクをベースに年月を差し替え（仕様変更に強い）
        let url = `https://moneyforward.com/cf/csv?from=${y}%2F${String(m).padStart(2, '0')}%2F01&month=${m}&year=${y}`;
        const a = document.querySelector('a[href*="/cf/csv"]');
        if (a) {
          try {
            const u = new URL(a.href);
            u.searchParams.set('year', String(y));
            u.searchParams.set('month', String(m));
            if (u.searchParams.has('from')) u.searchParams.set('from', `${y}/${String(m).padStart(2, '0')}/01`);
            url = u.toString();
          } catch (e) {}
        }
        try {
          const r = await fetch(url, { credentials: 'include' });
          if (!r.ok) throw new Error('HTTP ' + r.status);
          const buf = await r.arrayBuffer();
          const head = new Uint8Array(buf.slice(0, 64));
          const headStr = String.fromCharCode.apply(null, head);
          if (headStr.toLowerCase().includes('<!doctype') || headStr.toLowerCase().includes('<html'))
            throw new Error('CSVでなくHTMLが返却（ログイン状態を確認）');
          items.push({ ym, b64: toB64(buf) });
        } catch (err) {
          errors.push(`${ym}: ${err.message}`);
        }
        banner.textContent = `FIREシミュレーター連携: CSVを取得中… ${i + 1}/${req.months.length}`;
        await new Promise((r) => setTimeout(r, 700));
      }

      /* ── Phase 3: 集計対象を元に戻す ────────────────── */
      if (state && state.originalValue !== null && state.originalValue !== undefined) {
        banner.textContent = 'FIREシミュレーター連携: 集計対象を元に戻しています…';
        const modeSelect = findKakeiboSelect();
        await restoreKakeibo(modeSelect, state.originalValue);
      }

      /* ── Phase 4: 結果を送信してタブを閉じる ───────── */
      sessionStorage.removeItem(SS_KEY);
      GM_deleteValue('mfReq');
      GM_setValue('mfRes', { items, errors, ts: Date.now() });
      banner.style.background = errors.length ? '#b8413d' : '#16a34a';
      if (errors.length) {
        banner.textContent = `⚠ 一部失敗: ${errors.join(' / ')}（成功 ${items.length}件は反映されます）`;
      } else {
        banner.textContent = `✅ ${items.length}ヶ月分を取得しました。3秒後にこのタブを自動で閉じます…`;
        setTimeout(() => window.close(), 3000);
      }
    })();
  }
})();
