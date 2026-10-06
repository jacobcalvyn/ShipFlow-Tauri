use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildIdentity {
    pub version: &'static str,
    pub commit: &'static str,
    pub source_hash: &'static str,
    pub release_id: &'static str,
    pub api_version: &'static str,
    pub storage_version: u32,
    pub os: &'static str,
    pub arch: &'static str,
}

pub fn build_identity() -> BuildIdentity {
    BuildIdentity {
        version: env!("SHIPFLOW_BUILD_VERSION"),
        commit: env!("SHIPFLOW_BUILD_COMMIT"),
        source_hash: env!("SHIPFLOW_BUILD_SOURCE_HASH"),
        release_id: env!("SHIPFLOW_BUILD_RELEASE_ID"),
        api_version: "v1",
        storage_version: 1,
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
    }
}
