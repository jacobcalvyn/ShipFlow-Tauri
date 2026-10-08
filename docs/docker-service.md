# Managed Docker API service

ShipFlow Service Settings includes a **Docker API** tab for Windows Docker Desktop running Linux containers. The installed application controls one local API container independently of the native desktop service. Closing ShipFlow does not stop Docker. Docker Desktop must be running for deployment and API availability.

Docker engine detection is independent of deployment support. On macOS, the tab checks the local Linux engine and can show **Terhubung**, while **Tersedia di Windows** identifies the platform supported for deployment. Unsupported platforms show no configuration form or deployment controls, and do not report container health, version synchronization, or storage health because these checks have not run. The application build identity remains available under **Detail versi aplikasi**. Detection on unsupported platforms creates no deployment journal or credentials and performs no Docker mutations. This corrects an earlier platform gate that returned **Belum tersedia** without checking Docker at all.

## Platform support and status

| Display | Meaning |
| --- | --- |
| Docker — **Terhubung** | The local Linux Docker engine passed the connectivity/context checks. This does not imply ShipFlow deployment is enabled or an API container is running. |
| Deployment — **Tersedia di Windows** | This platform does not enable managed deployment. The limitation is in ShipFlow's platform support, not Docker engine availability. |
| **Versi aplikasi** / **Detail versi aplikasi** | Build identity used to compare the application and container: app version, shortened Git commit, and source hash. Sharing a folder or version number alone is insufficient. |
| **Versi container** | The release identity of the managed running container, when confirmed on a supported platform. **Belum berjalan** means no running release has been confirmed; inspect any accompanying error. |
| **Sinkron dan API siap** | The managed API passed readiness, its release and configuration match the application, and no deployment remains pending. |
| **Volume sehat** | The managed container passed the authenticated persistent-storage readiness check. **Belum terverifikasi** is not proof of data corruption. |

On unsupported platforms, container version, synchronization, and storage rows
are omitted because the controller does not inspect those resources. An engine
error is still displayed if connectivity checks fail. Packaged macOS builds do
not enable deployment; development switches described below are test-only.

## Operator workflow

1. Install a Windows build that includes its signed offline Docker bundle.
2. Open ShipFlow Service Settings → Docker API. Keep the default loopback binding when a tunnel or reverse proxy runs on this computer.
3. Keep the defaults or adjust the host port and API access. **Pengaturan lanjutan** holds optional CPU/memory, tracking source, concurrency, queue, and cache settings. Existing values are preserved when this section is collapsed. Save any configuration changes.
4. Select **Deploy / Redeploy** and confirm the temporary API interruption. The application automatically resolves assets from its installation directory.
5. Wait for **Sinkron dan API siap**. This requires authenticated readiness, matching release and configuration identities, and writable persistent storage. Copy the Docker API token using the dedicated button.

Configuration edits remain pending until deployment succeeds. Start and Restart reuse the deployed configuration. Stop leaves the data volume intact. If deployment was interrupted, use **Pulihkan deployment** before making further changes.

The default host endpoint is `http://127.0.0.1:18424`; the container listens on port 18422. LAN binding is explicit. Public HTTPS routing, firewall rules, tunnel credentials, and the online application's endpoint/token configuration remain operator-managed. This patch does not switch native desktop tracking to loopback: the existing external-API destination restrictions remain active.

### Basic and advanced configuration

| Location | Settings and defaults |
| --- | --- |
| Basic form | Host port `18424`; API access limited to this computer / a local tunnel (`127.0.0.1`). Select LAN access explicitly when required. |
| **Pengaturan lanjutan** | Container memory `1024` MiB, CPU limit `2`, and **Internal ShipFlow** tracking. Selecting an external API reveals its URL, token, and trusted HTTP/private-network option. |
| **Pengaturan lanjutan** → **Performa dan cache** | Concurrency, queue, TTL, and cache limits described below. |

Advanced settings are optional overrides, not mandatory setup steps. Collapsing
them does not reset defaults or saved custom values. Saving a changed port keeps
the other settings. Configuration validation and explicit deployment confirmation
still apply. Saving configuration alone never redeploys a container.

## Artifacts and release identity

`npm run release:prepare` creates `build/release.json` from the application version, Git commit, and normalized source hash. Native service builds, Electron, and the Linux image embed this identity. `releaseId`, commit, source hash, API contract version, storage version, image architecture, and image ID are checked during deployment.

`npm run docker:bundle` builds `linux/amd64` by default and produces:

- `build/docker/service-image.tar`
- `build/docker/manifest.json`, including the archive SHA-256 and expected immutable image ID
- `build/docker/manifest.sig`, an Ed25519 signature when signing keys are configured

Windows installers and updater artifacts copy these files to `resources/docker/`. Packaging checks source identity and archive integrity before creating the package. Deployment loads the installed archive, so the target computer needs no source checkout, Rust toolchain, registry login, or image download.

Configure these GitHub repository secrets before running **Build ShipFlow Windows** or **Build ShipFlow Updater Artifacts**:

| Secret | Content |
| --- | --- |
| `SHIPFLOW_BUNDLE_SIGNING_KEY` | Ed25519 private key in PEM format; keep it only in the release signing environment |
| `SHIPFLOW_BUNDLE_PUBLIC_KEY` | Matching public key in PEM format, embedded in the installed application |

Docker bundle signing is required for both Windows installer modes, independently of optional Windows Authenticode signing. Missing or mismatched keys fail the bundle job before building. Production applications reject unsigned bundles and never trust a public key supplied alongside an image archive. The Quality Gate uses unsigned test bundles; its test packages cannot perform managed deployment.

The reusable `build-docker-bundle.yml` workflow builds, verifies, smoke-tests, and uploads the exact bundle consumed by Windows installer and updater jobs. A real Windows Docker Desktop acceptance run is still necessary before release; GitHub's hosted Windows packaging runner does not establish that runtime coverage.

## Storage and recovery

| Resource | Purpose |
| --- | --- |
| `shipflow-service-api` | Current API container |
| `shipflow-service-api-data` | Persistent SQLite lookup, contact, bag-route, and manifest Print caches |
| `shipflow-service-api-backup` | Most recent consistent redeployment snapshot |
| AppData `docker-service/deployment.json` | Desired/active configuration and durable operation journal; credentials encrypted with Electron safeStorage |

The controller pins the local Docker engine ID and checks ownership labels before changing any container or volume. It uses the fixed `desktop-linux` context, argument arrays, bounded command execution, and a single active mutation. It refuses remote contexts, unexpected ownership, missing managed containers, and ambiguous resources. It does not mount the Docker socket or an installation directory into the service.

Redeploy verifies and loads the candidate image before stopping the active service. The old process receives up to 180 seconds to drain and flush. A nonzero exit prevents replacement. Once stopped, all cache files, including any WAL files, are snapshotted into the backup volume. The candidate must pass authenticated build/configuration/storage readiness before its deployment is committed. Failed candidates are removed and the previous snapshot/container is restored; an originally stopped service stays stopped after recovery. A retained previous container is removed at the next deployment, and the backup volume retains one snapshot.

If the app exits mid-deployment, the journal remains pending and the next session exposes recovery. Keep AppData together with the Docker volumes: deleting either breaks ownership/credential recovery. Automatic redeployment across different `storageVersion` values is blocked; a reviewed migration and rollback policy must be implemented before incrementing that version. There is no automatic migration from the native desktop cache and no promise of zero downtime.

Docker mode requires all three cache databases in `/data` and does not fall back to temporary storage or RAM. Readiness performs committed writes. Lookup writer failures propagate through flush and readiness rather than being acknowledged as successful persistence. Container configuration is copied as an owner-readable file for UID 10001; tokens are absent from command arguments and container environment values.

Manifest Print snapshots and their bag-route index share
`/data/bag-route-store.sqlite3`; they do not introduce a fourth database.
Restart and redeployment backups preserve these tables with the existing bag
label cache. The container's stores remain separate from the native Service
and Extension browser storage.

## Concurrency and cache

Defaults preserve the existing service profile: 128 HTTP handlers, a 512-entry ingress queue, 30 total upstream lookups, 24 public lookups, and 15 contact lookups. Identical lookups coalesce. Tracking/bag/manifest cache TTLs default to 30/60/90 seconds; memory lookup cache defaults to 10,000 entries/128 MiB and disk lookup cache to 2,000 entries. The UI's disk limit applies to the lookup cache; existing contact and bag-route retention policies remain separate.

Phone values retain a 90-day TTL; missing or partial acquisitions retry after
five minutes. Complete label routes have no normal age expiry. Print snapshots
refresh on lookup after 24 hours and are retained for 90 days, bounded to
1,000 records and 64 MiB of serialized payloads. These policies are not changed
by the operational manifest lookup TTL or the UI's disk lookup-entry limit.
See [Tracking Data Integration](./data-integration.md#cache-and-storage) for
the separate capacities, failed-refresh behavior, and force-refresh rules.

Increasing container resources alone does not increase application concurrency. Increase bounded service settings only after measuring latency, queue depth, cache hit rate, memory use, and upstream throttling under the intended workload. This patch does not establish new throughput guarantees or test live POS scraping.

## Verification

Run focused controller/UI tests with:

```sh
npx vitest run electron/main/docker-deployment-manager.test.ts src/features/service/components/DockerServiceSettings.test.tsx
cargo test -p shipflow-service-runtime -p shipflow-service
```

For a real isolated Docker smoke test, build a bundle for the local engine architecture (`SHIPFLOW_DOCKER_PLATFORM=linux/arm64` on Apple Silicon), install Node dependencies, then run `node scripts/docker/smoke.mjs`. This test creates random `shipflow-test-*` resources and deletes only those resources. It exercises authenticated readiness, actual cache files, restart persistence, successful redeploy, failed candidate rollback, application-side manager recreation, and graceful stop/start. It does not send tracking requests to a live provider.

Development UI testing on a non-Windows host requires `SHIPFLOW_DOCKER_DEVELOPMENT=1`; unsigned local bundles additionally require `SHIPFLOW_ALLOW_UNSIGNED_DOCKER_BUNDLE=1`. Packaged applications ignore these development switches.

To verify normal platform detection and the collapsed form with an isolated
Electron runtime after building the native binaries and renderer:

```sh
SHIPFLOW_EXPECT_DOCKER=1 npx playwright test tests/electron/suite-smoke.spec.ts \
  -g 'Electron suite owns|Docker configuration exposes'
```

The first scenario uses the real local engine. The second supplies a supported-
platform status fixture and forbids Docker mutations; it verifies form visibility
and expansion, not Windows deployment. The normal macOS detection scenario does
not require either development override.

Before production acceptance on Windows, test a signed installed build with network access disabled during deployment, paths containing spaces/non-ASCII characters, Docker restart, app quit, interrupted deployment recovery, a corrupt archive, busy host port, failed readiness, retained cache data, installer upgrade and updater replacement, and an unrelated container with the managed name. Confirm the online application can reach the authenticated API through the intended HTTPS route.

### Initial Docker validation — 2026-10-06

Validated in the working tree based on commit `8bb5c4cb87d29ce14ffe06de8307522d4bc181bf`, using macOS ARM64 and Docker Desktop's local Linux ARM64 engine. At this checkpoint, the application and offline bundle shared release identity `0.1.0-8bb5c4cb87d2-fadd8062bf9b`. The local archive was approximately 113 MiB and was an unsigned development artifact. These results predate the detection, window-lifecycle, and UI follow-ups below.

| Check | Result |
| --- | --- |
| `cargo test --workspace --all-targets` | 286 tests passed |
| Full frontend/Node unit suite | 432 passed; the opt-in Docker integration test was skipped in the default suite |
| Final Docker controller and UI regression rerun | 19 passed, including the subsequently added retained-log/redaction test |
| Electron suite smoke | 2 passed, including Docker tab navigation and native settings lifecycle |
| Final real Docker smoke | Passed deploy, authenticated readiness, writable cache files, marker persistence across restart/redeploy, failed-start rollback, manager recreation, and graceful stop/start; isolated test resources removed |
| Build/static checks | Native debug build, Electron build, TypeScript, workspace Clippy with warnings denied, Rust format, security baseline, workflow YAML parsing, and diff whitespace check passed |
| Runtime diagnostics tests | 8 passed |

The first real-container test exposed `cacheMiB`/`cacheMib` contract drift between TypeScript and Rust. A regression test failed before adding the explicit Serde field name and passed afterward; the final real-container run passed with that fix. Failed candidate logs are now retained with credentials redacted after cleanup.

Unverified release boundaries: actual Windows Docker Desktop operation, Windows installer/updater execution with production signing keys, offline installation on the target machine, live POS scraping throughput, and the online application's HTTPS/tunnel route. No production deployment, GitHub workflow dispatch, commit, or push was performed during this patch.

### Detection follow-up — 2026-10-06

The macOS status path previously returned before probing Docker because managed deployment was unsupported on that platform. Engine availability was separated from deployment support without credential creation or Docker mutation. At this checkpoint, unsupported-platform controls remained disabled and the label read **Deployment belum didukung**. Three regression cases failed before the correction; 21 focused controller/UI tests, TypeScript, and the Electron build passed. A real Electron smoke run with `SHIPFLOW_EXPECT_DOCKER=1` confirmed the local ARM64 Linux engine connection. The following UI patch supersedes that label and the disabled form.

### UI and lifecycle follow-up — 2026-10-06

The current UI uses **Tersedia di Windows**, hides unusable controls on unsupported
platforms, and omits unchecked container/synchronization/storage rows. Supported
platforms expose port and API access first, with the remaining settings collapsed
under **Pengaturan lanjutan**. Two UI regression cases failed before this change
and passed after it; custom advanced values survive basic configuration edits.

Service Settings also became a standalone, non-modal window. Previously its
native modal sheet could block the workspace's unsaved-document confirmation,
leaving Quit waiting for an inaccessible decision. The Electron regression
reproduced the visible blocking sheet before the fix, then verified cancellation,
retained drafts, settings-window close, and save-before-quit with native Service
shutdown. See [runtime-log-audit.md](./runtime-log-audit.md#unsaved-workspace-quit-with-service-settings-open)
for the reproduction procedure.

| Latest targeted check | Result and scope |
| --- | --- |
| Docker controller and UI tests | 22 passed after the UI simplification |
| Lifecycle and Service Settings unit tests | 12 passed for the non-modal window fix |
| Electron Docker detection | Passed against the real local Docker engine with deployment unsupported on macOS |
| Electron advanced configuration | Passed collapse/expand and external-source field checks using a status fixture; no Docker mutation |
| Electron quit regression | Passed cancel, settings close, save-and-quit, persisted document content, and native Service exit |
| Native debug and Electron builds | Passed; TypeScript checks included |
| Local app restart | Completed through normal Quit, with `native_shutdown_completed`, `app_exit`, and fresh `service_ready` evidence |

These are targeted checks from the follow-up work, not a rerun of the initial
full Rust suite or real-container deployment smoke. Windows Docker Desktop,
production signing, and public API routing acceptance remain unverified.

At this documentation update, `build/release.json` identifies the latest app as
`0.1.0-8bb5c4cb87d2-9708a5384dc4`, while the local Docker manifest still identifies
the earlier ARM64 development bundle as `0.1.0-8bb5c4cb87d2-fadd8062bf9b`.
They are not a matching deployment pair. Rebuild and sign the bundle for the
intended release/platform before packaging or deployment; changing a tag or
placing the old archive in the installation folder does not make it compatible.
