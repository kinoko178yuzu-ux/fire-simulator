#!/usr/bin/env python3
"""銘柄マスターDB（公開スプレッドシート）→ アプリ内蔵 stock_master.js を生成する。

使い方:
    python3 tools/build_stock_master.py            # ネットから最新を取得して生成
    python3 tools/build_stock_master.py db.csv     # 手元のCSVから生成

出力: stock_master.js（コード / 銘柄名 / 業種 / 1株配当 / 権利確定月）
株価は毎日変わるため意図的に含めない（時価はマネーフォワード側から取る）。
"""
import csv
import io
import json
import os
import sys
import urllib.parse
import urllib.request

SHEET_ID = "1cwgB7ybSZhJvtq1OTqbWdw6schdrhMVexenNuqoeeMg"
SHEET_TAB = "データベース"
URL = (
    f"https://docs.google.com/spreadsheets/d/{SHEET_ID}/gviz/tq?tqx=out:csv"
    f"&sheet={urllib.parse.quote(SHEET_TAB)}"
)
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "stock_master.js")

# 元DBで業種が空欄の行（日本銀行・信金中央金庫の出資証券）を市場区分から補う
SEC_FALLBACK = {"出資証券": "その他金融業"}

# コードを持たない米国ETF等は元DBに無いので、ここで補う（従来の内蔵マスタ由来）
EXTRA = {
    # 新規上場などで元DBに未収載のもの
    "208A": {"name": "", "sec": "情報・通信業", "dps": 90.0, "months": [3, 6, 9, 12]},
    "HDV":  {"name": "iShares Core High Dividend ETF", "sec": "米国ETF", "dps": 128.0, "months": [3, 6, 9, 12]},
    "SPYD": {"name": "SPDR Portfolio S&P 500 High Dividend ETF", "sec": "米国ETF", "dps": 321.0, "months": [3, 6, 9, 12]},
    "VYM":  {"name": "Vanguard High Dividend Yield ETF", "sec": "米国ETF", "dps": 567.0, "months": [3, 6, 9, 12]},
}


def load_rows(path=None):
    if path:
        with open(path, encoding="utf-8") as f:
            return list(csv.reader(f))
    with urllib.request.urlopen(URL, timeout=60) as r:
        return list(csv.reader(io.StringIO(r.read().decode("utf-8"))))


def main():
    rows = load_rows(sys.argv[1] if len(sys.argv) > 1 else None)
    header = rows[0]
    asof = header[18] if len(header) > 18 else ""  # 株価列の見出し＝データ更新時刻
    body = [r for r in rows[1:] if r and r[0].strip()]

    sectors, sec_idx = [], {}
    recs = []
    for r in body:
        code = r[0].strip()
        name = r[1].strip().replace("|", "").replace("　", " ")
        sec = r[3].strip() or SEC_FALLBACK.get(r[2].strip(), "その他金融業")
        try:
            dps = float((r[4] or "0").strip() or 0)
        except ValueError:
            dps = 0.0
        mask = 0
        for i in range(12):
            if len(r) > 6 + i and r[6 + i].strip():
                mask |= 1 << i
        if sec not in sec_idx:
            sec_idx[sec] = len(sectors)
            sectors.append(sec)
        dps_s = ("%g" % dps) if dps else ""
        recs.append(f"{code}|{name}|{sec_idx[sec]:x}|{dps_s}|{mask:x}")

    for code, e in EXTRA.items():
        if e["sec"] not in sec_idx:
            sec_idx[e["sec"]] = len(sectors)
            sectors.append(e["sec"])
        mask = 0
        for m in e["months"]:
            mask |= 1 << (m - 1)
        recs.append(f"{code}|{e['name']}|{sec_idx[e['sec']]:x}|{'%g' % e['dps']}|{mask:x}")

    js = f"""/* 銘柄マスターDB（アプリ内蔵）
 * 自動生成ファイル — 手で編集しないこと。更新は次のコマンド:
 *     python3 tools/build_stock_master.py
 * 出典: 公開スプレッドシート「データベース」タブ（{asof} 時点）
 * 形式: コード|銘柄名|業種番号(16進)|1株配当|権利確定月ビットマスク(16進, bit0=1月)
 */
window.STOCK_DB_ASOF = {json.dumps(asof, ensure_ascii=False)};
window.STOCK_DB_SEC = {json.dumps(sectors, ensure_ascii=False)};
window.STOCK_DB_RAW = {json.dumps(chr(10).join(recs), ensure_ascii=False)};
"""
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(js)
    print(f"銘柄数: {len(recs)} / 業種: {len(sectors)} / 基準: {asof}")
    print(f"出力: {os.path.normpath(OUT)} ({os.path.getsize(OUT):,} bytes)")


if __name__ == "__main__":
    main()
