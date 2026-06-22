#!/usr/bin/env python3
"""
証券会社の配当金CSVを自動ダウンロードする（fire-simulator 用）

仕組み（DistroKit と同じ方式）:
  - 専用プロファイルで Google Chrome を起動（あなたの普段の Chrome とは別ウィンドウ）
  - 初回だけそのウィンドウで証券会社にログイン（2段階認証もあなたが実施）
  - 以降はセッションが保存され、ログイン不要
  - 配当ページへ移動して「CSVダウンロード」を自動クリック → ~/Downloads に保存
  - 保存後、fire-simulator の「銘柄別 予定vs実績」へドラッグ取込

使い方:
  python3 tools/fetch_dividends.py sbi          # SBIの配当CSVを取得（直近約1年）
  python3 tools/fetch_dividends.py sbi --days 730   # 期間を変える（日数）

注意:
  - これは配当CSVの「ダウンロード（読み取り）」だけを行います。売買・送金・設定変更は一切しません。
  - 証券会社が画面を改修すると動かなくなることがあります（その場合 ~/Downloads/broker_debug.png を見て調整）。
"""
import sys, argparse, datetime, pathlib, re

PROFILE_DIR = pathlib.Path.home() / ".fire_broker_chrome"   # 専用プロファイル（ログイン保存先）
OUT_DIR = pathlib.Path.home() / "Downloads"


def daterange(days: int):
    today = datetime.date.today()
    frm = today - datetime.timedelta(days=days)
    return frm, today


def fetch_sbi(page, days: int):
    frm, to = daterange(days)
    url = ("https://site.sbisec.co.jp/account/assets/dividends"
           f"?dispositionDateFrom={frm:%Y/%m/%d}&dispositionDateTo={to:%Y/%m/%d}")
    print(f"[SBI] 配当ページへ移動: {frm:%Y/%m/%d} 〜 {to:%Y/%m/%d}")
    page.goto(url, wait_until="domcontentloaded")
    page.wait_for_timeout(1500)

    # ログイン判定（ログインページに飛ばされていたら手動ログインを待つ）
    if _need_login(page):
        print("\n=== ログインが必要です ===")
        print("開いた Chrome ウィンドウで SBI証券 にログインしてください（2段階認証も）。")
        input("ログインが終わったら、このターミナルで Enter を押してください... ")
        page.goto(url, wait_until="domcontentloaded")
        page.wait_for_timeout(1500)

    # 結果テーブルが出るまで待つ（CSVボタンは結果が出ると現れる）
    try:
        page.wait_for_selector("text=受取額", timeout=15000)
    except Exception:
        print("[SBI] 結果テーブルが見つかりません。期間や口座を確認してください。")

    csv_btn = _find_csv_button(page)
    if not csv_btn:
        _debug(page, "sbi")
        raise RuntimeError("CSVダウンロードボタンが見つかりませんでした（~/Downloads/broker_debug.png を確認）")

    with page.expect_download(timeout=30000) as dl:
        csv_btn.click()
    download = dl.value
    out = OUT_DIR / f"sbi_dividends_{to:%Y%m%d}.csv"
    download.save_as(str(out))
    print(f"[SBI] 保存しました → {out}")
    return out


def _need_login(page):
    # ログイン画面の最も確実な目印＝パスワード入力欄の存在
    try:
        if page.locator("input[type=password]:visible").count() > 0:
            return True
    except Exception:
        pass
    if "login" in page.url.lower():
        return True
    return False


def fetch_rakuten(ctx, page):
    """楽天はURLがセッション依存（BV_SessionID）。スクリプトからURL遷移すると
    セッションが切れるため、配当明細ページまでは手動で進めてもらい、
    スクリプトは最後の『CSVで保存』クリック＆保存だけを行う。"""
    # セッションを壊さない公開トップだけ開く（以降の遷移は一切しない）
    try:
        page.goto("https://www.rakuten-sec.co.jp/", wait_until="domcontentloaded")
    except Exception:
        pass

    print("\n=== 楽天は手動で配当明細まで進めてください（スクリプトはURL遷移しません）===")
    print("この専用ウィンドウで：")
    print("  1) 楽天証券にログイン")
    print("  2) マイメニュー → 配当・分配金")
    print("  3) 表示期間（今年/すべて）・口座（すべて）を選び『表示する』")
    print("  4) 『配当金・分配金一覧』の明細と『CSVで保存』ボタンが見える状態にする")
    input("そこまでできたら Enter を押してください（CSVを自動保存します）... ")

    # ユーザーが操作した最新タブを対象にする（新規タブで開いていてもOK）
    page = ctx.pages[-1]
    try:
        page.bring_to_front()
    except Exception:
        pass

    csv_btn = _find_csv_button(page)
    if not csv_btn:
        _debug(page, "rakuten")
        raise RuntimeError("『CSVで保存』ボタンが見つかりませんでした。配当明細が表示された画面で実行してください（~/Downloads/broker_debug.png を確認）")
    with page.expect_download(timeout=30000) as dl:
        csv_btn.click()
    download = dl.value
    out = OUT_DIR / f"rakuten_dividends_{datetime.date.today():%Y%m%d}.csv"
    download.save_as(str(out))
    print(f"[楽天] 保存しました → {out}")
    return out


def _find_csv_button(page):
    # ラベル違いに強くする: "CSV" を含む button / a / それらしき要素を順に探す
    candidates = [
        ("role-button", lambda: page.get_by_role("button", name=re.compile("CSV"))),
        ("role-link",   lambda: page.get_by_role("link", name=re.compile("CSV"))),
        ("text",        lambda: page.get_by_text(re.compile("CSV.*ダウンロード"))),
        ("css",         lambda: page.locator("a:has-text('CSV'), button:has-text('CSV')")),
    ]
    for label, fn in candidates:
        try:
            loc = fn()
            if loc.count() > 0:
                print(f"[SBI] CSVボタン検出: {label}")
                return loc.first
        except Exception:
            continue
    return None


def _debug(page, tag):
    try:
        p = OUT_DIR / "broker_debug.png"
        page.screenshot(path=str(p), full_page=True)
        print(f"[debug] スクショ保存 → {p}（これを共有してもらえれば調整します）")
    except Exception:
        pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("broker", choices=["sbi", "rakuten"], help="取得する証券会社")
    ap.add_argument("--days", type=int, default=400, help="取得期間（日数・既定400≒13ヶ月）")
    args = ap.parse_args()

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("playwright が見つかりません。`pip install playwright` を実行してください。")
        sys.exit(1)

    PROFILE_DIR.mkdir(exist_ok=True)
    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            user_data_dir=str(PROFILE_DIR),
            channel="chrome",            # システムの Google Chrome を使う
            headless=False,
            accept_downloads=True,
            args=["--profile-directory=Default"],
        )
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        try:
            if args.broker == "sbi":
                fetch_sbi(page, args.days)
            elif args.broker == "rakuten":
                fetch_rakuten(ctx, page)
        finally:
            print("完了。ウィンドウは閉じてOKです。")
            ctx.close()


if __name__ == "__main__":
    main()
