import { spawn } from "node:child_process";
import http from "node:http";

const serviceWebUrl = "http://127.0.0.1:1432";

const children = [];
let isShuttingDown = false;

function spawnCommand(command, args, options = {}) {
  const child = spawn(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
    ...options,
  });

  children.push(child);

  child.on("exit", (code, signal) => {
    if (isShuttingDown) {
      return;
    }

    isShuttingDown = true;
    for (const otherChild of children) {
      if (otherChild !== child && !otherChild.killed) {
        otherChild.kill();
      }
    }

    if (signal) {
      process.kill(process.pid, signal);
      return;
    }

    process.exit(code ?? 0);
  });

  return child;
}

function shutdown() {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  for (const child of children) {
    if (!child.killed) {
      child.kill();
    }
  }
}

process.on("SIGINT", () => {
  shutdown();
  process.exit(130);
});

process.on("SIGTERM", () => {
  shutdown();
  process.exit(143);
});

spawnCommand("npm", ["run", "dev:service:web"]);

async function waitForServiceWeb() {
  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    if (await canReachServiceWeb()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for ${serviceWebUrl}`);
}

function canReachServiceWeb() {
  return new Promise((resolve) => {
    const request = http.get(serviceWebUrl, (response) => {
      response.resume();
      resolve(response.statusCode !== undefined && response.statusCode < 500);
    });

    request.setTimeout(1_000, () => {
      request.destroy();
      resolve(false);
    });

    request.on("error", () => {
      resolve(false);
    });
  });
}

waitForServiceWeb()
  .then(() => {
    spawnCommand("cargo", ["run", "--manifest-path", "apps/service/Cargo.toml"], {
      env: {
        ...process.env,
        SHIPFLOW_SERVICE_SETTINGS_URL: serviceWebUrl,
      },
    });
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    shutdown();
    process.exit(1);
  });
