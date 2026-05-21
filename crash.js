let currentCrashReport = null;
let currentLogPath = "";

function formatCrashTime(value) {
  if (!value) {
    return "Unknown";
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function setText(id, value) {
  const element = document.getElementById(id);
  if (element) {
    element.textContent = value || "";
  }
}

function formatCrashDetails(report) {
  if (!report) {
    return "No crash details were provided.";
  }

  const parts = [
    `${report.name || "Error"}: ${report.message || "Unknown error"}`,
    report.stack || "",
    report.details ? JSON.stringify(report.details, null, 2) : ""
  ].filter(Boolean);

  return parts.join("\n\n");
}

function renderCrashReport(payload) {
  currentCrashReport = payload?.report || null;
  currentLogPath = payload?.logPath || currentCrashReport?.logPath || "";

  setText("crashId", currentCrashReport?.id || "Unavailable");
  setText("crashTime", formatCrashTime(currentCrashReport?.timestamp));
  setText("crashLogPath", currentLogPath || "Crash log path unavailable");
  setText("crashMessage", currentCrashReport?.message || "freqx stopped unexpectedly.");
  setText("crashStack", formatCrashDetails(currentCrashReport));
}

async function loadCrashReport() {
  if (!window.soundmuncher?.getCrashReport) {
    renderCrashReport(null);
    return;
  }

  try {
    renderCrashReport(await window.soundmuncher.getCrashReport());
  } catch (error) {
    renderCrashReport({
      report: {
        message: error?.message || "Could not load crash details.",
        stack: error?.stack || ""
      }
    });
  }
}

function bindCrashActions() {
  document.getElementById("reloadAfterCrash")?.addEventListener("click", () => {
    window.soundmuncher?.reloadAfterCrash?.();
  });

  document.getElementById("openCrashLog")?.addEventListener("click", () => {
    window.soundmuncher?.openCrashLog?.();
  });

  document.getElementById("quitAfterCrash")?.addEventListener("click", () => {
    window.soundmuncher?.quitAfterCrash?.();
  });

  document.getElementById("copyCrashDetails")?.addEventListener("click", async () => {
    const text = [
      `Crash ID: ${currentCrashReport?.id || "Unavailable"}`,
      `Time: ${currentCrashReport?.timestamp || "Unavailable"}`,
      `Log: ${currentLogPath || "Unavailable"}`,
      formatCrashDetails(currentCrashReport)
    ].join("\n\n");

    try {
      await navigator.clipboard.writeText(text);
      setText("crashLogPath", currentLogPath ? `${currentLogPath} (details copied)` : "Details copied");
    } catch (error) {
      setText("crashLogPath", currentLogPath || "Could not copy crash details");
    }
  });
}

bindCrashActions();
loadCrashReport();
