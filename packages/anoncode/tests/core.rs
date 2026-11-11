use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

use anoncode::efs::Efs;
use anoncode::focus::{self, Request, Span};
use anoncode::projects::Projects;
use anoncode::runspace;
use anoncode::store::Store;
use anoncode::vault::{KdfParams, Vault, VaultHeader};
use anoncode::Error;

fn tmp(name: &str) -> PathBuf {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn vault() -> Vault {
    Vault::create_with("correct horse", KdfParams::for_tests(), false).unwrap()
}

#[test]
fn unlock_needs_the_passphrase() {
    let v = vault();
    assert!(Vault::unlock_with("correct horse", &v.header, false).is_ok());
    assert!(matches!(Vault::unlock_with("wrong", &v.header, false), Err(Error::WrongPassphrase)));
}

#[test]
fn cheap_or_huge_cost_is_refused_before_deriving() {
    let v = vault();
    assert!(matches!(Vault::unlock("correct horse", &v.header), Err(Error::Kdf)));
    let mut huge = v.header.clone();
    huge.kdf.memory_kib = 4 * 1024 * 1024;
    assert!(matches!(Vault::unlock("correct horse", &huge), Err(Error::Kdf)));
    let mut unknown = v.header.clone();
    unknown.kdf.algo = "pbkdf2".into();
    assert!(matches!(Vault::unlock_with("correct horse", &unknown, false), Err(Error::Kdf)));
    assert!(KdfParams::default_cost().check().is_ok());
    assert!(KdfParams::for_random_secret().check().is_ok());
    assert!(KdfParams::scrypt_v1().check().is_ok());
    assert_eq!(KdfParams::default_cost().algo, "argon2id");
}

#[test]
fn sealed_blobs_round_trip_and_detect_tampering() {
    let v = vault();
    let sealed = v.seal(b"secret source").unwrap();
    assert!(!sealed.windows(6).any(|w| w == b"secret"));
    assert_eq!(&v.open(&sealed).unwrap()[..], b"secret source");
    for i in [4, 20, sealed.len() - 1] {
        let mut bad = sealed.clone();
        bad[i] ^= 1;
        assert!(matches!(v.open(&bad), Err(Error::Damaged)));
    }
    let other = vault();
    assert!(matches!(other.open(&sealed), Err(Error::Damaged)));
}

/// A header and a record written by the first AnonCode (Bun, node:crypto):
/// passphrase "hunter2-test", scrypt N=16384 r=8 p=1.
#[test]
fn opens_a_vault_made_by_the_first_anoncode() {
    let header = fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/v1-vault.json")).unwrap();
    let record = fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/v1-record.enc")).unwrap();
    let header: VaultHeader = serde_json::from_str(&header).unwrap();
    let v = Vault::unlock("hunter2-test", &header).unwrap();
    assert_eq!(&v.open(&record).unwrap()[..], b"{\"hello\":\"from anoncode 1\"}");
    assert!(matches!(Vault::unlock("hunter3-test", &header), Err(Error::WrongPassphrase)));
}

#[test]
fn store_keeps_names_inside_and_lists_records() {
    let dir = tmp("store");
    let s = Store::new(Arc::new(vault()), &dir).unwrap();
    s.put("sessions", "b", b"two").unwrap();
    s.put("sessions", "a", b"one").unwrap();
    assert_eq!(s.list("sessions").unwrap(), ["a", "b"]);
    assert_eq!(&s.get("sessions", "a").unwrap().unwrap()[..], b"one");
    assert!(s.get("sessions", "zzz").unwrap().is_none());
    for bad in ["../x", "a/b", ".hidden", "", "a..b"] {
        assert!(matches!(s.put("sessions", bad, b"x"), Err(Error::Unsafe(_))), "{bad}");
    }
    // A collection may be nested, but no part of it may climb out.
    s.put("messages/s1", "m1", b"x").unwrap();
    for bad in ["../x", ".hidden", "", "a..b", "a//b", "a/../b"] {
        assert!(matches!(s.put(bad, "id", b"x"), Err(Error::Unsafe(_))), "{bad}");
    }
    let on_disk = fs::read(dir.join("sessions/a.enc")).unwrap();
    assert!(!on_disk.windows(3).any(|w| w == b"one"));
}

#[test]
fn runspace_round_trip() {
    let dir = tmp("run");
    let store = Store::new(Arc::new(vault()), dir.join("sealed")).unwrap();
    let work = dir.join("work");

    let mut efs = Efs::open(store.clone(), "project").unwrap();
    efs.write("src/main.rs", b"fn main() {}", 1_700_000_000_000, false).unwrap();
    efs.write("run.sh", b"#!/bin/sh\n", 1_700_000_000_000, true).unwrap();
    efs.flush().unwrap();

    assert_eq!(runspace::materialize(&efs, &work).unwrap(), 2);
    assert_eq!(fs::read(work.join("src/main.rs")).unwrap(), b"fn main() {}");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(fs::metadata(work.join("run.sh")).unwrap().permissions().mode() & 0o111, 0o100);
    }

    // Nothing changed: nothing is sealed again.
    let s = runspace::sync_back(&mut efs, &work).unwrap();
    assert_eq!((s.changed.len(), s.deleted.len()), (0, 0), "{s:?}");

    fs::write(work.join("src/main.rs"), b"fn main() { println!(); }").unwrap();
    fs::write(work.join("new.txt"), b"hi").unwrap();
    fs::remove_file(work.join("run.sh")).unwrap();
    fs::create_dir_all(work.join("node_modules/x")).unwrap();
    fs::write(work.join("node_modules/x/index.js"), b"big").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink("new.txt", work.join("link")).unwrap();

    let mut s = runspace::sync_back(&mut efs, &work).unwrap();
    s.changed.sort();
    #[cfg(unix)]
    assert_eq!(s.changed, ["link", "new.txt", "src/main.rs"]);
    assert_eq!(s.deleted, ["run.sh"]);

    runspace::wipe(&work).unwrap();
    assert!(!work.exists());

    // A fresh open of the sealed tree gives back exactly what was synced.
    let efs = Efs::open(store, "project").unwrap();
    runspace::materialize(&efs, &work).unwrap();
    assert_eq!(fs::read(work.join("src/main.rs")).unwrap(), b"fn main() { println!(); }");
    assert_eq!(fs::read(work.join("new.txt")).unwrap(), b"hi");
    assert!(!work.join("run.sh").exists());
    assert!(!work.join("node_modules").exists());
    #[cfg(unix)]
    assert_eq!(fs::read_link(work.join("link")).unwrap().to_str(), Some("new.txt"));
}

#[test]
fn record_names_are_keyed_and_first_anoncode_records_still_read() {
    use sha2::{Digest, Sha256};
    let dir = tmp("names");
    let v = Arc::new(vault());
    let store = Store::new(v.clone(), dir.join("sealed")).unwrap();
    let unkeyed = format!("f{}", Sha256::digest(b".env").iter().map(|b| format!("{b:02x}")).collect::<String>());

    let mut efs = Efs::open(store.clone(), "project").unwrap();
    efs.write(".env", b"KEY=1", 0, false).unwrap();
    efs.flush().unwrap();
    // The name on disk can't be worked out from the path alone.
    assert!(!store.has("project", &unkeyed));
    assert_eq!(store.list("project").unwrap().len(), 2);

    // A project from the first AnonCode: unkeyed name, plain manifest.
    store.put("old", &unkeyed, b"KEY=old").unwrap();
    store.put("old", "manifest", br#"{".env":{"size":7,"mtime":1}}"#).unwrap();
    let mut old = Efs::open(store.clone(), "old").unwrap();
    assert_eq!(&old.read(".env").unwrap().unwrap()[..], b"KEY=old");
    // Rewriting moves it to a keyed name.
    old.write(".env", b"KEY=new", 2, false).unwrap();
    old.flush().unwrap();
    assert!(!store.has("old", &unkeyed));
    assert_eq!(&Efs::open(store.clone(), "old").unwrap().read(".env").unwrap().unwrap()[..], b"KEY=new");

    // Removed and written again before a flush: the record survives.
    let mut efs = Efs::open(store.clone(), "project").unwrap();
    efs.remove(".env").unwrap();
    efs.write(".env", b"KEY=2", 0, false).unwrap();
    efs.flush().unwrap();
    assert_eq!(&Efs::open(store.clone(), "project").unwrap().read(".env").unwrap().unwrap()[..], b"KEY=2");

    // A delete that never reaches the manifest loses nothing.
    let mut efs = Efs::open(store.clone(), "project").unwrap();
    efs.remove(".env").unwrap();
    drop(efs);
    assert_eq!(&Efs::open(store, "project").unwrap().read(".env").unwrap().unwrap()[..], b"KEY=2");
}

#[test]
fn paths_cannot_leave_the_project() {
    let dir = tmp("escape");
    let store = Store::new(Arc::new(vault()), dir.join("sealed")).unwrap();
    let mut efs = Efs::open(store, "project").unwrap();
    assert!(matches!(efs.write("../outside", b"x", 0, false), Err(Error::Unsafe(_))));
    assert!(matches!(efs.write("a/../../outside", b"x", 0, false), Err(Error::Unsafe(_))));
    assert!(matches!(efs.write("", b"x", 0, false), Err(Error::Unsafe(_))));
}

#[test]
fn project_registry() {
    let dir = tmp("projects");
    let projects = Projects::new(dir.join(".anoncode"));
    assert!(projects.list().unwrap().is_empty());
    let (a, _) = projects.create_from("  First  ", vault()).unwrap();
    let (b, _) = projects.create_from("", vault()).unwrap();
    assert_eq!(a.name, "First");
    assert_eq!(b.name, "Untitled");
    assert_eq!(projects.list().unwrap().len(), 2);
    assert_eq!(projects.rename(&a.id, "Renamed").unwrap().name, "Renamed");
    assert!(projects.paths(&a.id).unwrap().vault_file.is_file());
    assert!(projects.paths("../x").is_err());
    projects.delete(&a.id).unwrap();
    assert!(!projects.paths(&a.id).unwrap().dir.exists());
    assert_eq!(projects.list().unwrap(), [b]);
    assert!(anoncode::projects::now_iso().starts_with("20"));
}

fn span(id: &str, kind: &str, text: &str, is_error: bool, tokens: u64) -> Span {
    Span { id: id.into(), kind: kind.into(), text: text.into(), is_error, tokens: Some(tokens) }
}

#[test]
fn focus_keeps_everything_under_budget() {
    let req = Request { spans: vec![span("a", "user_goal", "fix the parser", false, 10)], ..Default::default() };
    let r = focus::compress(&req);
    assert!(!r.triggered);
    assert_eq!(r.kept, ["a"]);
}

#[test]
fn focus_protects_instructions_errors_and_recent_spans() {
    let mut spans = vec![span("goal", "user_goal", "fix the tokenizer bug in the parser", false, 50)];
    for i in 0..10 {
        spans.push(span(&format!("noise{i}"), "assistant", "listed some unrelated directory contents", false, 2000));
    }
    spans.insert(3, span("err", "assistant", "compile failed: unexpected thing", true, 500));
    spans.insert(5, span("note", "user", "also keep the old api", false, 30));
    spans.push(span("last", "assistant", "about to run the build", false, 100));
    let req = Request {
        spans,
        task: "fix the tokenizer bug in the parser".into(),
        // A draft model that cites nothing: only the defensive pass keeps spans.
        cited: Some(vec![vec![], vec![], vec![]]),
        ..Default::default()
    };
    let r = focus::compress(&req);
    assert!(r.triggered);
    for id in ["goal", "err", "note", "last"] {
        assert!(r.kept.iter().any(|k| k == id), "{id} was dropped");
    }
    assert!(r.dropped_count >= 7);
    assert!(r.kept_tokens < r.total_tokens);
    // Order is preserved.
    let pos = |id: &str| r.kept.iter().position(|k| k == id).unwrap();
    assert!(pos("goal") < pos("err") && pos("err") < pos("note") && pos("note") < pos("last"));
}

#[test]
fn focus_scores_by_citation_frequency_and_honours_rescue_and_cap() {
    let spans: Vec<Span> = (0..8).map(|i| span(&format!("s{i}"), "assistant", "work", false, 2000)).collect();
    let cited = vec![vec!["s0".to_string(), "s1".into()], vec!["s0".into()], vec!["s0".into(), "s2".into()]];
    let mut req = Request { spans, cited: Some(cited), rescued: vec!["s3".into()], ..Default::default() };
    req.options.keep_recent = 1;
    let r = focus::compress(&req);
    // s0 3/3, s1 and s2 1/3 (>= 0.3), s3 rescued, s7 recent.
    assert_eq!(r.kept, ["s0", "s1", "s2", "s3", "s7"]);
    assert!((r.decisions[0].score - 1.0).abs() < 1e-9);

    req.options.hard_cap_tokens = Some(6000);
    let r = focus::compress(&req);
    // The cap drops the lowest-scoring unprotected spans (s1, s2), never the
    // rescued or recent ones.
    assert_eq!(r.kept, ["s0", "s3", "s7"]);
}

#[test]
fn focus_hard_cap_drops_old_loop_messages_then_old_instructions() {
    let mut spans = vec![span("goal", "user_goal", "build the parser", false, 100)];
    for i in 0..6 {
        spans.push(span(&format!("loop{i}"), "loop", "Reviewer, round N: keep going", false, 500));
        spans.push(span(&format!("work{i}"), "assistant", "edited files", false, 500));
    }
    spans.insert(2, span("old", "user", "an earlier aside", false, 400));
    spans.push(span("latest", "user", "now add tests", false, 50));
    spans.push(span("recent", "assistant", "running tests", false, 200));
    let mut req = Request { spans, cited: Some(vec![vec![]]), ..Default::default() };
    req.options.keep_recent = 2;
    req.options.memory_budget_tokens = 1000;
    req.options.hard_cap_tokens = Some(1000);
    let r = focus::compress(&req);
    assert!(r.kept_tokens <= 1000, "kept {} tokens", r.kept_tokens);
    for id in ["goal", "latest", "recent"] {
        assert!(r.kept.iter().any(|k| k == id), "{id} was dropped");
    }
    // Loop messages go before the older instruction does.
    let gone = |id: &str| !r.kept.iter().any(|k| k == id);
    assert!(gone("loop0") && gone("loop5"));

    // With room for it, the older instruction stays while loop messages go.
    req.options.hard_cap_tokens = Some(800);
    req.options.memory_budget_tokens = 800;
    req.spans.retain(|s| !s.id.starts_with("work"));
    let r = focus::compress(&req);
    assert!(r.kept.iter().any(|k| k == "old"));
    assert!(!r.kept.iter().any(|k| k.starts_with("loop")));
}

#[test]
fn focus_heuristic_prefers_spans_about_the_task() {
    let mut spans: Vec<Span> = (0..12).map(|i| span(&format!("n{i}"), "assistant", "weather small talk", false, 1500)).collect();
    spans[1] = span("hit", "assistant", "the tokenizer splits identifiers wrongly", false, 1500);
    let req = Request { spans, task: "repair tokenizer".into(), ..Default::default() };
    let r = focus::compress(&req);
    assert!(r.triggered);
    assert!(r.kept.iter().any(|k| k == "hit"));
    assert!(r.dropped_count > 0);
}

#[test]
fn one_login_holds_the_shared_settings() {
    use anoncode::supervisor::{Config, Manager, Provider, Settings};
    let dir = tmp("login");
    let cfg = || Config { root: dir.clone(), base: dir.join(".anoncode"), server_command: Vec::new() };

    let mut m = Manager::new(cfg()).unwrap();
    assert!(!m.has_login());
    assert!(m.settings().is_err(), "nothing is readable before a login");
    m.setup("one passphrase").unwrap();
    assert!(m.setup("another").is_err(), "the passphrase is set only once");
    let settings = Settings { providers: vec![Provider { id: "venice".into(), key: "sk-test-123".into() }], model: Some(("venice".into(), "m".into())), web_fetch: anoncode::supervisor::Access::Ask, focus_share: 40, ..Settings::default() };
    assert!(Settings::default().sandbox, "the sandbox is on unless turned off");
    assert_eq!(Settings::default().web_fetch, anoncode::supervisor::Access::Off);
    m.save_settings(&settings).unwrap();
    m.logout();
    assert!(m.settings().is_err());

    // The key is not readable on disk.
    let sealed = fs::read(dir.join(".anoncode/app/settings/settings.enc")).unwrap();
    assert!(!sealed.windows(11).any(|w| w == b"sk-test-123"));

    let mut m = Manager::new(cfg()).unwrap();
    assert!(m.has_login());
    assert!(matches!(m.login("wrong"), Err(Error::WrongPassphrase)));
    assert!(!m.logged_in());
    m.login("one passphrase").unwrap();
    assert_eq!(m.settings().unwrap(), settings);
}

#[test]
fn a_record_copied_over_another_does_not_open() {
    let dir = tmp("swap");
    let s = Store::new(Arc::new(vault()), &dir).unwrap();
    s.put("project", "a", b"file a").unwrap();
    s.put("project", "b", b"file b").unwrap();
    fs::copy(dir.join("project/a.enc"), dir.join("project/b.enc")).unwrap();
    assert!(matches!(s.get("project", "b"), Err(Error::Damaged)));
    assert_eq!(&s.get("project", "a").unwrap().unwrap()[..], b"file a");
}

#[test]
fn an_older_copy_of_a_file_put_back_is_caught() {
    let dir = tmp("rollback");
    let store = Store::new(Arc::new(vault()), dir.join("sealed")).unwrap();
    let mut efs = Efs::open(store.clone(), "project").unwrap();
    efs.write("notes.txt", b"version 1", 1, false).unwrap();
    efs.flush().unwrap();
    let blob = fs::read_dir(dir.join("sealed/project")).unwrap().map(|e| e.unwrap().path()).find(|p| !p.ends_with("manifest.enc")).unwrap();
    let old = fs::read(&blob).unwrap();
    efs.write("notes.txt", b"version 2", 2, false).unwrap();
    efs.flush().unwrap();
    fs::write(&blob, old).unwrap();
    let efs = Efs::open(store, "project").unwrap();
    assert!(matches!(efs.read("notes.txt"), Err(Error::Damaged)));
}

#[test]
fn the_project_list_is_sealed_after_login() {
    use anoncode::supervisor::{Config, Manager};
    let dir = tmp("sealedlist");
    let base = dir.join(".anoncode");
    // A plaintext list from before there was a login.
    let projects = Projects::new(&base);
    projects.create_from("Secret plans", vault()).unwrap();
    assert!(base.join("projects/index.json").is_file());

    let mut m = Manager::new(Config { root: dir.clone(), base: base.clone(), server_command: Vec::new() }).unwrap();
    m.setup("one passphrase").unwrap();
    assert!(!base.join("projects/index.json").exists(), "the plaintext list is gone");
    let names: Vec<String> = m.list().unwrap().into_iter().map(|p| p.name).collect();
    assert_eq!(names, ["Secret plans"]);
    let mut found = false;
    for e in walk(&base) {
        found |= fs::read(&e).unwrap().windows(12).any(|w| w == b"Secret plans");
    }
    assert!(!found, "no file holds the name in the clear");
    m.logout();
    assert!(m.list().unwrap().is_empty(), "nothing is listed without the login");
}

fn walk(dir: &std::path::Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for e in fs::read_dir(dir).unwrap().flatten() {
        let p = e.path();
        if p.is_dir() { out.extend(walk(&p)) } else { out.push(p) }
    }
    out
}

#[test]
fn tool_calls_written_as_text_are_left_out() {
    use anoncode::tidy::tidy;
    let raw = "Now the files. <｜DSML｜ calls> <｜DSML｜ invoke name=\"write\"> <｜DSML｜ parameter name=\"path\" string=\"true\">a.py</｜DSML｜ parameter></｜DSML｜ invoke></｜DSML｜ calls> Done.";
    assert_eq!(tidy(raw), "Now the files. Done.");
    assert_eq!(tidy("Running it. <｜DSML｜ calls> <｜DSML｜ invoke name=\"shell\"> cd /work && py"), "Running it.");
    assert_eq!(tidy("ok<｜end▁of▁sentence｜>"), "ok");
    assert_eq!(tidy("a <tag> and | bars"), "a <tag> and | bars");
    assert_eq!(tidy("x <｜tool▁calls▁begin｜><｜tool▁call▁begin｜>f<｜tool▁sep｜>{}<｜tool▁call▁end｜><｜tool▁calls▁end｜> y"), "x y");
}
