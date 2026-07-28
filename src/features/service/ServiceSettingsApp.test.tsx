import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ServiceConfig } from "../../types";
import { installTestBridge } from "../../test/bridge";
import { ServiceSettingsApp } from "./ServiceSettingsApp";

const invokeMock = vi.fn<
  (command: string, args?: Record<string, unknown>) => Promise<unknown>
>();

const defaultServiceConfig: ServiceConfig = {
  version: 1,
  enabled: true,
  mode: "local",
  port: 18422,
  authToken: "",
  trackingSource: "default",
  externalApiBaseUrl: "",
  externalApiAuthToken: "",
  allowInsecureExternalApiHttp: false,
  keepRunningInTray: true,
  startAtLogin: false,
  lastUpdatedAt: "",
};

describe("ServiceSettingsApp", () => {
  let persistedServiceConfig: ServiceConfig | null;

  beforeEach(() => {
    persistedServiceConfig = null;
    invokeMock.mockReset();
    installTestBridge({ invoke: invokeMock });
    invokeMock.mockImplementation(async (command, args) => {
      if (command === "load_saved_api_service_config") {
        return persistedServiceConfig;
      }

      if (command === "get_api_service_status") {
        return {
          status: "running",
          enabled: true,
          mode: persistedServiceConfig?.mode ?? "local",
          bindAddress:
            persistedServiceConfig?.mode === "lan" ? "0.0.0.0" : "127.0.0.1",
          port: persistedServiceConfig?.port ?? 18422,
          errorMessage: null,
        };
      }

      if (command === "configure_api_service") {
        persistedServiceConfig = args?.config as ServiceConfig;
        return {
          status: "running",
          enabled: true,
          mode: persistedServiceConfig.mode,
          bindAddress:
            persistedServiceConfig.mode === "lan" ? "0.0.0.0" : "127.0.0.1",
          port: persistedServiceConfig.port,
          errorMessage: null,
        };
      }

      if (command === "validate_tracking_source_config") {
        return undefined;
      }

      if (command === "test_external_tracking_source") {
        return "Koneksi berhasil. Akses API aktif via lan (0.0.0.0:18422).";
      }

      if (command === "close_current_window") {
        return undefined;
      }

      throw new Error(`Unexpected command: ${command}`);
    });
  });

  function callsFor(command: string) {
    return invokeMock.mock.calls.filter(([candidate]) => candidate === command);
  }

  it("renders Service settings in a dedicated surface without workspace connection fields", async () => {
    render(<ServiceSettingsApp />);

    expect(
      screen.getByRole("region", { name: "Pengaturan ShipFlow Service" }),
    ).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Sumber Lacak" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Internal ShipFlow" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "API ShipFlow Eksternal" })).toBeInTheDocument();
    expect(screen.queryByLabelText("URL Service ShipFlow")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("ShipFlow Service Bearer Token")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "API Publik" }));

    expect(await screen.findByLabelText("Port")).toHaveValue(18422);
    expect(screen.getByText("Localhost aktif untuk Desktop")).toBeInTheDocument();
    expect(
      (screen.getByLabelText("Token API Service") as HTMLInputElement).value,
    ).toMatch(/^sf_[a-f0-9]+$/);
    expect(callsFor("load_saved_api_service_config")).toHaveLength(1);
  });

  it("restores an external tracking source without inventing a persisted token", async () => {
    persistedServiceConfig = {
      ...defaultServiceConfig,
      trackingSource: "externalApi",
      externalApiBaseUrl: "https://scrappid3.jacobcalvyn.io",
      startAtLogin: true,
      lastUpdatedAt: "2026-04-18T00:00:00.000Z",
    };

    render(<ServiceSettingsApp />);

    expect(
      await screen.findByRole("radio", { name: "API ShipFlow Eksternal" }),
    ).toBeChecked();
    expect(screen.getByLabelText("URL Dasar API Eksternal")).toHaveValue(
      "https://scrappid3.jacobcalvyn.io",
    );
    expect(screen.getByLabelText("Token API Eksternal")).toHaveValue("");
  });

  it("keeps changes local until save and persists the explicit lifecycle choices", async () => {
    render(<ServiceSettingsApp />);
    fireEvent.click(screen.getByRole("tab", { name: "API Publik" }));

    const port = await screen.findByLabelText("Port");
    fireEvent.change(port, { target: { value: "19422" } });
    fireEvent.click(screen.getByLabelText("LAN / Jaringan Lokal"));
    fireEvent.click(screen.getByLabelText("Jalankan ShipFlow Service saat login"));
    fireEvent.click(
      screen.getByLabelText(
        "Biarkan ShipFlow Service tetap aktif di menu bar / system tray",
      ),
    );

    expect(callsFor("configure_api_service")).toHaveLength(0);
    expect(port).toHaveValue(19422);

    fireEvent.click(screen.getByRole("button", { name: "Simpan" }));

    await waitFor(() => {
      expect(callsFor("configure_api_service")).toHaveLength(1);
      expect(persistedServiceConfig).toMatchObject({
        enabled: true,
        mode: "lan",
        port: 19422,
        keepRunningInTray: false,
        startAtLogin: true,
      });
      expect(persistedServiceConfig?.authToken).toMatch(/^sf_[a-f0-9]+$/);
      expect(persistedServiceConfig?.lastUpdatedAt).toBeTruthy();
      expect(callsFor("close_current_window")).toHaveLength(1);
    });
  });

  it("cancels unsaved settings and closes only the Service settings window", async () => {
    render(<ServiceSettingsApp />);
    fireEvent.click(screen.getByRole("tab", { name: "API Publik" }));
    fireEvent.change(await screen.findByLabelText("Port"), {
      target: { value: "19422" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Batal" }));

    expect(callsFor("configure_api_service")).toHaveLength(0);
    expect(callsFor("close_current_window")).toHaveLength(1);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(callsFor("close_current_window")).toHaveLength(2);
  });

  it("tests an external tracking source from the isolated Service renderer", async () => {
    render(<ServiceSettingsApp />);
    const externalSource = await screen.findByRole("radio", {
      name: "API ShipFlow Eksternal",
    });
    fireEvent.click(externalSource);
    fireEvent.change(screen.getByLabelText("URL Dasar API Eksternal"), {
      target: { value: "https://scrappid3.jacobcalvyn.io" },
    });
    fireEvent.change(screen.getByLabelText("Token API Eksternal"), {
      target: {
        value: "sf_32c18e59ecca4f91e23070d33c74a230a0ccc73161b6ae79",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Tes Koneksi" }));

    await waitFor(() => {
      expect(callsFor("test_external_tracking_source")).toHaveLength(1);
      expect(
        screen.getByText("Koneksi berhasil. Akses API aktif via lan (0.0.0.0:18422)."),
      ).toBeInTheDocument();
    });
  });
});
