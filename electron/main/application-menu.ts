import type { MenuItemConstructorOptions } from "electron";

export function buildViewMenu(
  isPackaged: boolean,
): MenuItemConstructorOptions[] {
  return [
    ...(!isPackaged
      ? [
          { role: "reload" as const },
          { role: "toggleDevTools" as const },
          { type: "separator" as const },
        ]
      : []),
    { role: "resetZoom" },
    { role: "zoomIn" },
    { role: "zoomOut" },
    { type: "separator" },
    { role: "togglefullscreen" },
  ];
}
