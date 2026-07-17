const path = require("node:path");

const isWindows = process.platform === "win32";
const executable = (name) => `${name}${isWindows ? ".exe" : ""}`;
const nativeResources = [
  {
    from: path.join("target", "release", executable("shipflow-service")),
    to: path.join("native", executable("shipflow-service")),
  },
  {
    from: path.join("target", "release", executable("shipflow-workspace-host")),
    to: path.join("native", executable("shipflow-workspace-host")),
  },
  ...(isWindows
    ? [
        {
          from: path.join("target", "release", "duckdb.dll"),
          to: path.join("native", "duckdb.dll"),
        },
      ]
    : []),
];

module.exports = {
  appId: "com.shipflow.desktop",
  productName: "ShipFlow Desktop",
  artifactName: "ShipFlow-${version}-${os}-${arch}.${ext}",
  asar: true,
  directories: {
    output: "release",
  },
  files: ["out/**/*", "package.json"],
  extraResources: [
    ...nativeResources,
    {
      from: "assets/icons",
      to: "icons",
      filter: ["icon.png", "icon.ico", "service-icon.png", "service-icon.ico"],
    },
  ],
  fileAssociations: [
    {
      ext: "shipflow",
      name: "ShipFlow Workspace",
      role: "Editor",
    },
  ],
  mac: {
    category: "public.app-category.business",
    icon: "assets/icons/icon.png",
    target: ["dmg", "zip"],
    artifactName: "ShipFlow-${version}-macos-${arch}.${ext}",
    hardenedRuntime: true,
    gatekeeperAssess: false,
  },
  win: {
    icon: "assets/icons/icon.ico",
    target: ["nsis"],
    artifactName: "ShipFlow-${version}-windows-${arch}.${ext}",
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: false,
    perMachine: false,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
  },
  publish: {
    provider: "github",
  },
};
