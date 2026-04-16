import { createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
import App from "./App";
import { TrackResponse } from "./types";

const { mockedInvoke } = vi.hoisted(() => ({
  mockedInvoke: vi.fn<
    (
      command: string,
      args?: {
        shipmentId?: string;
        sheetId?: string;
        rowKey?: string;
        imageSource?: string;
      }
    ) => Promise<TrackResponse | string>
  >(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockedInvoke,
}));

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

function createTrackingResponse(shipmentId: string): TrackResponse {
  return {
    url: `https://example.test/track/${shipmentId}`,
    detail: {
      shipment_header: {
        nomor_kiriman: shipmentId,
      },
      origin_detail: {},
      package_detail: {
        berat_actual: 0,
        berat_volumetric: 0,
      },
      billing_detail: {
        bea_dasar: 0,
        nilai_barang: 0,
        htnb: 0,
        cod_info: {
          is_cod: false,
          total_cod: 0,
        },
      },
      actors: {
        pengirim: {
          nama: "Sender",
        },
        penerima: {
          nama: "Receiver",
        },
      },
      performance_detail: {},
    },
    status_akhir: {
      status: "INVEHICLE",
    },
    pod: {},
    history: [],
    history_summary: {
      irregularity: [],
      bagging_unbagging: [],
      manifest_r7: [],
      delivery_runsheet: [],
    },
  };
}

describe("App workspace isolation", () => {
  const pendingRequests = new Map<string, Deferred<TrackResponse>>();
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  function resolveRequest(shipmentId: string) {
    const request = pendingRequests.get(shipmentId);
    if (!request) {
      throw new Error(`No pending request for ${shipmentId}`);
    }

    request.resolve(createTrackingResponse(shipmentId));
  }

  beforeEach(() => {
    pendingRequests.clear();
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockedInvoke.mockImplementation((command, args) => {
      if (command === "resolve_pod_image") {
        return Promise.resolve(typeof args?.imageSource === "string" ? args.imageSource : "");
      }

      if (command !== "track_shipment" || !args?.shipmentId) {
        throw new Error(`Unexpected invoke: ${command}`);
      }

      if (args.shipmentId === "PBAD") {
        return Promise.resolve({} as TrackResponse);
      }

      const deferred = createDeferred<TrackResponse>();
      pendingRequests.set(args.shipmentId, deferred);
      return deferred.promise;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function expectInfoTelemetry(event: string, shipmentId: string) {
    expect(findTelemetryPayload(infoSpy, event, shipmentId)).toBeTruthy();
  }

  function expectErrorTelemetry(event: string, shipmentId: string) {
    expect(findTelemetryPayload(errorSpy, event, shipmentId)).toBeTruthy();
  }

  function findTelemetryPayload(
    spy: ReturnType<typeof vi.spyOn>,
    event: string,
    shipmentId: string
  ) {
    const matchedCall = spy.mock.calls.find(
      ([label, payload]) =>
        label === "[ShipFlowTelemetry]" &&
        payload &&
        typeof payload === "object" &&
        "event" in payload &&
        "shipmentId" in payload &&
        payload.event === event &&
        payload.shipmentId === shipmentId
    );

    return (matchedCall?.[1] as Record<string, unknown> | undefined) ?? null;
  }

  it("keeps a duplicated sheet isolated while the source request is still running", async () => {
    render(<App />);

    const firstInput = screen.getAllByPlaceholderText("Masukkan ID")[0];
    fireEvent.change(firstInput, { target: { value: "P1" } });
    fireEvent.blur(firstInput);

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByRole("button", { name: "Duplikat Sheet Aktif" }));

    expect(screen.getByText("Total 1 kiriman")).toBeInTheDocument();

    resolveRequest("P1");

    await waitFor(() => {
      expect(screen.getByText("Total 1 kiriman")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("tab", { name: "Sheet 1" }));

    await waitFor(() => {
      expect(screen.getByText("Total 1 kiriman")).toBeInTheDocument();
    });
  });

  it("ignores late responses after deleting the active sheet during an in-flight request", async () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Sheet Baru" }));

    const firstInput = screen.getAllByPlaceholderText("Masukkan ID")[0];
    fireEvent.change(firstInput, { target: { value: "P2" } });
    fireEvent.blur(firstInput);

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByRole("button", { name: "Hapus Sheet Aktif" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Konfirmasi Hapus Sheet Aktif" })
    );

    await waitFor(() => {
      expect(screen.queryByRole("tab", { name: "Sheet 2" })).not.toBeInTheDocument();
      expect(screen.getByText("Total 0 kiriman")).toBeInTheDocument();
    });

    resolveRequest("P2");

    await waitFor(() => {
      expect(screen.getByText("Total 0 kiriman")).toBeInTheDocument();
    });
  });

  it("creates a truly empty new sheet while another sheet still has in-flight tracking", async () => {
    render(<App />);

    const firstInput = screen.getAllByPlaceholderText("Masukkan ID")[0];
    fireEvent.change(firstInput, { target: { value: "P5" } });
    fireEvent.blur(firstInput);

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByRole("button", { name: "Sheet Baru" }));

    expect(screen.getByRole("tab", { name: "Sheet 2" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(screen.getByText("Total 0 kiriman")).toBeInTheDocument();
    expect(screen.getAllByPlaceholderText("Masukkan ID")[0]).toHaveValue("");
  });

  it("creates a new sheet from selected ids and starts tracking them immediately", async () => {
    render(<App />);

    const firstInput = screen.getAllByPlaceholderText("Masukkan ID")[0];
    fireEvent.change(firstInput, { target: { value: "PSEL1" } });
    fireEvent.blur(firstInput);

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledTimes(1);
    });

    resolveRequest("PSEL1");

    await waitFor(() => {
      expect(screen.getByText("Total 1 kiriman")).toBeInTheDocument();
    });

    fireEvent.click(screen.getAllByRole("checkbox")[1]);
    fireEvent.click(screen.getByRole("button", { name: "ID Terselect ke Sheet Baru" }));

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: "Sheet 2" })).toHaveAttribute(
        "aria-selected",
        "true"
      );
      expect(mockedInvoke).toHaveBeenCalledTimes(2);
      expect(screen.getAllByPlaceholderText("Masukkan ID")[0]).toHaveValue("PSEL1");
      expect(screen.getByText("0/1 kiriman dimuat")).toBeInTheDocument();
    });

    resolveRequest("PSEL1");

    await waitFor(() => {
      expect(screen.getByText("Total 1 kiriman")).toBeInTheDocument();
    });
  });

  it("moves focus to the next tracking row when Enter is pressed", () => {
    render(<App />);

    const [firstInput, secondInput] = screen.getAllByPlaceholderText("Masukkan ID");
    firstInput.focus();

    fireEvent.keyDown(firstInput, { key: "Enter" });

    expect(document.activeElement).toBe(secondInput);
    expect(mockedInvoke).not.toHaveBeenCalled();
  });

  it("moves focus between tracking rows with ArrowDown and ArrowUp", () => {
    render(<App />);

    const [firstInput, secondInput, thirdInput] =
      screen.getAllByPlaceholderText("Masukkan ID");

    firstInput.focus();
    fireEvent.keyDown(firstInput, { key: "ArrowDown" });
    expect(document.activeElement).toBe(secondInput);

    fireEvent.keyDown(secondInput, { key: "ArrowDown" });
    expect(document.activeElement).toBe(thirdInput);

    fireEvent.keyDown(thirdInput, { key: "ArrowUp" });
    expect(document.activeElement).toBe(secondInput);
  });

  it("clears the active tracking cell when Delete is pressed in the input", () => {
    render(<App />);

    const firstInput = screen.getAllByPlaceholderText("Masukkan ID")[0];
    fireEvent.change(firstInput, { target: { value: "P2603310114291" } });

    fireEvent.keyDown(firstInput, { key: "Delete" });

    expect(firstInput).toHaveValue("");
    expect(mockedInvoke).not.toHaveBeenCalled();
  });

  it("clears the row tracking cell when Delete is pressed on the row checkbox", () => {
    render(<App />);

    const firstInput = screen.getAllByPlaceholderText("Masukkan ID")[0];
    fireEvent.change(firstInput, { target: { value: "P2603310114291" } });

    const firstRowCheckbox = screen.getAllByRole("checkbox")[1];
    firstRowCheckbox.focus();
    fireEvent.keyDown(firstRowCheckbox, { key: "Delete" });

    expect(firstInput).toHaveValue("");
    expect(mockedInvoke).not.toHaveBeenCalled();
  });

  it("can start a fresh tracking request in a new sheet while another sheet is still loading", async () => {
    render(<App />);

    const firstInput = screen.getAllByPlaceholderText("Masukkan ID")[0];
    fireEvent.change(firstInput, { target: { value: "P6" } });
    fireEvent.blur(firstInput);

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByRole("button", { name: "Sheet Baru" }));

    const newSheetInput = screen.getAllByPlaceholderText("Masukkan ID")[0];
    fireEvent.change(newSheetInput, { target: { value: "P7" } });
    fireEvent.blur(newSheetInput);

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledTimes(2);
    });

    resolveRequest("P7");

    await waitFor(() => {
      expect(screen.queryByText("1/1 kiriman dimuat")).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("tab", { name: "Sheet 1" }));

    await waitFor(() => {
      expect(screen.getByText("0/1 kiriman dimuat")).toBeInTheDocument();
    });
  });

  it("starts bulk paste tracking in a new sheet while another sheet is still loading", async () => {
    render(<App />);

    const firstInput = screen.getAllByPlaceholderText("Masukkan ID")[0];
    fireEvent.change(firstInput, { target: { value: "P8" } });
    fireEvent.blur(firstInput);

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByRole("button", { name: "Sheet Baru" }));

    const newSheetInput = screen.getAllByPlaceholderText("Masukkan ID")[0];
    const pasteEvent = createEvent.paste(newSheetInput);
    Object.defineProperty(pasteEvent, "clipboardData", {
      value: {
        getData: (type: string) => (type === "text" ? "P9\nP10" : ""),
      },
    });
    fireEvent(newSheetInput, pasteEvent);

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledTimes(3);
    });
  });

  it("keeps multiple in-flight row requests attached to their original sheet while switching tabs", async () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Sheet Baru" }));
    fireEvent.click(screen.getByRole("tab", { name: "Sheet 1" }));

    const [firstInput, secondInput] = screen.getAllByPlaceholderText("Masukkan ID");
    fireEvent.change(firstInput, { target: { value: "P3" } });
    fireEvent.blur(firstInput);
    fireEvent.change(secondInput, { target: { value: "P4" } });
    fireEvent.blur(secondInput);

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledTimes(2);
    });

    fireEvent.click(screen.getByRole("tab", { name: "Sheet 2" }));
    resolveRequest("P3");
    resolveRequest("P4");

    await waitFor(() => {
      expect(screen.getByText("Total 0 kiriman")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("tab", { name: "Sheet 1" }));

    await waitFor(() => {
      expect(screen.getByText("Total 2 kiriman")).toBeInTheDocument();
    });
  });

  it("emits telemetry for request start, success, fail, and abort", async () => {
    render(<App />);

    const firstInput = screen.getAllByPlaceholderText("Masukkan ID")[0];

    fireEvent.change(firstInput, { target: { value: "P100" } });
    fireEvent.blur(firstInput);

    await waitFor(() => {
      expectInfoTelemetry("start", "P100");
    });

    fireEvent.change(firstInput, { target: { value: "P101" } });

    await waitFor(() => {
      expectInfoTelemetry("abort", "P100");
    });

    fireEvent.blur(firstInput);

    await waitFor(() => {
      expectInfoTelemetry("start", "P101");
    });

    pendingRequests.get("P101")?.reject(new Error("boom"));

    await waitFor(() => {
      expect(errorSpy).toHaveBeenCalledWith(
        "[ShipFlowTelemetry]",
        expect.objectContaining({
          event: "fail",
          shipmentId: "P101",
          classification: "unknown",
        })
      );
    });

    fireEvent.change(firstInput, { target: { value: "P102" } });
    fireEvent.blur(firstInput);

    await waitFor(() => {
      expectInfoTelemetry("start", "P102");
    });

    resolveRequest("P102");

    await waitFor(() => {
      expect(infoSpy).toHaveBeenCalledWith(
        "[ShipFlowTelemetry]",
        expect.objectContaining({
          event: "success",
          shipmentId: "P102",
          durationMs: expect.any(Number),
        })
      );
    });
  });

  it("rejects overlong tracking ids without invoking backend", async () => {
    render(<App />);

    const firstInput = screen.getAllByPlaceholderText("Masukkan ID")[0];
    fireEvent.change(firstInput, {
      target: { value: `P${"1".repeat(80)}` },
    });
    fireEvent.blur(firstInput);

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledTimes(0);
    });

    expect(screen.getByText("Total 1 kiriman")).toBeInTheDocument();
  });

  it("dedupes duplicate in-flight requests for the same row", async () => {
    render(<App />);

    const firstInput = screen.getAllByPlaceholderText("Masukkan ID")[0];
    fireEvent.change(firstInput, { target: { value: "P300" } });
    fireEvent.blur(firstInput);

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledTimes(1);
    });

    fireEvent.keyDown(firstInput, { key: "Enter" });
    fireEvent.blur(firstInput);

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledTimes(1);
    });
  });

  it("ignores late responses after a row is cleared while request is still running", async () => {
    render(<App />);

    const firstInput = screen.getAllByPlaceholderText("Masukkan ID")[0];
    fireEvent.change(firstInput, { target: { value: "P400" } });
    fireEvent.blur(firstInput);

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledTimes(1);
    });

    fireEvent.change(firstInput, { target: { value: "" } });

    resolveRequest("P400");

    await waitFor(() => {
      expect(screen.getByText("Total 0 kiriman")).toBeInTheDocument();
    });
  });

  it("keeps a dirty row visible while filters are active", async () => {
    render(<App />);

    const firstInput = screen.getAllByPlaceholderText("Masukkan ID")[0];
    fireEvent.change(firstInput, { target: { value: "P500" } });
    fireEvent.blur(firstInput);

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledTimes(1);
    });

    resolveRequest("P500");

    await waitFor(() => {
      expect(screen.getByText("Total 1 kiriman")).toBeInTheDocument();
    });

    fireEvent.change(screen.getAllByPlaceholderText("Filter")[1], {
      target: { value: "ZZZ" },
    });

    fireEvent.change(screen.getAllByPlaceholderText("Masukkan ID")[0], {
      target: { value: "P501" },
    });

    await waitFor(() => {
      expect(screen.getAllByDisplayValue("P501")[0]).toBeInTheDocument();
    });
  });

  it("rejects malformed tracking responses before marking a row as success", async () => {
    render(<App />);

    const firstInput = screen.getAllByPlaceholderText("Masukkan ID")[0];
    fireEvent.change(firstInput, { target: { value: "PBAD" } });
    fireEvent.blur(firstInput);

    await waitFor(() => {
      expect(errorSpy).toHaveBeenCalledWith(
        "[ShipFlowTelemetry]",
        expect.objectContaining({
          event: "fail",
          shipmentId: "PBAD",
          classification: "invalid_response",
        })
      );
    });

    expect(screen.getByText("Total 1 kiriman")).toBeInTheDocument();
  });

  it("keeps three sheets isolated under concurrent tracking pressure", async () => {
    render(<App />);

    const sheet1Input = screen.getAllByPlaceholderText("Masukkan ID")[0];
    fireEvent.change(sheet1Input, { target: { value: "P201" } });
    fireEvent.blur(sheet1Input);

    fireEvent.click(screen.getByRole("button", { name: "Sheet Baru" }));
    const sheet2Input = screen.getAllByPlaceholderText("Masukkan ID")[0];
    const pasteEvent = createEvent.paste(sheet2Input);
    Object.defineProperty(pasteEvent, "clipboardData", {
      value: {
        getData: (type: string) =>
          type === "text" ? "p202\n p203 \nP 204" : "",
      },
    });
    fireEvent(sheet2Input, pasteEvent);

    fireEvent.click(screen.getByRole("button", { name: "Sheet Baru" }));
    const sheet3Input = screen.getAllByPlaceholderText("Masukkan ID")[0];
    fireEvent.change(sheet3Input, { target: { value: "P205" } });
    fireEvent.blur(sheet3Input);

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledTimes(5);
    });

    resolveRequest("P203");
    resolveRequest("P205");
    resolveRequest("P201");

    fireEvent.click(screen.getByRole("tab", { name: "Sheet 3" }));
    await waitFor(() => {
      expect(screen.getByText("Total 1 kiriman")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("tab", { name: "Sheet 2" }));
    await waitFor(() => {
      expect(screen.getByText("1/3 kiriman dimuat")).toBeInTheDocument();
    });

    resolveRequest("P202");
    resolveRequest("P204");

    await waitFor(() => {
      expect(screen.getByText("Total 3 kiriman")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("tab", { name: "Sheet 1" }));
    await waitFor(() => {
      expect(screen.getByText("Total 1 kiriman")).toBeInTheDocument();
    });
  });
});
