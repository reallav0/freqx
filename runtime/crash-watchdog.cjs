"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { reserveRestart } = require("./recovery-policy.cjs");

const PARENT_EXIT_TIMEOUT_MS = 30_000;
const PARENT_EXIT_POLL_MS = 100;
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function log(config, type, details = {}) {
  try {
    fs.appendFileSync(config.logPath, `${JSON.stringify({
      timestamp: new Date().toISOString(), type, runId: config.runId, ...details
    })}\n`);
  } catch (_) {
    // Logging failure must not itself produce an unhandled watchdog crash.
  }
}

function validateConfiguration(config) {
  if (!config || config.type !== "watch" || !Number.isSafeInteger(config.pid) ||
      config.pid <= 0 || config.pid === process.pid || typeof config.runId !== "string" ||
      !config.runId || !Array.isArray(config.args) ||
      config.args.some((argument) => typeof argument !== "string") ||
      [config.statePath, config.logPath, config.execPath, config.cwd].some(
        (value) => typeof value !== "string" || !path.isAbsolute(value))) {
    throw new Error("Invalid watchdog configuration");
  }
  return { ...config, args: [...config.args] };
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

async function waitForParentExit(pid) {
  const deadline = Date.now() + PARENT_EXIT_TIMEOUT_MS;
  while (isProcessAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await sleep(PARENT_EXIT_POLL_MS);
  }
  return true;
}

function readRunState(config) {
  const state = JSON.parse(fs.readFileSync(config.statePath, "utf8"));
  if (!state || state.runId !== config.runId || typeof state.cleanExit !== "boolean") {
    throw new Error("Watchdog run marker does not match this process");
  }
  return state;
}

function removeRunState(config) {
  try {
    if (readRunState(config).runId === config.runId) fs.unlinkSync(config.statePath);
  } catch (_) {}
}

function restartEnvironment(environment = process.env) {
  const cleaned = { ...environment };
  for (const key of Object.keys(cleaned)) {
    if (["ELECTRON_RUN_AS_NODE", "NODE_CHANNEL_FD", "NODE_CHANNEL_SERIALIZATION_MODE"].includes(key.toUpperCase())) {
      delete cleaned[key];
    }
  }
  return cleaned;
}

function launchReplacement(config) {
  return new Promise((resolve, reject) => {
    const child = spawn(config.execPath, config.args, {
      cwd: config.cwd,
      env: restartEnvironment(),
      detached: true,
      windowsHide: true,
      stdio: "ignore"
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve(child.pid);
    });
  });
}

async function handleParentDisconnect(config) {
  let parentExited = false;
  try {
    parentExited = await waitForParentExit(config.pid);
    if (!parentExited) {
      log(config, "watchdog-parent-alive", { pid: config.pid, action: "restart-suppressed" });
      return;
    }
    if (readRunState(config).cleanExit) {
      log(config, "watchdog-clean-exit", { pid: config.pid });
      return;
    }

    log(config, "watchdog-main-exit", { pid: config.pid, action: "unexpected-process-exit" });
    const historyPath = path.join(path.dirname(config.statePath), "restart-history.json");
    const reservation = reserveRestart(historyPath);
    if (!reservation.allowed) {
      log(config, reservation.reason === "restart-limit" ? "recovery-limit" : "recovery-error", reservation);
      return;
    }
    log(config, "recovery-scheduled", reservation);
    await sleep(reservation.delayMs);

    // An intentional shutdown marker may arrive after IPC disconnect. Never
    // relaunch while the original PID still exists, even after a reserved slot.
    if (readRunState(config).cleanExit || isProcessAlive(config.pid)) {
      log(config, "recovery-cancelled", { reason: "clean-exit-or-parent-alive" });
      return;
    }
    const replacementPid = await launchReplacement(config);
    log(config, "recovery-restart", { pid: replacementPid, attempt: reservation.attempt, hidden: true });
  } catch (error) {
    log(config, "recovery-error", { error: error.stack || error.message });
  } finally {
    if (parentExited) removeRunState(config);
  }
}

function runWatchdog() {
  let config;
  let recovering = false;
  const startupTimeout = setTimeout(() => process.exit(1), 30_000);
  process.on("message", (message) => {
    if (config && message?.type === "stop" && message.runId === config.runId) {
      // A second disarm channel also covers a full/read-only disk preventing
      // the parent's clean marker from being written during intentional quit.
      recovering = true;
      clearTimeout(startupTimeout);
      log(config, "watchdog-disarmed", { reason: "parent-request" });
      removeRunState(config);
      process.exit(0);
    }
    if (config || recovering) return;
    try {
      config = validateConfiguration(message);
      clearTimeout(startupTimeout);
      if (process.connected) {
        process.send({ type: "watching", runId: config.runId }, () => {});
      }
    } catch (_) {
      clearTimeout(startupTimeout);
      process.exit(1);
    }
  });
  process.once("disconnect", () => {
    clearTimeout(startupTimeout);
    if (recovering) return;
    recovering = true;
    if (!config) process.exit(1);
    handleParentDisconnect(config).then(
      () => process.exit(0),
      (error) => {
        log(config, "recovery-error", { error: error.stack || error.message });
        process.exit(1);
      }
    );
  });
  if (!process.send) {
    clearTimeout(startupTimeout);
    process.exitCode = 1;
  }
}

if (require.main === module) runWatchdog();

module.exports = {
  handleParentDisconnect, isProcessAlive, launchReplacement, readRunState,
  restartEnvironment, runWatchdog, validateConfiguration, waitForParentExit
};
