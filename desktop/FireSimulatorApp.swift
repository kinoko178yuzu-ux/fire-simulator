import AppKit
import Foundation
import SQLite3
import WebKit

private let SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
private let appName = "Fire Simulator"
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
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKScriptMessageHandler {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var store: StateDatabase!

    func applicationDidFinishLaunching(_ notification: Notification) {
        do { store = try StateDatabase() } catch { fatalError("Database initialization failed: \(error)") }
        let controller = WKUserContentController()
        controller.add(self, name: "fireStore")
        controller.addUserScript(WKUserScript(source: bootstrapScript(store.loadAll()), injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let config = WKWebViewConfiguration(); config.userContentController = controller
        webView = WKWebView(frame: .zero, configuration: config)
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 920), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "資産管理 — Fire Simulator"
        window.contentView = webView; window.center(); window.makeKeyAndOrderFront(nil)
        guard let webRoot = Bundle.main.resourceURL?.appendingPathComponent("web"), FileManager.default.fileExists(atPath: webRoot.appendingPathComponent("index.html").path) else {
            fatalError("Bundled web assets are missing")
        }
        webView.loadFileURL(webRoot.appendingPathComponent("index.html"), allowingReadAccessTo: webRoot)
        NSApp.activate(ignoringOtherApps: true)
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
        })();
        """
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
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
