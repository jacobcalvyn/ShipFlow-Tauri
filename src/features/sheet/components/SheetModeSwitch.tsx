import { SheetViewMode } from "../types";

type SheetModeSwitchProps = {
  activeMode: SheetViewMode;
  onModeChange: (mode: SheetViewMode) => void;
};

const SHEET_MODES: Array<{ mode: SheetViewMode; label: string }> = [
  { mode: "workspace", label: "Workspace" },
  { mode: "analytics", label: "Pivot/Grafik" },
];

export function SheetModeSwitch({
  activeMode,
  onModeChange,
}: SheetModeSwitchProps) {
  return (
    <div className="sheet-mode-switch" role="tablist" aria-label="Mode Sheet">
      {SHEET_MODES.map((item) => (
        <button
          key={item.mode}
          type="button"
          className={[
            "sheet-mode-button",
            activeMode === item.mode ? "is-active" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          role="tab"
          aria-selected={activeMode === item.mode}
          onClick={() => onModeChange(item.mode)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
