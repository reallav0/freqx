"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { fork, spawn } = require("node:child_process");
const {
  MAX_AUTOMATIC_RESTARTS, RESTART_WINDOW_MS, planRestart, reserveRestart
} = require("../runtime/recovery-policy.cjs");
const { restartEnvironment, validateConfiguration } = require("../runtime/crash-watchdog.cjs");

const WATCHDOG_PATH = process.env.FREQX_TEST_WATCHDOG_PATH || path.resolve(__dirname, "../runtime/crash-watchdog.cjs");
const WATCHDOG_EXECUTABLE = process.env.FREQX_TEST_WATCHDOG_EXECUTABLE || process.execPath;
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

if (process.argv[2] === "--replacement-fixture") {
  fs.writeFileSync(process.argv[3], JSON.stringify({
    args: process.argv.slice(4),
    runAsNode: process.env.ELECTRON_RUN_AS_NODE || null,
    channel: process.env.NODE_CHANNEL_FD || null,
    connected: process.connected === true,
    cwd: process.cwd()
  }));
} else if (process.argv[2] === "--parent-fixture") {
  let watchdog;
  let config;
  process.on("message", (message) => {
    if (message.type === "configure") {
      config = { ...message.config, type: "watch", pid: process.pid };
      fs.writeFileSync(config.statePath, JSON.stringify({ runId: config.runId, cleanExit: false }));
      watchdog = spawn(WATCHDOG_EXECUTABLE, [WATCHDOG_PATH], {
        detached: true,
        windowsHide: true,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
      });
      watchdog.on("error", (error) => process.send({ type: "fixture-error", error: error.message }));
      watchdog.on("message", (reply) => process.send({ ...reply, watchdogPid: watchdog.pid }));
      watchdog.send(config);
    } else if (message.type === "disconnect-watchdog") {
      watchdog.disconnect();
      process.send({ type: "watchdog-disconnected" });
    } else if (message.type === "exit") {
      if (message.clean) {
        fs.writeFileSync(config.statePath, JSON.stringify({ runId: config.runId, cleanExit: true }));
      }
      if (message.disarm) {
        watchdog.send({ type: "stop", runId: config.runId }, () => process.exit(0));
      } else {
        process.exit(message.clean ? 0 : 17);
      }
    }
  });
} else {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

async function waitUntil(predicate, label, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await sleep(25);
  }
}

function messageFrom(child, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`Missing fixture message: ${type}`)), 8000);
    const onMessage = (message) => {
      if (message.type === "fixture-error") finish(new Error(message.error));
      else if (message.type === type) finish(null, message);
    };
    const onExit = (code) => finish(new Error(`Fixture exited before ${type}: ${code}`));
    function finish(error, message) {
      clearTimeout(timer);
      child.removeListener("message", onMessage);
      child.removeListener("exit", onExit);
      if (error) reject(error);
      else resolve(message);
    }
    child.on("message", onMessage);
    child.once("exit", onExit);
  });
}

function readLog(logPath) {
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function main() {
  const root = path.resolve(__dirname, "../output/crash-watchdog");
  fs.mkdirSync(root, { recursive: true });
  const output = fs.mkdtempSync(path.join(root, "run-"));
  const runningFixtures = [];
  const results = [];
  const check = (name, callback) => {
    callback();
    results.push(name);
    console.log(`PASS ${name}`);
  };
  const now = Date.now();

  async function fixture(name, options = {}) {
    const directory = path.join(output, name);
    fs.mkdirSync(directory);
    const config = {
      type: "watch",
      runId: name,
      statePath: path.join(directory, "run.json"),
      logPath: path.join(directory, "crash.log"),
      execPath: options.execPath || process.execPath,
      args: [__filename, "--replacement-fixture", path.join(directory, "replacement.json"), "--hidden", "--crash-recovery"],
      cwd: directory
    };
    if (options.history !== undefined) {
      fs.writeFileSync(path.join(directory, "restart-history.json"), options.history);
    }
    const child = fork(__filename, ["--parent-fixture"], {
      windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"]
    });
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    runningFixtures.push(child);
    const ready = messageFrom(child, "watching");
    child.send({ type: "configure", config });
    const acknowledgement = await ready;
    assert.equal(acknowledgement.runId, config.runId);
    return {
      child, config, directory, watchdogPid: acknowledgement.watchdogPid,
      replacementPath: path.join(directory, "replacement.json"),
      historyPath: path.join(directory, "restart-history.json")
    };
  }

  function exitFixture(subject, clean, disarm = false) {
    const exited = new Promise((resolve) => subject.child.once("exit", resolve));
    subject.child.send({ type: "exit", clean, disarm });
    return exited;
  }

  async function waitForDecision(subject, type) {
    await waitUntil(() => readLog(subject.config.logPath).some((entry) => entry.type === type), type);
    await waitUntil(() => !fs.existsSync(subject.config.statePath), "run marker cleanup");
  }

  try {
    check("restart policy allows only three attempts within five minutes", () => {
      assert.equal(MAX_AUTOMATIC_RESTARTS, 3);
      assert.equal(RESTART_WINDOW_MS, 300000);
      let history = { version: 1, restarts: [] };
      for (const delayMs of [1000, 2000, 4000]) {
        const plan = planRestart(history, now);
        assert.equal(plan.allowed, true);
        assert.equal(plan.delayMs, delayMs);
        history = plan.history;
      }
      assert.equal(planRestart(history, now).allowed, false);
    });
    check("restart budget expires and survives a backwards clock adjustment", () => {
      const history = { version: 1, restarts: [now, now, now] };
      assert.equal(planRestart(history, now + RESTART_WINDOW_MS).allowed, true);
      assert.equal(planRestart(history, now - 1000).allowed, false);
    });
    check("malformed restart data fails closed", () => {
      for (const history of [null, {}, [], { version: 1, restarts: ["invalid"] }, { version: 2, restarts: [] }]) {
        assert.throws(() => planRestart(history, now), /Invalid restart history/);
      }
      const historyPath = path.join(output, "invalid-history.json");
      fs.writeFileSync(historyPath, "{broken");
      assert.equal(reserveRestart(historyPath).allowed, false);
      assert.equal(fs.readFileSync(historyPath, "utf8"), "{broken");
    });
    check("persisted reservations survive independent calls and cap failed launches", () => {
      const historyPath = path.join(output, "persistent-history.json");
      for (let attempt = 1; attempt <= 3; attempt++) {
        assert.deepEqual(reserveRestart(historyPath, now), {
          allowed: true, attempt, delayMs: 1000 * 2 ** (attempt - 1)
        });
      }
      assert.equal(reserveRestart(historyPath, now).allowed, false);
      assert.equal(JSON.parse(fs.readFileSync(historyPath)).restarts.length, 3);
      assert.equal(fs.existsSync(`${historyPath}.lock`), false);
    });
    check("restart strips inherited Electron Node and IPC environment variables", () => {
      assert.deepEqual(restartEnvironment({
        PATH: "kept", ELECTRON_RUN_AS_NODE: "1", NODE_CHANNEL_FD: "9",
        NODE_CHANNEL_SERIALIZATION_MODE: "json", electron_run_as_node: "1"
      }), { PATH: "kept" });
    });
    check("watchdog rejects unusable initial configuration", () => {
      assert.throws(() => validateConfiguration({ type: "watch" }), /Invalid watchdog/);
    });

    const unexpected = await fixture("unexpected-exit");
    const crashTime = Date.now();
    await exitFixture(unexpected, false);
    await waitForDecision(unexpected, "recovery-restart");
    await waitUntil(() => fs.existsSync(unexpected.replacementPath), "hidden replacement");
    check("unexpected real parent exit starts one replacement after backoff", () => {
      assert.ok(Date.now() - crashTime >= 950);
      assert.equal(readLog(unexpected.config.logPath).filter((entry) => entry.type === "recovery-restart").length, 1);
      assert.equal(JSON.parse(fs.readFileSync(unexpected.historyPath)).restarts.length, 1);
    });
    check("replacement preserves hidden arguments and has no inherited Node mode or IPC", () => {
      const replacement = JSON.parse(fs.readFileSync(unexpected.replacementPath));
      assert.deepEqual(replacement.args, ["--hidden", "--crash-recovery"]);
      assert.equal(replacement.runAsNode, null);
      assert.equal(replacement.channel, null);
      assert.equal(replacement.connected, false);
      assert.equal(replacement.cwd, unexpected.directory);
    });

    const clean = await fixture("intentional-exit");
    await exitFixture(clean, true);
    await waitForDecision(clean, "watchdog-clean-exit");
    check("intentional quit removes its marker without restarting or consuming budget", () => {
      assert.equal(fs.existsSync(clean.replacementPath), false);
      assert.equal(fs.existsSync(clean.historyPath), false);
    });

    const disarmed = await fixture("ipc-disarm");
    await exitFixture(disarmed, false, true);
    await waitForDecision(disarmed, "watchdog-disarmed");
    check("explicit stop IPC prevents restart when the clean marker cannot be updated", () => {
      assert.equal(fs.existsSync(disarmed.replacementPath), false);
      assert.equal(fs.existsSync(disarmed.historyPath), false);
    });

    const killed = await fixture("abrupt-process-death");
    const killedExit = new Promise((resolve) => killed.child.once("exit", resolve));
    killed.child.kill("SIGKILL");
    await killedExit;
    await waitForDecision(killed, "recovery-restart");
    check("watchdog survives an abruptly killed parent process", () => {
      assert.ok(readLog(killed.config.logPath).some((entry) => entry.type === "watchdog-main-exit"));
      assert.equal(JSON.parse(fs.readFileSync(killed.historyPath)).restarts.length, 1);
    });

    const held = await fixture("disconnect-before-parent-exit");
    const disconnected = messageFrom(held.child, "watchdog-disconnected");
    held.child.send({ type: "disconnect-watchdog" });
    await disconnected;
    await sleep(1200);
    check("IPC disconnect does not relaunch a parent that is still alive", () => {
      assert.equal(held.child.exitCode, null);
      assert.equal(fs.existsSync(held.replacementPath), false);
      assert.equal(fs.existsSync(held.historyPath), false);
    });
    await exitFixture(held, false);
    await waitForDecision(held, "recovery-restart");
    check("watchdog relaunches once the disconnected parent actually exits", () => {
      assert.equal(readLog(held.config.logPath).filter((entry) => entry.type === "recovery-restart").length, 1);
    });

    const lateClean = await fixture("late-clean-marker");
    await exitFixture(lateClean, false);
    await waitUntil(() => readLog(lateClean.config.logPath).some((entry) => entry.type === "recovery-scheduled"), "scheduled recovery");
    fs.writeFileSync(lateClean.config.statePath, JSON.stringify({ runId: lateClean.config.runId, cleanExit: true }));
    await waitForDecision(lateClean, "recovery-cancelled");
    check("late clean marker cancels an already scheduled restart", () => {
      assert.equal(fs.existsSync(lateClean.replacementPath), false);
    });

    const capped = await fixture("restart-cap", { history: JSON.stringify({ version: 1, restarts: [now, now, now] }) });
    await exitFixture(capped, false);
    await waitForDecision(capped, "recovery-limit");
    check("separate watchdog process honors persisted restart cap", () => {
      assert.equal(fs.existsSync(capped.replacementPath), false);
      assert.equal(JSON.parse(fs.readFileSync(capped.historyPath)).restarts.length, 3);
    });

    const invalid = await fixture("invalid-history", { history: "malformed" });
    await exitFixture(invalid, false);
    await waitForDecision(invalid, "recovery-error");
    check("separate watchdog process refuses recovery with corrupted history", () => {
      assert.equal(fs.existsSync(invalid.replacementPath), false);
      assert.equal(fs.readFileSync(invalid.historyPath, "utf8"), "malformed");
    });

    const failed = await fixture("spawn-failure", { execPath: path.join(output, "missing-app.exe") });
    await exitFixture(failed, false);
    await waitForDecision(failed, "recovery-error");
    check("replacement spawn failure is logged and consumes a bounded attempt", () => {
      assert.equal(fs.existsSync(failed.replacementPath), false);
      assert.equal(JSON.parse(fs.readFileSync(failed.historyPath)).restarts.length, 1);
      assert.ok(readLog(failed.config.logPath).some((entry) => /ENOENT/.test(entry.error || "")));
    });

    fs.writeFileSync(path.join(output, "results.json"), JSON.stringify({ passed: results.length, results }, null, 2));
    console.log(`${results.length} crash recovery checks passed. Artifacts: ${output}`);
  } finally {
    for (const child of runningFixtures) {
      if (child.exitCode === null && !child.killed) child.kill();
    }
  }
}
