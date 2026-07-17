#!/usr/bin/env python3
"""
FIREシミュレーター 起動サーバー

使い方:
    python3 server.py

http://localhost:7799 でアプリが開きます。
証券会社CSVの自動取得API（/api/broker/sbi/*, /api/broker/rakuten/*）も同時に提供します。
"""
import re, queue, threading, pathlib, base64, datetime, tempfile, os
from flask import Flask, send_from_directory, jsonify, request

BASE = pathlib.Path(__file__).parent
PROFILE = pathlib.Path.home() / '.fire_broker_chrome'
PORT = 7799

app = Flask(__name__)

# ── Playwright ワーカー（全Playwright操作を1スレッドで直列実行）─────────────────
_q: queue.Queue = queue.Queue()

def _pw_worker():
    from playwright.sync_api import sync_playwright
    pw = sync_playwright().start()
    state: dict = {}          # 'ctx' | 'page' | 'broker'

    def close():
        try: state.get('ctx') and state['ctx'].close()
        except: pass
        state.clear()

    def open_ctx():
        close()
        PROFILE.mkdir(exist_ok=True)
        ctx = pw.chromium.launch_persistent_context(
            user_data_dir=str(PROFILE), channel='chrome',
            headless=False, accept_downloads=True,
            args=['--profile-directory=Default']
        )
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        state['ctx'] = ctx
        state['page'] = page
        return page

    def find_csv_btn(page):
        for fn in [
            lambda: page.get_by_role('button', name=re.compile('CSV')),
            lambda: page.get_by_role('link',   name=re.compile('CSV')),
            lambda: page.locator("a:has-text('CSV'), button:has-text('CSV')"),
        ]:
            try:
                loc = fn()
                if loc.count() > 0: return loc.first
            except: pass
        return None

    def need_login(page):
        try:
            if page.locator('input[type=password]:visible').count() > 0:
                return True
        except: pass
        return 'login' in page.url.lower()

    def download_csv(page):
        btn = find_csv_btn(page)
        if not btn:
            raise RuntimeError('CSVボタンが見つかりません。正しいページを開いているか確認してください。')
        with page.expect_download(timeout=30000) as dl:
            btn.click()
        d = dl.value
        tmp = tempfile.mktemp(suffix='.csv')
        d.save_as(tmp)
        data = pathlib.Path(tmp).read_bytes()
        os.unlink(tmp)
        return base64.b64encode(data).decode()

    while True:
        task = _q.get()
        ev: threading.Event = task['ev']
        try:
            a = task['action']

            if a == 'sbi_open':
                days = task.get('days', 400)
                frm  = (datetime.date.today() - datetime.timedelta(days=days)).strftime('%Y/%m/%d')
                to   = datetime.date.today().strftime('%Y/%m/%d')
                url  = (f'https://site.sbisec.co.jp/account/assets/dividends'
                        f'?dispositionDateFrom={frm}&dispositionDateTo={to}')
                page = open_ctx()
                state['broker'] = 'sbi'
                page.goto(url, wait_until='domcontentloaded')
                page.wait_for_timeout(1500)
                if need_login(page):
                    task['res'] = {'status': 'login_required',
                                   'msg': 'SBI証券のログインが必要です。開いたブラウザでログインしてから「取得」ボタンを押してください。'}
                else:
                    task['res'] = {'status': 'ready'}

            elif a == 'sbi_go':
                if state.get('broker') != 'sbi' or not state.get('page'):
                    task['res'] = {'ok': False, 'error': 'セッション切れ。もう一度「SBI取得」を押してください。'}
                else:
                    page = state['page']
                    try: page.wait_for_selector('text=受取額', timeout=10000)
                    except: pass
                    csv_b64 = download_csv(page)
                    close()
                    task['res'] = {'ok': True, 'csv': csv_b64}

            elif a == 'rakuten_open':
                page = open_ctx()
                state['broker'] = 'rakuten'
                try: page.goto('https://www.rakuten-sec.co.jp/', wait_until='domcontentloaded')
                except: pass
                task['res'] = {'status': 'navigate',
                               'msg': 'マイメニュー → 配当・分配金 → 明細が表示されたら「取得」ボタンを押してください。'}

            elif a == 'rakuten_go':
                if state.get('broker') != 'rakuten' or not state.get('ctx'):
                    task['res'] = {'ok': False, 'error': 'セッション切れ。もう一度「楽天取得」を押してください。'}
                else:
                    page = state['ctx'].pages[-1]
                    csv_b64 = download_csv(page)
                    close()
                    task['res'] = {'ok': True, 'csv': csv_b64}

        except Exception as e:
            task['res'] = {'ok': False, 'error': str(e)}
        finally:
            ev.set()

threading.Thread(target=_pw_worker, daemon=True).start()

def pw_call(action, timeout=120, **kw):
    ev = threading.Event()
    task = {'action': action, 'ev': ev, 'res': None, **kw}
    _q.put(task)
    ev.wait(timeout=timeout)
    return task['res'] or {'ok': False, 'error': 'タイムアウト'}

# ── CORS ─────────────────────────────────────────────────────────
@app.after_request
def add_cors(r):
    r.headers['Access-Control-Allow-Origin']  = '*'
    r.headers['Access-Control-Allow-Methods'] = 'GET,POST,OPTIONS'
    r.headers['Access-Control-Allow-Headers'] = 'Content-Type'
    return r

# ── 静的ファイル ──────────────────────────────────────────────────
@app.route('/', defaults={'path': 'index.html'})
@app.route('/<path:path>')
def static_files(path):
    if path.startswith('api/'):
        return jsonify({'error': 'not found'}), 404
    return send_from_directory(str(BASE), path)

# ── API: SBI ─────────────────────────────────────────────────────
@app.route('/api/broker/sbi/open', methods=['POST', 'OPTIONS'])
def sbi_open():
    if request.method == 'OPTIONS': return '', 204
    days = (request.json or {}).get('days', 400)
    return jsonify(pw_call('sbi_open', days=days))

@app.route('/api/broker/sbi/go', methods=['POST', 'OPTIONS'])
def sbi_go():
    if request.method == 'OPTIONS': return '', 204
    return jsonify(pw_call('sbi_go'))

# ── API: 楽天 ────────────────────────────────────────────────────
@app.route('/api/broker/rakuten/open', methods=['POST', 'OPTIONS'])
def rakuten_open():
    if request.method == 'OPTIONS': return '', 204
    return jsonify(pw_call('rakuten_open'))

@app.route('/api/broker/rakuten/go', methods=['POST', 'OPTIONS'])
def rakuten_go():
    if request.method == 'OPTIONS': return '', 204
    return jsonify(pw_call('rakuten_go'))

# ── 起動 ─────────────────────────────────────────────────────────
if __name__ == '__main__':
    print(f'FIREシミュレーター → http://localhost:{PORT}')
    app.run(host='0.0.0.0', port=PORT, threaded=True, debug=False)
