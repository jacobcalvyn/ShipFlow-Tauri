use std::{env, fs, path::PathBuf};

fn main() {
    let root = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap()).join("../..");
    let manifest = root.join("build/release.json");
    println!("cargo:rerun-if-changed={}", manifest.display());
    let identity: serde_json::Value = fs::read(&manifest)
        .ok()
        .map(|bytes| serde_json::from_slice(&bytes).expect("invalid build/release.json"))
        .unwrap_or_else(|| {
            serde_json::json!({
                "version": env!("CARGO_PKG_VERSION"), "commit": "development",
                "sourceHash": "development", "releaseId": "development"
            })
        });
    for (field, name) in [
        ("version", "VERSION"),
        ("commit", "COMMIT"),
        ("sourceHash", "SOURCE_HASH"),
        ("releaseId", "RELEASE_ID"),
    ] {
        let value = identity[field]
            .as_str()
            .expect("release identity field is missing");
        assert!(!value.contains(['\r', '\n']), "invalid release identity");
        println!("cargo:rustc-env=SHIPFLOW_BUILD_{name}={value}");
    }
}
