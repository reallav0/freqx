// Real Electron + production recovery controller/helper; no user profile/audio.
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");

if (process.versions.electron && process.type === "browser") {
  runFixture();
} else {
  runTests().catch((error) => { console.error(error); process.exitCode = 1; });
}

function runFixture() {
  const { app, BrowserWindow, crashReporter } = require("electron");
  const directory = process.env.FREQX_RECOVERY_TEST_DIRECTORY;
  const config = JSON.parse(fs.readFileSync(path.join(directory, "fixture.json")));
  const userData = path.join(directory, "profile");
  fs.mkdirSync(userData, { recursive: true });
  app.setPath("userData", userData);
  app.setPath("sessionData", path.join(userData, "session"));
  app.setPath("crashDumps", path.join(userData, "dumps"));
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu");
  // This desktop test sandbox cannot launch Chromium's GPU subprocess. As in
  // the audio fixture, keep software rendering in-process for the test only.
  app.commandLine.appendSwitch("in-process-gpu");
  crashReporter.start({ uploadToServer: false });
  const { createCrashRecovery } = require(config.controller);
  const record = (entry) => fs.appendFileSync(path.join(directory, "events.jsonl"), `${JSON.stringify(entry)}\n`);
  process.on("uncaughtException", (error) => {
    record({ type: "fixture-error", message: error.stack });
    recovery.stop("fixture-error");
    app.exit(1);
  });
  process.on("unhandledRejection", (error) => {
    record({ type: "fixture-error", message: error?.stack || String(error) });
    recovery.stop("fixture-error");
    app.exit(1);
  });
  let ready;
  const monitoring = new Promise((resolve) => { ready = resolve; });
  const recovery = createCrashRecovery({ app, logEvent(type, details) {
    record({ type, ...details });
    if (type === "recovery-monitor-ready") ready();
  } });
  recovery.start();
  app.on("before-quit", () => recovery.stop("test-quit"));
  app.whenReady().then(async () => {
    const recovered = process.argv.includes("--recovered");
    record({ type: "ready", pid: process.pid });
    const win = new BrowserWindow({ show: false, webPreferences: { sandbox: false } });
    await win.loadURL("data:text/html,<title>Recovery test</title>");
    record({ type: "window", pid: process.pid, recovered, hidden: !win.isVisible(), argv: process.argv });
    await monitoring;
    if (recovered || config.mode === "clean") {
      record({ type: "complete", pid: process.pid, recovered });
      app.quit();
    } else if (config.mode === "native") {
      // Crashpad captures this native crash in the isolated fixture profile.
      process.crash();
    } else {
      recovery.requestRestart("test-renderer-fatal-error");
      recovery.requestRestart("duplicate-error");
    }
  });
}

async function runTests() {
  const assert = require("node:assert/strict");
  const { spawn } = require("node:child_process");
  const output = path.join(root, "output", "recovery-integration");
  fs.mkdirSync(output, { recursive: true });
  const controller = process.argv.includes("--packaged")
    ? path.join(root, "output", "voice-isolation-build", "win-unpacked", "resources", "app.asar", "runtime", "crash-recovery.cjs")
    : path.join(root, "runtime", "crash-recovery.cjs");
  for (const mode of ["clean", "native", "handled"]) {
    const directory = fs.mkdtempSync(path.join(output, `${mode}-`));
    fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name: "freqx-recovery-test", version: "1.0.0", main: __filename }));
    fs.writeFileSync(path.join(directory, "fixture.json"), JSON.stringify({ mode, controller }));
    const env = { ...process.env, FREQX_RECOVERY_TEST_DIRECTORY: directory };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.PORTABLE_EXECUTABLE_FILE;
    const diagnosticFd = fs.openSync(path.join(directory, "electron.log"), "a");
    const child = spawn(require("electron"), [directory, "freqx://import-sound?fixture=do-not-replay"], {
      env, cwd: root, windowsHide: true, stdio: ["ignore", diagnosticFd, diagnosticFd]
    });
    fs.closeSync(diagnosticFd);
    let spawnError;
    child.on("error", (error) => { spawnError = error; });
    const eventsPath = path.join(directory, "events.jsonl");
    const events = () => fs.existsSync(eventsPath)
      ? fs.readFileSync(eventsPath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
    try {
      const deadline = Date.now() + 25000;
      while (!events().some((entry) => entry.type === "complete")) {
        if (spawnError) throw spawnError;
        const failure = events().find((entry) => entry.type === "fixture-error");
        if (failure) throw new Error(failure.message);
        if (Date.now() > deadline) throw new Error(`Timed out: ${mode}; events: ${JSON.stringify(events())}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      // Give the disarmed helper time to observe the clean final exit.
      await new Promise((resolve) => setTimeout(resolve, 1400));
      const all = events();
      const windows = all.filter((entry) => entry.type === "window");
      assert.equal(windows.length, mode === "clean" ? 1 : 2);
      if (mode !== "clean") {
        assert.notEqual(windows[0].pid, windows[1].pid);
        assert.equal(windows[1].recovered, true);
        assert.equal(windows[1].hidden, true);
        assert(windows[1].argv.includes("--hidden"));
        assert(!windows[1].argv.some((arg) => arg.startsWith("freqx:")));
      }
      const logs = path.join(directory, "profile", "crash-logs");
      assert(!fs.readdirSync(logs).some((file) => /^recovery-.*\.json$/.test(file)), "watchdog removes per-run marker after clean quit");
      console.log(`PASS real Electron ${mode}: ${windows.length} process(es), clean final quit, hidden recovery without replay`);
    } finally {
      // Only fixture-owned run markers and PIDs are touched, including on error.
      const logs = path.join(directory, "profile", "crash-logs");
      if (fs.existsSync(logs)) {
        for (const file of fs.readdirSync(logs).filter((name) => /^recovery-.*\.json$/.test(name))) {
          const target = path.join(logs, file);
          try {
            const state = JSON.parse(fs.readFileSync(target));
            fs.writeFileSync(target, JSON.stringify({ ...state, cleanExit: true }));
          } catch {}
        }
      }
      for (const pid of new Set([child.pid, ...events().filter((entry) => entry.type === "window").map((entry) => entry.pid)])) {
        if (Number.isInteger(pid)) { try { process.kill(pid); } catch {} }
      }
    }
  }
}
