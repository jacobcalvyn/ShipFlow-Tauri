import { useCallback, useEffect, useRef, useState } from 'react';
import { copyDockerServiceToken, getDockerServiceLogs, getDockerServiceStatus, runDockerServiceAction, saveDockerServiceConfig } from '../../../backend/commands';
import { validateDockerConfig, type DockerAction, type DockerDeploymentStatus, type DockerPerformance, type DockerServiceConfig } from '../../../backend/docker-contract';

const fields: [keyof DockerPerformance, string][] = [
  ['httpConcurrency', 'Request HTTP aktif'], ['httpQueue', 'Antrean HTTP'], ['lookupConcurrency', 'Lookup paralel total'],
  ['publicConcurrency', 'Lookup paralel API'], ['lookupQueue', 'Antrean lookup'], ['contactConcurrency', 'Lookup kontak paralel'],
  ['trackTtlSeconds', 'TTL kiriman (detik)'], ['bagTtlSeconds', 'TTL bag (detik)'], ['manifestTtlSeconds', 'TTL manifest (detik)'],
  ['cacheEntries', 'Kapasitas cache RAM (entri)'], ['cacheMiB', 'Batas cache RAM (MiB)'], ['persistentEntries', 'Kapasitas cache disk (entri)'],
];
const phaseLabels: Record<string, string> = {
  unsupported: 'Tersedia di Windows',
  idle: 'Siap', stopped: 'Berhenti', running: 'Berjalan', unhealthy: 'API belum sehat', interrupted: 'Deployment terputus',
  preflight: 'Memeriksa Docker', 'loading-image': 'Memuat image', draining: 'Menyelesaikan request aktif',
  'backing-up': 'Mencadangkan cache', creating: 'Membuat container', verifying: 'Memeriksa API dan penyimpanan',
  recovering: 'Memulihkan deployment', stopping: 'Menghentikan service', starting: 'Menjalankan service',
};
export function DockerServiceSettings() {
  const [status, setStatus] = useState<DockerDeploymentStatus | null>(null);
  const [draft, setDraft] = useState<DockerServiceConfig | null>(null);
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [logs, setLogs] = useState<string | null>(null);
  const [armed, setArmed] = useState<DockerAction | null>(null);
  const alive = useRef(true);
  const polling = useRef(false);
  const refresh = useCallback(async () => {
    if (polling.current) return;
    polling.current = true;
    try { const next = await getDockerServiceStatus(); if (alive.current) { setStatus(next); setDraft(previous => previous ?? next.config); } }
    catch (caught) { if (alive.current) setError(caught instanceof Error ? caught.message : 'Gagal membaca status Docker.'); }
    finally { polling.current = false; }
  }, []);
  useEffect(() => { alive.current = true; void refresh(); const timer = setInterval(() => void refresh(), 5000); return () => { alive.current = false; clearInterval(timer); }; }, [refresh]);
  const invoke = async (work: () => Promise<unknown>, success: string) => {
    setBusy(true); setError(null); setNotice('');
    try { await work(); if (alive.current) setNotice(success); }
    catch (caught) { if (alive.current) setError(caught instanceof Error ? caught.message : 'Operasi Docker gagal.'); }
    finally { if (alive.current) { setBusy(false); setArmed(null); await refresh(); } }
  };
  if (!status || !draft) return <div role="status">{error || 'Memeriksa ShipFlow Docker...'}</div>;
  const dirty = JSON.stringify(draft) !== JSON.stringify(status.config) || token.length > 0;
  const disabled = busy || status.busy;
  const set = <K extends keyof DockerServiceConfig>(key: K, value: DockerServiceConfig[K]) => { setDraft({ ...draft, [key]: value }); setArmed(null); };
  const act = (action: DockerAction) => void invoke(() => runDockerServiceAction(action), action === 'deploy' ? 'Deployment selesai dan API terverifikasi.' : 'Operasi Docker selesai.');
  return <section role="tabpanel" id="service-settings-docker-panel" aria-labelledby="service-settings-docker-tab" className="settings-pane service-settings-pane">
    <div className="service-settings-section-header"><h2>Docker API</h2><p>{status.supported ? 'Kelola API di Docker lokal. Container tetap berjalan saat aplikasi ditutup.' : 'Deploy dari ShipFlow saat ini tersedia untuk Windows. Pada platform ini, ShipFlow hanya memeriksa koneksi Docker; container dan penyimpanannya tidak diperiksa.'}</p></div>
    {error && <p role="alert" className="settings-field-help-warning">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    <dl className="docker-status-grid">
      <dt>Docker</dt><dd>{status.dockerReady ? 'Terhubung' : 'Belum tersedia'}</dd>
      <dt>Deployment</dt><dd aria-live="polite">{phaseLabels[status.phase] || status.phase}</dd>
      {status.supported && <>
      <dt>Versi aplikasi</dt><dd>{status.installedRelease}</dd>
      <dt>Versi container</dt><dd>{status.runningRelease || 'Belum berjalan'}</dd>
      <dt>Sinkronisasi</dt><dd>{status.synchronized ? 'Sinkron dan API siap' : 'Belum sinkron'}</dd>
      <dt>Penyimpanan</dt><dd>{status.storageHealthy ? 'Volume sehat' : 'Belum terverifikasi'}</dd>
      {status.endpoint && <><dt>Endpoint lokal</dt><dd>{status.endpoint}</dd></>}
      {status.metrics && <><dt>Cache</dt><dd>{status.metrics.hits} hit · {status.metrics.misses} miss · {status.metrics.coalesced} digabung</dd></>}
      {status.activeRequests !== null && <><dt>Request</dt><dd>{status.activeRequests} aktif · {status.queuedRequests ?? 0} antre</dd></>}
      </>}
    </dl>
    {status.error && <p role="alert">{status.error}</p>}
    {!status.supported && <details><summary>Detail versi aplikasi</summary><p className="docker-release-id">{status.installedRelease}</p></details>}
    {status.supported && <>
    {!status.bundleReady && <p>Paket Docker belum tersedia dalam instalasi ini.</p>}
    <fieldset disabled={disabled || status.phase === 'interrupted'} className="docker-config-fields">
      <legend>Konfigurasi Docker</legend>
      <p className="settings-field-help settings-field-help-info">Pengaturan bawaan siap digunakan. Ubah port atau akses API bila diperlukan.</p>
      <label>Port host<input type="number" min="1024" max="65535" value={draft.port} onChange={e => set('port', Number(e.target.value))} /></label>
      <label>Akses API<select value={draft.bindAddress} onChange={e => set('bindAddress', e.target.value as DockerServiceConfig['bindAddress'])}><option value="127.0.0.1">Komputer ini / tunnel lokal</option><option value="0.0.0.0">Jaringan lokal</option></select></label>
      <details><summary>Pengaturan lanjutan</summary><div className="docker-config-fields">
      <label>Memori container (MiB)<input type="number" value={draft.memoryMiB} onChange={e => set('memoryMiB', Number(e.target.value))} /></label>
      <label>Batas CPU<input type="number" step="0.5" value={draft.cpus} onChange={e => set('cpus', Number(e.target.value))} /></label>
      <label>Sumber lacak Docker<select value={draft.trackingSource} onChange={e => set('trackingSource', e.target.value as DockerServiceConfig['trackingSource'])}><option value="default">Internal ShipFlow</option><option value="externalApi">API eksternal</option></select></label>
      {draft.trackingSource === 'externalApi' && <>
        <label>URL API eksternal Docker<input value={draft.externalApiBaseUrl} onChange={e => set('externalApiBaseUrl', e.target.value)} /></label>
        <label>Token API eksternal Docker<input type="password" autoComplete="off" value={token} placeholder={status.externalTokenConfigured ? 'Token tersimpan; kosongkan untuk mempertahankan' : 'Masukkan token'} onChange={e => setToken(e.target.value)} /></label>
        <label><input type="checkbox" checked={draft.allowInsecureExternalApiHttp} onChange={e => set('allowInsecureExternalApiHttp', e.target.checked)} />Izinkan HTTP / jaringan privat tepercaya</label>
      </>}
      <details><summary>Performa dan cache</summary><div className="docker-config-fields">{fields.map(([key, label]) => <label key={key}>{label}<input type="number" min="1" value={draft.performance[key]} onChange={e => set('performance', { ...draft.performance, [key]: Number(e.target.value) })} /></label>)}</div></details>
      </div></details>
      <button type="button" disabled={!dirty} onClick={() => void invoke(async () => { const config = validateDockerConfig(draft); await saveDockerServiceConfig(config, token || undefined); setToken(''); }, 'Konfigurasi tersimpan. Pilih Deploy / Redeploy untuk menerapkan.')}>Simpan konfigurasi Docker</button>
    </fieldset>
    <div className="settings-inline-actions docker-actions">
      <button type="button" disabled={disabled || !status.supported || !status.dockerReady || !status.bundleReady || dirty || status.phase === 'interrupted'} onClick={() => setArmed('deploy')}>Deploy / Redeploy</button>
      <button type="button" disabled={disabled || !status.supported || !status.dockerReady || status.phase === 'interrupted'} onClick={() => act('start')}>Start</button>
      <button type="button" disabled={disabled || !status.supported || !status.runningRelease || status.phase === 'interrupted'} onClick={() => setArmed('stop')}>Stop</button>
      <button type="button" disabled={disabled || !status.supported || !status.runningRelease || status.phase === 'interrupted'} onClick={() => setArmed('restart')}>Restart</button>
      {status.phase === 'interrupted' && <button type="button" disabled={disabled || !status.supported || !status.dockerReady} onClick={() => act('recover')}>Pulihkan deployment</button>}
      <button type="button" disabled={disabled || !status.supported || !status.apiReady} onClick={() => void invoke(() => copyDockerServiceToken(), '')}>Salin token Docker</button>
      <button type="button" disabled={disabled || !status.supported || !status.dockerReady} onClick={() => void invoke(async () => setLogs(await getDockerServiceLogs()), '')}>Lihat log</button>
    </div>
    {armed && <div role="alert" className="settings-field-help-warning"><p>{armed === 'deploy' ? 'Redeploy mengganti container dan menghentikan API sementara. Data volume tetap dipertahankan.' : 'Operasi ini menghentikan API dan dapat memutus request yang sedang berjalan.'}</p><button type="button" disabled={disabled} onClick={() => act(armed)}>Terapkan {armed}</button><button type="button" onClick={() => setArmed(null)}>Batal</button></div>}
    {logs !== null && <pre className="docker-log-output" aria-label="Log Docker">{logs || 'Belum ada log.'}</pre>}
    </>}
  </section>;
}
