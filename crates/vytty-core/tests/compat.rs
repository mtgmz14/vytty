//! Parity with Vytty 0.10 (JavaScript): the same fixtures and expectations as
//! the old test/unit/importers.test.js, exporters.test.js and the vault files
//! written by the 0.10 code (test/fixtures/*-0.10.json).
use serde_json::{json, Map, Value};
use std::path::PathBuf;
use vytty_core::exporters::{to_ansible_inventory, to_csv, to_ssh_config};
use vytty_core::importers::{mremoteng, parse_import, securecrt};
use vytty_core::vault::Vault;

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../test/fixtures").join(name)
}

fn read(name: &str) -> Vec<u8> {
    std::fs::read(fixture(name)).unwrap()
}

fn sessions(r: &Map<String, Value>) -> &Vec<Value> {
    r["sessions"].as_array().unwrap()
}

fn by_name<'a>(r: &'a Map<String, Value>, name: &str) -> &'a Value {
    sessions(r).iter().find(|s| s["name"] == json!(name)).unwrap_or_else(|| panic!("no session {name}"))
}

fn folder_path(r: &Map<String, Value>, id: &Value) -> String {
    let folders = r["folders"].as_array().unwrap();
    let mut parts = vec![];
    let mut cur = folders.iter().find(|f| &f["id"] == id);
    while let Some(f) = cur {
        parts.insert(0, f["name"].as_str().unwrap().to_string());
        cur = folders.iter().find(|x| x["id"] == f["parentId"]);
    }
    parts.join("/")
}

#[test]
fn putty_reg_utf16() {
    let r = parse_import("putty", &read("putty.reg"), None).unwrap();
    assert_eq!(sessions(&r).len(), 3);
    let ssh = by_name(&r, "core sw01");
    assert_eq!(
        (ssh["protocol"].clone(), ssh["host"].clone(), ssh["port"].clone(), ssh["username"].clone(), ssh["keyPath"].clone()),
        (json!("ssh"), json!("10.0.0.1"), json!(22), json!("admin"), json!("C:\\Users\\me\\keys\\core.ppk"))
    );
    let tel = by_name(&r, "old-switch");
    assert_eq!((tel["protocol"].clone(), tel["host"].clone(), tel["port"].clone(), tel["username"].clone()), (json!("telnet"), json!("10.0.0.9"), json!(23), json!("netops")));
    let ser = by_name(&r, "console");
    assert_eq!((ser["serialPath"].clone(), ser["baudRate"].clone(), ser["stopBits"].clone(), ser["flowControl"].clone()), (json!("COM4"), json!(9600), json!(1), json!("software")));
    assert_eq!(r["stats"]["skipped"]["Raw"], json!(1));
    assert_eq!(folder_path(&r, &ssh["folderId"]), "PuTTY");
    assert!(parse_import("putty", b"hello", None).unwrap_err().to_string().contains("registry export"));
}

#[test]
fn securecrt_xml_export() {
    let r = parse_import("securecrt", &read("securecrt.xml"), None).unwrap();
    let core = by_name(&r, "core-sw01");
    assert_eq!(
        (core["protocol"].clone(), core["host"].clone(), core["port"].clone(), core["username"].clone(), core["keyPath"].clone()),
        (json!("ssh"), json!("10.0.0.1"), json!(2222), json!("admin"), json!("C:\\keys\\id_ed25519"))
    );
    assert!(core["notes"].as_str().unwrap().contains("bastion"));
    assert_eq!(folder_path(&r, &core["folderId"]), "SecureCRT/Datacenter & Lab");
    let tel = by_name(&r, "sw-telnet");
    assert_eq!(folder_path(&r, &tel["folderId"]), "SecureCRT/Datacenter & Lab/Access");
    assert_eq!(tel["protocol"], json!("telnet"));
    let ser = by_name(&r, "console");
    assert_eq!(
        (ser["serialPath"].clone(), ser["baudRate"].clone(), ser["parity"].clone(), ser["stopBits"].clone(), ser["flowControl"].clone()),
        (json!("COM3"), json!(115200), json!("even"), json!(2), json!("hardware"))
    );
    assert!(sessions(&r).iter().all(|s| s["name"] != json!("Default")), "the Default template is not a session");
    assert_eq!(r["stats"]["skipped"]["RLogin"], json!(1));
}

#[test]
fn securecrt_session_folder() {
    let dir = std::env::temp_dir().join(format!("vytty-scrt-{}", std::process::id()));
    std::fs::create_dir_all(dir.join("Core")).unwrap();
    std::fs::write(dir.join("Core/sw1.ini"), "S:\"Protocol Name\"=SSH2\r\nS:\"Hostname\"=10.1.1.1\r\nS:\"Username\"=admin\r\nD:\"[SSH2] Port\"=00000016\r\nB:\"Something\"=00000002\r\n 00 01\r\n").unwrap();
    std::fs::write(dir.join("Core/__FolderData__.ini"), "S:\"Is Expanded\"=1\r\n").unwrap();
    std::fs::write(dir.join("Default.ini"), "S:\"Protocol Name\"=SSH2\r\n").unwrap();
    let r = securecrt::parse_session_dir(&dir).unwrap();
    assert_eq!(sessions(&r).len(), 1);
    let s = &sessions(&r)[0];
    assert_eq!((s["name"].clone(), s["host"].clone(), s["port"].clone()), (json!("sw1"), json!("10.1.1.1"), json!(22)));
    assert_eq!(folder_path(&r, &s["folderId"]), "SecureCRT/Core");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn mremoteng_default_key_written_by_0_10() {
    let r = parse_import("mremoteng", &read("mremoteng-default.xml"), None).unwrap();
    let r1 = by_name(&r, "r1");
    let r2 = by_name(&r, "r2");
    assert_eq!((r1["protocol"].clone(), r1["host"].clone(), r1["username"].clone(), r1["notes"].clone()), (json!("ssh"), json!("10.2.0.1"), json!("netops"), json!("edge router")));
    assert_eq!(folder_path(&r, &r1["folderId"]), "mRemoteNG/Routers");
    assert_eq!(r["secrets"][r1["id"].as_str().unwrap()], json!({"password": "folder-secret"}));
    assert_eq!(r["secrets"][r2["id"].as_str().unwrap()], json!({"password": "telnet-secret"}));
    assert_eq!(r2["protocol"], json!("telnet"));
    assert_eq!(r["stats"]["skipped"]["RDP"], json!(1));
    assert_eq!(r["protected"], json!(false));
}

#[test]
fn mremoteng_protected_needs_the_master_password() {
    let xml = read("mremoteng-protected.xml");
    let without = parse_import("mremoteng", &xml, None).unwrap();
    assert_eq!(without["protected"], json!(true));
    assert!(without["secrets"].as_object().unwrap().is_empty());
    assert_eq!(sessions(&without).len(), 2);
    let with = parse_import("mremoteng", &xml, Some("S3cret!")).unwrap();
    assert_eq!(with["secrets"].as_object().unwrap().len(), 2);
    assert!(parse_import("mremoteng", &xml, Some("wrong")).unwrap_err().to_string().contains("Wrong mRemoteNG master password"));
    // Round trip of our own encryption, and the legacy CBC format from 0.10's test.
    let enc = mremoteng::encrypt_gcm("x y", "pw", 1000);
    assert_eq!(mremoteng::decrypt_gcm(&enc, "pw", 1000).unwrap(), "x y");
    let cbc = String::from_utf8(read("mremoteng-cbc.txt")).unwrap();
    assert_eq!(mremoteng::decrypt_cbc(&cbc, "mR3m").unwrap(), "old-pass");
}

#[test]
fn openssh_config() {
    let r = parse_import("sshconfig", &read("ssh_config"), None).unwrap();
    let mut names: Vec<String> = sessions(&r).iter().map(|s| s["name"].as_str().unwrap().to_string()).collect();
    names.sort();
    assert_eq!(names, vec!["bastion", "core-sw01", "db1"]);
    let bastion = by_name(&r, "bastion");
    let core = by_name(&r, "core-sw01");
    assert_eq!((bastion["host"].clone(), bastion["port"].clone(), bastion["username"].clone()), (json!("bastion.example.com"), json!(2222), json!("jump")));
    assert_eq!(core["jumpId"], bastion["id"]);
    assert_eq!(core["username"], json!("admin"));
    let key = core["keyPath"].as_str().unwrap();
    assert!(key.ends_with(".ssh/id_ed25519") || key.ends_with(".ssh\\id_ed25519"), "{key}");
    assert!(!key.starts_with('~'));
    assert_eq!(
        core["forwards"],
        json!([
            {"type": "L", "listenHost": "127.0.0.1", "listenPort": 8443, "destHost": "10.0.0.1", "destPort": 443},
            {"type": "D", "listenHost": "127.0.0.1", "listenPort": 1080}
        ])
    );
    let db = by_name(&r, "db1");
    assert_eq!((db["host"].clone(), db["username"].clone()), (json!("db1.db.example.com"), json!("fallback")));
    assert_eq!(r["stats"]["skippedBlocks"]["match"], json!(1));
}

#[test]
fn csv_import() {
    let r = parse_import("csv", &read("sessions.csv"), None).unwrap();
    assert_eq!(sessions(&r).len(), 4);
    let core = by_name(&r, "core-sw01");
    assert_eq!(
        (core["host"].clone(), core["port"].clone(), core["username"].clone(), core["notes"].clone(), core["highlight"].clone()),
        (json!("10.0.0.1"), json!(22), json!("admin"), json!("Core; main"), json!("cisco-nxos"))
    );
    assert_eq!(folder_path(&r, &core["folderId"]), "DC/Core");
    let edge = by_name(&r, "edge-rtr");
    assert_eq!(
        (edge["protocol"].clone(), edge["host"].clone(), edge["port"].clone(), edge["username"].clone(), edge["highlight"].clone()),
        (json!("telnet"), json!("10.0.0.254"), json!(23), json!("admin"), json!("cisco-ios"))
    );
    let web = by_name(&r, "web01");
    assert_eq!((web["protocol"].clone(), web["port"].clone(), web["highlight"].clone()), (json!("ssh"), json!(2222), json!("linux")));
    assert!(parse_import("csv", b"a,b\n1,2\n", None).unwrap_err().to_string().contains("No host"));
}

#[test]
fn mobaxterm() {
    let r = parse_import("mobaxterm", &read("sample.mxtsessions"), None).unwrap();
    let core1 = by_name(&r, "core-sw01");
    let core2 = by_name(&r, "core-sw02");
    assert_eq!(folder_path(&r, &core1["folderId"]), "Network/Core");
    assert_eq!(core1["username"], json!("admin"));
    let home = dirs::home_dir().unwrap().to_string_lossy().to_string();
    assert!(core1["keyPath"].as_str().unwrap().starts_with(&home), "{}", core1["keyPath"]);
    assert!(core1["jumpId"].is_string() && core1["jumpId"] == core2["jumpId"], "one jump session per gateway");
    let jump = sessions(&r).iter().find(|s| s["id"] == core1["jumpId"]).unwrap();
    assert_eq!((jump["host"].clone(), jump["port"].clone(), jump["username"].clone()), (json!("bastion.example.com"), json!(2222), json!("jumpuser")));
    assert_eq!(folder_path(&r, &jump["folderId"]), "Jump hosts");
    assert_eq!(by_name(&r, "old-sw")["protocol"], json!("telnet"));
    assert_eq!(by_name(&r, "console")["serialPath"], json!("COM3"));
    assert_eq!(r["stats"]["skipped"]["RDP"], json!(1));
}

fn export_tree() -> Value {
    json!({
        "folders": [{"id": "f1", "name": "DC", "parentId": null}, {"id": "f2", "name": "Core 1", "parentId": "f1"}],
        "sessions": [
            {"id": "j", "name": "bastion", "protocol": "ssh", "host": "bastion.example.com", "port": 2222, "username": "jump", "folderId": null},
            {"id": "s1", "name": "core sw01", "protocol": "ssh", "host": "10.0.0.1", "port": 22, "username": "admin", "folderId": "f2", "jumpId": "j", "highlight": "cisco-nxos",
             "keyPath": "C:\\Users\\me\\.ssh\\id ed", "forwards": [{"type": "L", "listenPort": 8443, "destHost": "10.0.0.1", "destPort": 443}, {"type": "D", "listenPort": 1080}], "legacyAlgorithms": true},
            {"id": "s2", "name": "=cmd", "protocol": "telnet", "host": "10.0.0.2", "port": 23, "folderId": "f1", "notes": "line1, \"quoted\"", "highlight": "cisco-ios"},
            {"id": "s3", "name": "console", "protocol": "serial", "serialPath": "COM3", "baudRate": 9600}
        ]
    })
}

#[test]
fn ssh_config_export_round_trips() {
    let text = to_ssh_config(&export_tree());
    assert!(text.contains("Host core-sw01\n    HostName 10.0.0.1\n    User admin\n"), "{text}");
    assert!(text.contains("ProxyJump bastion"));
    assert!(text.contains("IdentityFile \"C:\\Users\\me\\.ssh\\id ed\""));
    assert!(text.contains("LocalForward 8443 10.0.0.1:443"));
    assert!(text.contains("DynamicForward 1080"));
    assert!(text.contains("HostKeyAlgorithms +ssh-rsa"));
    let back = parse_import("sshconfig", text.as_bytes(), None).unwrap();
    assert_eq!(by_name(&back, "core-sw01")["jumpId"], by_name(&back, "bastion")["id"]);
    assert_eq!(by_name(&back, "bastion")["port"], json!(2222));
}

#[test]
fn csv_export_escapes_and_reimports() {
    let csv = to_csv(&export_tree());
    assert!(csv.starts_with("\u{feff}name,folder,protocol"));
    assert!(csv.contains("'=cmd"));
    assert!(csv.contains("\"line1, \"\"quoted\"\"\""));
    assert!(csv.contains("core sw01,DC/Core 1,ssh,10.0.0.1,22,admin"));
    let back = parse_import("csv", csv.as_bytes(), None).unwrap();
    assert_eq!(sessions(&back).len(), 4);
}

#[test]
fn ansible_inventory() {
    let inv = to_ansible_inventory(&export_tree());
    assert!(inv.contains("[dc_core_1]\ncore-sw01 ansible_host=10.0.0.1 ansible_user=admin ansible_connection=ansible.netcommon.network_cli ansible_network_os=cisco.nxos.nxos"), "{inv}");
    assert!(inv.contains("[ungrouped]\nbastion ansible_host=bastion.example.com ansible_port=2222 ansible_user=jump"));
    assert!(inv.contains("cisco.ios.ios"));
    assert!(!inv.contains("COM3"));
}

fn tmp_copy(name: &str) -> (PathBuf, PathBuf) {
    let dir = std::env::temp_dir().join(format!("vytty-compat-{}-{}", name, std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let f = dir.join("vault.json");
    std::fs::copy(fixture(name), &f).unwrap();
    (dir, f)
}

#[test]
fn vault_written_by_0_10_opens() {
    let (dir, f) = tmp_copy("vault-0.10.json");
    let v = Vault::new(f);
    assert_eq!(v.status()["mode"], json!("master"));
    assert!(v.unlock("wrong").is_err());
    v.unlock("fixture-pass").unwrap();
    assert_eq!(Value::Object(v.get("s1").unwrap()), json!({"password": "p1", "passphrase": "k1"}));
    assert_eq!(v.get("cred:c1").unwrap()["password"], json!("zażółć"));
    // Secrets exported by 0.10 import into a new id.
    let blob: Value = serde_json::from_slice(&read("secrets-export-0.10.json")).unwrap();
    let map: Map<String, Value> = [("s1".to_string(), json!("new-s1"))].into_iter().collect();
    v.import_secrets(&blob, "export-pass", &map).unwrap();
    assert_eq!(v.get("new-s1").unwrap()["passphrase"], json!("k1"));
    let _ = std::fs::remove_dir_all(dir);

    let (dir, f) = tmp_copy("vault-0.10-nomaster.json");
    let v = Vault::new(f);
    v.unlock("").unwrap();
    assert_eq!(v.get("s9").unwrap()["password"], json!("nomaster"));
    let _ = std::fs::remove_dir_all(dir);
}
