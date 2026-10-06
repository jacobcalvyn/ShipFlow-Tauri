import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DEFAULT_DOCKER_CONFIG, type DockerDeploymentStatus } from '../../../backend/docker-contract';
import { installTestBridge } from '../../../test/bridge';
import { DockerServiceSettings } from './DockerServiceSettings';

const invoke = vi.fn();
let status: DockerDeploymentStatus;
beforeEach(() => {
  status = { supported: true, dockerReady: true, bundleReady: true, phase: 'stopped', busy: false, error: null,
    installedRelease: 'release-a', runningRelease: null, synchronized: false, apiReady: false,
    storageHealthy: false, configPending: true, config: structuredClone(DEFAULT_DOCKER_CONFIG), externalTokenConfigured: false,
    endpoint: null, metrics: null, activeRequests: null, queuedRequests: null };
  invoke.mockReset();
  installTestBridge({ invoke });
  invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === 'docker_service_status') return structuredClone(status);
    if (command === 'docker_service_save') { status.config = args!.config as typeof status.config; return; }
    if (command === 'docker_service_action') return;
    throw new Error(`Unexpected command: ${command}`);
  });
});
it('saves the edited configuration before explicitly applying a deployment', async () => {
  render(<DockerServiceSettings />);
  const deploy = await screen.findByRole('button', { name: 'Deploy / Redeploy' });
  fireEvent.change(screen.getByLabelText('Port host'), { target: { value: '19424' } });
  expect(deploy).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Simpan konfigurasi Docker' }));
  await waitFor(() => expect(deploy).toBeEnabled());
  expect(invoke.mock.calls.some(([command]) => command === 'docker_service_action')).toBe(false);
  fireEvent.click(deploy);
  fireEvent.click(screen.getByRole('button', { name: 'Terapkan deploy' }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('docker_service_action', { action: 'deploy' }));
  expect(status.config.port).toBe(19424);
});
it('shows a deployment error without claiming success', async () => {
  invoke.mockImplementation(async command => {
    if (command === 'docker_service_status') return status;
    throw new Error('Docker image architecture mismatch.');
  });
  render(<DockerServiceSettings />);
  fireEvent.click(await screen.findByRole('button', { name: 'Deploy / Redeploy' }));
  fireEvent.click(screen.getByRole('button', { name: 'Terapkan deploy' }));
  expect(await screen.findByText('Docker image architecture mismatch.')).toBeInTheDocument();
  expect(screen.queryByText('Deployment selesai dan API terverifikasi.')).not.toBeInTheDocument();
});
it('requires recovery before changes after an interrupted deployment', async () => {
  status.phase = 'interrupted';
  render(<DockerServiceSettings />);
  expect(await screen.findByRole('button', { name: 'Deploy / Redeploy' })).toBeDisabled();
  expect(screen.getByLabelText('Port host')).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Pulihkan deployment' }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('docker_service_action', { action: 'recover' }));
});
it('explains platform support without reporting unchecked container health or unusable controls', async () => {
  status.supported = false; status.dockerReady = true; status.phase = 'unsupported';
  render(<DockerServiceSettings />);
  expect(await screen.findByText('Tersedia di Windows')).toBeInTheDocument();
  expect(screen.getByText('Terhubung')).toBeInTheDocument();
  expect(screen.getByText(/container dan penyimpanannya tidak diperiksa/)).toBeInTheDocument();
  for (const label of ['Belum berjalan', 'Belum sinkron', 'Belum terverifikasi']) {
    expect(screen.queryByText(label)).not.toBeInTheDocument();
  }
  for (const name of ['Deploy / Redeploy', 'Start', 'Stop', 'Restart', 'Lihat log', 'Salin token Docker']) {
    expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
  }
  expect(screen.queryByLabelText('Port host')).not.toBeInTheDocument();
  expect(invoke.mock.calls.every(([command]) => command === 'docker_service_status')).toBe(true);
});
it('keeps advanced configuration collapsed and preserves it when basic settings are saved', async () => {
  status.config.memoryMiB = 2048;
  status.config.cpus = 4;
  status.config.performance.lookupConcurrency = 40;
  const expected = structuredClone(status.config);
  render(<DockerServiceSettings />);
  const summary = await screen.findByText('Pengaturan lanjutan');
  const advanced = summary.closest('details')!;
  expect(advanced).not.toHaveAttribute('open');
  expect(advanced).toContainElement(screen.getByLabelText('Memori container (MiB)'));
  expect(advanced).toContainElement(screen.getByLabelText('Batas CPU'));
  expect(advanced).toContainElement(screen.getByLabelText('Sumber lacak Docker'));
  expect(advanced).toContainElement(screen.getByLabelText('Lookup paralel total'));
  fireEvent.change(screen.getByLabelText('Port host'), { target: { value: '19424' } });
  fireEvent.click(screen.getByRole('button', { name: 'Simpan konfigurasi Docker' }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('docker_service_save', { config: { ...expected, port: 19424 } }));
});
