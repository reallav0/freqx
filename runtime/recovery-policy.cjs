"use strict";

const fs = require("node:fs");
const path = require("node:path");

const RESTART_WINDOW_MS = 5 * 60 * 1000;
const MAX_AUTOMATIC_RESTARTS = 3;

function planRestart(history, now = Date.now()) {
  if (!Number.isFinite(now) || !history || history.version !== 1 ||
      !Array.isArray(history.restarts) ||
      history.restarts.some((timestamp) => !Number.isFinite(timestamp) || timestamp < 0)) {
    throw new Error("Invalid restart history");
  }

  // Keep future timestamps as well: moving the system clock backwards must not
  // reset the crash-loop budget.
  const recent = history.restarts.filter((timestamp) => timestamp > now - RESTART_WINDOW_MS);
  if (recent.length >= MAX_AUTOMATIC_RESTARTS) {
    return { allowed: false, attempt: recent.length, delayMs: 0, reason: "restart-limit" };
  }

  const attempt = recent.length + 1;
  return {
    allowed: true,
    attempt,
    delayMs: 1000 * (2 ** (attempt - 1)),
    history: { version: 1, restarts: [...recent, now] }
  };
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Access denied means a process exists. Only ESRCH proves it has exited.
    return error.code !== "ESRCH";
  }
}

function acquireLock(lockPath) {
  try {
    return fs.openSync(lockPath, "wx");
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const owner = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || isProcessAlive(owner.pid)) {
      throw new Error("Restart history is locked by another process");
    }
    fs.unlinkSync(lockPath);
    return fs.openSync(lockPath, "wx");
  }
}

function reserveRestart(historyPath, now = Date.now()) {
  const lockPath = `${historyPath}.lock`;
  const temporaryPath = `${historyPath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  let lock;
  try {
    fs.mkdirSync(path.dirname(historyPath), { recursive: true });
    lock = acquireLock(lockPath);
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }));

    let history;
    try {
      history = JSON.parse(fs.readFileSync(historyPath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") {
        return { allowed: false, attempt: 0, delayMs: 0, reason: "history-invalid", error: error.message };
      }
      history = { version: 1, restarts: [] };
    }

    let plan;
    try {
      plan = planRestart(history, now);
    } catch (error) {
      return { allowed: false, attempt: 0, delayMs: 0, reason: "history-invalid", error: error.message };
    }
    if (!plan.allowed) return plan;

    // Reserve before launching, including failed launches, so a broken install
    // cannot create an unlimited restart loop. Rename prevents partial JSON.
    fs.writeFileSync(temporaryPath, `${JSON.stringify(plan.history)}\n`, { flag: "wx" });
    fs.renameSync(temporaryPath, historyPath);
    return { allowed: true, attempt: plan.attempt, delayMs: plan.delayMs };
  } catch (error) {
    return { allowed: false, attempt: 0, delayMs: 0, reason: "history-unavailable", error: error.message };
  } finally {
    try { fs.unlinkSync(temporaryPath); } catch (_) {}
    if (lock !== undefined) {
      try { fs.closeSync(lock); } catch (_) {}
      try { fs.unlinkSync(lockPath); } catch (_) {}
    }
  }
}

module.exports = { MAX_AUTOMATIC_RESTARTS, RESTART_WINDOW_MS, planRestart, reserveRestart };
