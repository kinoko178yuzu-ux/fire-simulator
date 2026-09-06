import AppKit
import Foundation
import SQLite3
import UniformTypeIdentifiers
import UserNotifications
import WebKit

private let SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
private let appName = "資産管理アプリ"
private let storageKeys = [
    "sideFireCalculator_v4", "sfs_autobk", "sfs_account_history_v1",
    "sfs_budget_history_v1", "sfs_input_settings_v1"
]

final class StateDatabase {
    private var db: OpaquePointer?
    let url: URL

    init() throws {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent(appName, isDirectory: true)
        try FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        url = support.appendingPathComponent("fire_simulator.sqlite3")
        guard sqlite3_open(url.path, &db) == SQLITE_OK else { throw NSError(domain: appName, code: 1) }
        exec("PRAGMA journal_mode=WAL")
        exec("CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)")
        exec("CREATE TABLE IF NOT EXISTS state_backups (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, value TEXT NOT NULL, created_at TEXT NOT NULL)")
        exec("CREATE TABLE IF NOT EXISTS monthly_imports (target_month TEXT NOT NULL, item TEXT NOT NULL, completed INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, PRIMARY KEY(target_month,item))")
    }

    deinit { sqlite3_close(db) }

    private func exec(_ sql: String) { sqlite3_exec(db, sql, nil, nil, nil) }

    func loadAll() -> [String: String] {
        var result: [String: String] = [:]
        var stmt: OpaquePointer?
        sqlite3_prepare_v2(db, "SELECT key,value FROM app_state", -1, &stmt, nil)
        defer { sqlite3_finalize(stmt) }
        while sqlite3_step(stmt) == SQLITE_ROW {
            if let k = sqlite3_column_text(stmt, 0), let v = sqlite3_column_text(stmt, 1) {
                result[String(cString: k)] = String(cString: v)
            }
        }
        return result
    }

    func save(key: String, value: String) {
        guard storageKeys.contains(key) else { return }
        let old = loadAll()[key]
        guard old != value else { return }
        let now = ISO8601DateFormatter().string(from: Date())
        if let old {
            var backup: OpaquePointer?
            sqlite3_prepare_v2(db, "INSERT INTO state_backups(key,value,created_at) VALUES(?,?,?)", -1, &backup, nil)
            sqlite3_bind_text(backup, 1, key, -1, SQLITE_TRANSIENT)
            sqlite3_bind_text(backup, 2, old, -1, SQLITE_TRANSIENT)
            sqlite3_bind_text(backup, 3, now, -1, SQLITE_TRANSIENT)
            sqlite3_step(backup); sqlite3_finalize(backup)
        }
        var stmt: OpaquePointer?
        sqlite3_prepare_v2(db, "INSERT INTO app_state(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at", -1, &stmt, nil)
        sqlite3_bind_text(stmt, 1, key, -1, SQLITE_TRANSIENT)
        sqlite3_bind_text(stmt, 2, value, -1, SQLITE_TRANSIENT)
        sqlite3_bind_text(stmt, 3, now, -1, SQLITE_TRANSIENT)
        sqlite3_step(stmt); sqlite3_finalize(stmt)
        exec("DELETE FROM state_backups WHERE id NOT IN (SELECT id FROM state_backups WHERE key='\(key)' ORDER BY id DESC LIMIT 100) AND key='\(key)'")
    }

    func importStatus(month: String) -> [String: Bool] {
        var result: [String: Bool] = [:]; var stmt: OpaquePointer?
        sqlite3_prepare_v2(db, "SELECT item,completed FROM monthly_imports WHERE target_month=?", -1, &stmt, nil)
        sqlite3_bind_text(stmt, 1, month, -1, SQLITE_TRANSIENT); defer { sqlite3_finalize(stmt) }
        while sqlite3_step(stmt) == SQLITE_ROW, let item = sqlite3_column_text(stmt, 0) {
            result[String(cString:item)] = sqlite3_column_int(stmt, 1) == 1
        }
        return result
    }

    func setImportStatus(month: String, item: String, completed: Bool) {
        var stmt: OpaquePointer?; let now=ISO8601DateFormatter().string(from:Date())
        sqlite3_prepare_v2(db, "INSERT INTO monthly_imports(target_month,item,completed,updated_at) VALUES(?,?,?,?) ON CONFLICT(target_month,item) DO UPDATE SET completed=excluded.completed,updated_at=excluded.updated_at", -1, &stmt, nil)
        sqlite3_bind_text(stmt,1,month,-1,SQLITE_TRANSIENT); sqlite3_bind_text(stmt,2,item,-1,SQLITE_TRANSIENT)
        sqlite3_bind_int(stmt,3,completed ? 1:0); sqlite3_bind_text(stmt,4,now,-1,SQLITE_TRANSIENT)
        sqlite3_step(stmt); sqlite3_finalize(stmt)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKScriptMessageHandler {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var store: StateDatabase!
    private let importItems = ["マネーフォワード家計簿", "マネーフォワード資産", "SBI証券", "楽天証券（本人）", "楽天証券（奥様）"]

    func applicationDidFinishLaunching(_ notification: Notification) {
        do { store = try StateDatabase() } catch { fatalError("Database initialization failed: \(error)") }
        let controller = WKUserContentController()
        controller.add(self, name: "fireStore")
        controller.add(self, name: "desktopBridge")
        controller.addUserScript(WKUserScript(source: bootstrapScript(store.loadAll()), injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let config = WKWebViewConfiguration(); config.userContentController = controller
        webView = WKWebView(frame: .zero, configuration: config)
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 920), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "資産管理アプリ"
        let container=NSView(); window.contentView=container
        let bar=NSStackView(); bar.orientation = .horizontal; bar.spacing=8; bar.edgeInsets=NSEdgeInsets(top:8,left:10,bottom:8,right:10)
        let checklist=NSButton(title:"✅ 月次取込チェック",target:self,action:#selector(openChecklist)); checklist.bezelStyle = .rounded
        let settings=NSButton(title:"⚙️ 通知設定",target:self,action:#selector(openReminderSettings)); settings.bezelStyle = .rounded
        let chrome=NSButton(title:"🌐 ChromeでMF連携",target:self,action:#selector(openMFInChrome)); chrome.bezelStyle = .rounded
        let importBackup=NSButton(title:"📥 Chromeのバックアップを取込",target:self,action:#selector(importBrowserBackup)); importBackup.bezelStyle = .rounded
        bar.addArrangedSubview(checklist); bar.addArrangedSubview(settings); bar.addArrangedSubview(chrome); bar.addArrangedSubview(importBackup); bar.addArrangedSubview(NSView())
        [bar,webView].forEach{$0.translatesAutoresizingMaskIntoConstraints=false;container.addSubview($0)}
        NSLayoutConstraint.activate([bar.topAnchor.constraint(equalTo:container.topAnchor),bar.leadingAnchor.constraint(equalTo:container.leadingAnchor),bar.trailingAnchor.constraint(equalTo:container.trailingAnchor),bar.heightAnchor.constraint(equalToConstant:48),webView.topAnchor.constraint(equalTo:bar.bottomAnchor),webView.leadingAnchor.constraint(equalTo:container.leadingAnchor),webView.trailingAnchor.constraint(equalTo:container.trailingAnchor),webView.bottomAnchor.constraint(equalTo:container.bottomAnchor)])
        window.center(); window.makeKeyAndOrderFront(nil)
        guard let webRoot = Bundle.main.resourceURL?.appendingPathComponent("web"), FileManager.default.fileExists(atPath: webRoot.appendingPathComponent("index.html").path) else {
            fatalError("Bundled web assets are missing")
        }
        webView.loadFileURL(webRoot.appendingPathComponent("index.html"), allowingReadAccessTo: webRoot)
        NSApp.activate(ignoringOtherApps: true)
        configureReminder()
    }

    private func targetMonth() -> String {
        let d=Calendar.current.date(byAdding:.month,value:-1,to:Date())!; let f=DateFormatter(); f.dateFormat="yyyy-MM"; return f.string(from:d)
    }

    private func configureReminder() {
        UNUserNotificationCenter.current().requestAuthorization(options:[.alert,.sound]) { ok,_ in if ok { self.scheduleReminder() } }
    }

    private func scheduleReminder() {
        let defaults=UserDefaults.standard, day=max(1,min(28,defaults.integer(forKey:"reminderDay") == 0 ? 5:defaults.integer(forKey:"reminderDay")))
        let hour=defaults.object(forKey:"reminderHour") == nil ? 9:defaults.integer(forKey:"reminderHour")
        UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers:["monthly-csv-reminder"])
        var c=DateComponents(); c.day=day; c.hour=hour; c.minute=0
        let content=UNMutableNotificationContent(); content.title="資産管理データの更新日です"; content.body="マネーフォワード、SBI証券、楽天証券2口座の前月分を確認してください。"; content.sound = .default
        let req=UNNotificationRequest(identifier:"monthly-csv-reminder",content:content,trigger:UNCalendarNotificationTrigger(dateMatching:c,repeats:true))
        UNUserNotificationCenter.current().add(req)
    }

    @objc private func openReminderSettings() {
        let alert=NSAlert(); alert.messageText="CSV取込の通知設定"; alert.informativeText="毎月指定日にMacへ通知します（1〜28日）。"
        let form=NSStackView(); form.orientation = .vertical; form.spacing=8; form.frame=NSRect(x:0,y:0,width:280,height:70)
        let day=NSTextField(string:String(UserDefaults.standard.integer(forKey:"reminderDay") == 0 ? 5:UserDefaults.standard.integer(forKey:"reminderDay")))
        let hour=NSTextField(string:String(UserDefaults.standard.object(forKey:"reminderHour") == nil ? 9:UserDefaults.standard.integer(forKey:"reminderHour")))
        let row1=NSStackView(views:[NSTextField(labelWithString:"毎月の日付"),day,NSTextField(labelWithString:"日")]); row1.spacing=8
        let row2=NSStackView(views:[NSTextField(labelWithString:"通知時刻"),hour,NSTextField(labelWithString:"時")]); row2.spacing=8
        form.addArrangedSubview(row1); form.addArrangedSubview(row2); alert.accessoryView=form; alert.addButton(withTitle:"保存"); alert.addButton(withTitle:"キャンセル")
        if alert.runModal() == .alertFirstButtonReturn {
            UserDefaults.standard.set(max(1,min(28,day.integerValue)),forKey:"reminderDay"); UserDefaults.standard.set(max(0,min(23,hour.integerValue)),forKey:"reminderHour"); scheduleReminder()
        }
    }

    @objc private func openChecklist() {
        let month=targetMonth(), status=store.importStatus(month:month), alert=NSAlert(); alert.messageText="\(month)分の取込チェック"; alert.informativeText="完了した項目にチェックしてください。未完了があれば毎月の通知で確認できます。"
        let stack=NSStackView(); stack.orientation = .vertical; stack.alignment = .leading; stack.spacing=7; stack.frame=NSRect(x:0,y:0,width:330,height:145)
        var boxes:[NSButton]=[]
        for item in importItems { let b=NSButton(checkboxWithTitle:item,target:nil,action:nil); b.state=status[item] == true ? .on:.off; boxes.append(b); stack.addArrangedSubview(b) }
        alert.accessoryView=stack; alert.addButton(withTitle:"保存"); alert.addButton(withTitle:"閉じる")
        if alert.runModal() == .alertFirstButtonReturn { for (i,b) in boxes.enumerated(){store.setImportStatus(month:month,item:importItems[i],completed:b.state == .on)} }
    }

    @objc private func openMFInChrome() {
        NSWorkspace.shared.open(URL(string: "https://kinoko178yuzu-ux.github.io/fire-simulator/?desktopImport=1#assetTimelineCard")!)
    }

    @objc private func importBrowserBackup() {
        let panel=NSOpenPanel(); panel.title="Chrome版で保存したバックアップを選択"; panel.allowedContentTypes=[.json]; panel.allowsMultipleSelection=false
        guard panel.runModal() == .OK, let url=panel.url,
              let data=try? Data(contentsOf:url),
              let object=try? JSONSerialization.jsonObject(with:data) as? [String:Any],
              object["currentAge"] != nil,
              let text=String(data:data,encoding:.utf8) else {
            if panel.url != nil { let a=NSAlert(); a.messageText="バックアップを読み込めません"; a.informativeText="Chrome版の「バックアップ保存」で作成したJSONを選んでください。"; a.runModal() }
            return
        }
        store.save(key:"sideFireCalculator_v4",value:text)
        let encoded=try! String(data:JSONSerialization.data(withJSONObject:text),encoding:.utf8)!
        webView.evaluateJavaScript("localStorage.setItem('sideFireCalculator_v4', \(encoded)); location.reload();")
        let a=NSAlert(); a.messageText="Chrome版のデータを取り込みました"; a.informativeText="画面を更新し、SQLiteにも自動保存しました。"; a.runModal()
    }

    private func bootstrapScript(_ values: [String: String]) -> String {
        let data = try! JSONSerialization.data(withJSONObject: values)
        let json = String(data: data, encoding: .utf8)!
        let keys = try! String(data: JSONSerialization.data(withJSONObject: storageKeys), encoding: .utf8)!
        return """
        (() => {
          const initial = \(json), managed = new Set(\(keys));
          Object.entries(initial).forEach(([k,v]) => localStorage.setItem(k,v));
          localStorage.removeItem('fireSync_passphrase');
          const original = localStorage.setItem.bind(localStorage);
          localStorage.setItem = (k,v) => {
            original(k,v);
            if (managed.has(k)) window.webkit.messageHandlers.fireStore.postMessage({key:k,value:String(v)});
          };
          window.__FIRE_DESKTOP__ = true;
          document.addEventListener('DOMContentLoaded', () => {
            document.querySelectorAll('.mf-asset-status').forEach(e => e.innerHTML = '<span style="color:var(--teal-deep);">アプリ版ではChromeを連携窓口として使用します。「マネフォから資産を取得」を押すとChrome版が開きます。</span>');
            const status = document.getElementById('mfBridgeStatus');
            if (status) { status.textContent = '🌐 Chrome経由で連携'; status.style.color = 'var(--teal-deep)'; }
            const brokerStatus = document.getElementById('divBrokerApiStatus');
            if (brokerStatus) brokerStatus.innerHTML = '<span style="color:var(--teal-deep);">🌐 SBI証券・楽天証券の自動取得はChrome経由で行います。</span>';
            document.addEventListener('click', ev => {
              const target = ev.target && ev.target.closest && ev.target.closest('#btnMfUnifiedFetch,#btnMfAssetFetch,#mfAutoBtn,#btnSbiFetch,#btnRakutenFetch,[onclick*="mfAssetFetch"],a[href$=".user.js"]');
              if (!target) return;
              ev.preventDefault(); ev.stopImmediatePropagation();
              window.webkit.messageHandlers.desktopBridge.postMessage({action:'openChrome'});
            }, true);
          });
        })();
        """
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "desktopBridge" {
            if let body=message.body as? [String:Any], body["action"] as? String == "openChrome" { openMFInChrome() }
            return
        }
        guard let body = message.body as? [String: Any], let key = body["key"] as? String, let value = body["value"] as? String else { return }
        store.save(key: key, value: value)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
