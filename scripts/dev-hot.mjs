import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureRealDirectory } from "./release-assets.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

// dev-server installs its recursive watcher before the first one-shot build
// completes, so keep the directory present in a fresh checkout.
ensureRealDirectory(path.join(root, "dist"), "dev-hot dist");

const commands = [
  {
    name: "build",
    args: [path.join(root, "build.mjs"), "--watch", "--dev"],
  },
  {
    name: "server",
    args: [path.join(root, "scripts", "dev-server.mjs")],
  },
];

const children = [];
let stopping = false;
let requestedExitCode = 0;
let shutdownPromise = null;

const WINDOWS_TASKKILL_TIMEOUT_MS = 2000;
const FORCE_TERMINATION_TIMEOUT_MS = 2000;

function waitForExit(record, timeoutMs) {
  if (record.exited) return Promise.resolve(true);
  if (!record.exitPromise) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(exited);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    record.exitPromise.then(
      () => finish(true),
      () => finish(false),
    );
  });
}

function runWindowsTaskkill(record) {
  return new Promise((resolve) => {
    let killer;
    let settled = false;
    const finish = (success, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) console.error(`[dev-hot] taskkill error: ${error.message}`);
      resolve(success);
    };
    const timer = setTimeout(() => {
      try {
        killer?.kill();
      } catch {
        // The child fallback below is still required.
      }
      finish(false);
    }, WINDOWS_TASKKILL_TIMEOUT_MS);

    try {
      killer = spawn("taskkill", ["/pid", String(record.child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch (error) {
      finish(false, error);
      return;
    }
    killer.once("close", (code) => finish(code === 0));
    killer.once("error", (error) => finish(false, error));
  });
}

async function terminateWindows(record) {
  if (record.exited) return true;
  const taskkillSucceeded = await runWindowsTaskkill(record);
  if (record.exited) return true;
  if (!taskkillSucceeded) {
    console.warn(`[dev-hot] taskkill failed for ${record.name}; falling back to child.kill()`);
  }

  try {
    record.child.kill();
  } catch (error) {
    console.error(`[dev-hot] child.kill fallback failed for ${record.name}: ${error.message}`);
  }
  if (await waitForExit(record, FORCE_TERMINATION_TIMEOUT_MS)) return true;

  try {
    record.child.kill("SIGKILL");
  } catch (error) {
    console.error(`[dev-hot] forced child.kill failed for ${record.name}: ${error.message}`);
  }
  if (await waitForExit(record, FORCE_TERMINATION_TIMEOUT_MS)) return true;

  console.error(`[dev-hot] ${record.name} did not terminate within the bounded Windows timeout`);
  record.child.unref?.();
  return false;
}

function spawnChild(command) {
  const child = spawn(process.execPath, command.args, {
    cwd: root,
    env: process.env,
    stdio: "inherit",
    // On Unix each watcher owns a process group, so its one-shot build or
    // server descendants can be terminated together with the watcher.
    detached: process.platform !== "win32",
  });
  const record = {
    ...command,
    child,
    exited: false,
    exitCode: null,
    exitSignal: null,
    exitPromise: null,
  };

  record.exitPromise = new Promise((resolve) => {
    child.once("close", (code, signal) => {
      record.exited = true;
      record.exitCode = code;
      record.exitSignal = signal;
      console.log(`[dev-hot] ${command.name} exited (code=${code} signal=${signal})`);
      resolve({ code, signal });
      if (!stopping) {
        const exitCode =
          typeof code === "number"
            ? code
            : signal === "SIGINT"
              ? 130
              : signal === "SIGTERM"
                ? 143
                : 1;
        requestShutdown(exitCode, signal);
      }
    });
    child.once("error", (error) => {
      console.error(`[dev-hot] ${command.name} spawn error: ${error.message}`);
      if (!record.exited) requestShutdown(1, "SIGTERM");
    });
  });

  children.push(record);
  console.log(`[dev-hot] started ${command.name} (pid=${child.pid ?? "pending"})`);
  return record;
}

async function terminate(record, signal) {
  if (!record.child.pid) return record.exited;
  if (process.platform === "win32") return terminateWindows(record);

  const killGroup = (nextSignal) => {
    try {
      // Negative pid targets the detached process group created by spawn().
      process.kill(-record.child.pid, nextSignal);
    } catch {
      if (!record.exited) {
        try {
          record.child.kill(nextSignal);
        } catch {
          // Best effort: the close event below still determines final status.
        }
      }
    }
  };

  killGroup(signal || "SIGTERM");
  if (await waitForExit(record, FORCE_TERMINATION_TIMEOUT_MS)) return true;
  killGroup("SIGKILL");
  if (await waitForExit(record, FORCE_TERMINATION_TIMEOUT_MS)) return true;

  console.error(`[dev-hot] ${record.name} did not terminate within the bounded Unix timeout`);
  record.child.unref?.();
  return false;
}

function requestShutdown(exitCode, signal = "SIGTERM") {
  if (typeof exitCode === "number") {
    requestedExitCode = exitCode;
  }
  if (shutdownPromise) {
    // A second Ctrl-C should not leave a stubborn child behind.
    for (const record of children) void terminate(record, "SIGTERM");
    return;
  }

  stopping = true;
  shutdownPromise = (async () => {
    const terminated = await Promise.all(children.map((record) => terminate(record, signal)));
    // Never await ChildProcess close events indefinitely. terminate() already
    // performed bounded taskkill + child.kill fallbacks; this final wait only
    // gives close events a short chance to settle bookkeeping.
    await Promise.all(children.map((record) => waitForExit(record, 250)));
    if (children.some((record) => !record.exited) || terminated.some((value) => !value)) {
      console.error("[dev-hot] one or more child processes remained after bounded termination");
      process.exitCode = 1;
    } else {
      process.exitCode = requestedExitCode;
    }
  })();
  shutdownPromise.catch((error) => {
    console.error("[dev-hot] shutdown failed:", error);
    process.exitCode = 1;
  });
}

process.on("SIGINT", () => {
  console.log("[dev-hot] SIGINT; stopping build and server trees");
  requestShutdown(130, "SIGINT");
});
process.on("SIGTERM", () => {
  console.log("[dev-hot] SIGTERM; stopping build and server trees");
  requestShutdown(143, "SIGTERM");
});
process.on("uncaughtException", (error) => {
  console.error("[dev-hot] uncaught exception:", error);
  requestShutdown(1, "SIGTERM");
});
process.on("unhandledRejection", (error) => {
  console.error("[dev-hot] unhandled rejection:", error);
  requestShutdown(1, "SIGTERM");
});

for (const command of commands) {
  if (stopping) break;
  spawnChild(command);
}
