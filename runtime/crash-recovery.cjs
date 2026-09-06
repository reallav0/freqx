const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { spawn } = require("node:child_process");
const { reserveRestart } = require("./recovery-policy.cjs");

function createCrashRecovery({ app, logEvent = () => {} }) {
  const runId = randomUUID();
  const directory = path.join(app.getPath("userData"), "crash-logs");
  const statePath = path.join(directory, `recovery-${runId}.json`);
  // Never replay an import URL, installer argument, or a one-time action.
  const args = [...(app.isPackaged ? [] : [app.getAppPath()]), "--hidden", "--recovered"];
  const execPath = app.isPackaged && process.env.PORTABLE_EXECUTABLE_FILE
    ? process.env.PORTABLE_EXECUTABLE_FILE : process.execPath;
  const config = {
    type: "watch", pid: process.pid, runId, statePath,
    logPath: path.join(directory, "freqx-crash.log"),
    execPath, args, cwd: path.dirname(execPath)
  };
  let watcher;
  let watching = false;
  let stopped = false;
  let restarting = false;
  let restartTimer;
  let startTime = 0;

  function log(type, details = {}) {
    try { logEvent(type, { runId, pid: process.pid, ...details }); } catch {}
  }

  function writeState(cleanExit, reason) {
    const temporary = `${statePath}.tmp`;
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify({ runId, cleanExit, reason, pid: process.pid }));
    fs.renameSync(temporary, statePath);
  }

  function markClean(reason) {
    try { writeState(true, reason); } catch (error) {
      log("recovery-marker-error", { message: error.message });
    }
    if (watcher?.connected) {
      try { watcher.send({ type: "stop", runId }, () => {}); } catch {}
    }
  }

  function start() {
    if (watcher || stopped) return;
    startTime = Date.now();
    try {
      writeState(false, "running");
      // The helper must survive the Electron main process and native crashes.
      // Unpack it so Node's startup never depends on an ASAR virtual filename.
      const helper = path.join(__dirname, "crash-watchdog.cjs")
        .replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
      watcher = spawn(process.execPath, [helper], {
        detached: true,
        windowsHide: true,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
      });
      watcher.on("error", (error) => {
        watching = false;
        log("recovery-monitor-error", { message: error.message });
      });
      watcher.on("exit", (code, signal) => {
        watching = false;
        if (!stopped) log("recovery-monitor-exit", { code, signal });
      });
      watcher.on("message", (message) => {
        if (message?.type === "watching" && message.runId === runId && !stopped) {
          watching = true;
          log("recovery-monitor-ready");
        }
      });
      watcher.send(config, (error) => {
        if (error) log("recovery-monitor-error", { message: error.message });
      });
      watcher.unref();
      watcher.channel?.unref();
    } catch (error) {
      log("recovery-monitor-error", { message: error.message });
    }
  }

  function requestRestart(reason) {
    if (stopped || restarting) return false;
    restarting = true;
    log("recovery-requested", { reason });
    function exitForRecovery() {
      if (stopped) return;
      if (watching && watcher?.connected) {
        // app.exit skips before-quit; the watchdog must see an unclean exit.
        app.exit(1);
        return;
      }
      if (Date.now() - startTime < 4000) {
        restartTimer = setTimeout(exitForRecovery, 100);
        return;
      }
      // A failed monitor can still recover handled JS/renderer failures using
      // Electron's relauncher. Disarm it first so only one process can restart.
      markClean("relaunch-fallback");
      let reservation;
      try { reservation = reserveRestart(path.join(directory, "restart-history.json")); }
      catch (error) { reservation = { allowed: false, reason: error.message }; }
      if (!reservation.allowed) {
        log("recovery-limit", reservation);
        app.exit(1);
        return;
      }
      restartTimer = setTimeout(() => {
        if (stopped) return;
        try {
          app.relaunch({ execPath, args });
          log("recovery-relaunch-fallback", reservation);
        } catch (error) {
          log("recovery-relaunch-error", { message: error.message });
        }
        app.exit(1);
      }, reservation.delayMs);
    }
    // In particular, never navigate/exit synchronously in render-process-gone.
    restartTimer = setTimeout(exitForRecovery, 100);
    return true;
  }

  function stop(reason = "quit") {
    if (stopped) return;
    stopped = true;
    clearTimeout(restartTimer);
    markClean(reason);
    log("recovery-disarmed", { reason });
  }

  return { start, requestRestart, stop };
}

module.exports = { createCrashRecovery };
