const path = require("node:path");
const { app, BrowserWindow, session } = require("electron");

const samples = [
  { name: "Airhorn", board: "Stream", key: "F1", size: "166 KB", mode: "Overlap", volume: 72, tone: "#e0bb62", favorite: true, pinned: true },
  { name: "Mission failed", board: "Games", key: "Q", size: "84 KB", mode: "Restart", volume: 92, tone: "#d87966" },
  { name: "Crowd cheer", board: "Reactions", key: "F3", size: "312 KB", mode: "Overlap", volume: 64, tone: "#78b8d8", favorite: true },
  { name: "Drum roll", board: "Stream", key: "E", size: "248 KB", mode: "Play Once", volume: 81, tone: "#9d8ad7" },
  { name: "Alert ping", board: "Alerts", key: "T", size: "46 KB", mode: "Overlap", volume: 56, tone: "#75b99f" },
  { name: "Sad violin", board: "Reactions", key: "F2", size: "1.2 MB", mode: "Restart", volume: 76, tone: "#c887a7" }
];

function createPreviewWindow() {
  const previewSession = session.fromPartition("freqx-ui-preview");
  previewSession.webRequest.onBeforeRequest({ urls: ["file://*/*"] }, (details, callback) => {
    callback({ cancel: details.url.endsWith("/renderer.js") });
  });

  const window = new BrowserWindow({
    width: 1200,
    height: 760,
    minWidth: 900,
    minHeight: 620,
    autoHideMenuBar: true,
    backgroundColor: "#090a09",
    title: "freqx UI preview",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      session: previewSession
    }
  });

  window.loadFile(path.join(__dirname, "..", "index.html"));
  window.webContents.once("did-finish-load", async () => {
    await window.webContents.executeJavaScript(`
      (() => {
        const samples = ${JSON.stringify(samples)};
        const list = document.getElementById("importedList");
        const board = document.getElementById("boardSelect");
        const input = document.getElementById("inputDevice");
        const output = document.getElementById("outputDevice");
        const monitor = document.getElementById("localPlaybackDevice");

        document.getElementById("libraryState").textContent = "6 sounds ready across 4 boards.";
        document.getElementById("mixState").textContent = "Mic and mix are live. Local monitor is on.";
        document.getElementById("routeState").textContent = "Signal ready: Realtek microphone → freqx mix → VB-CABLE.";
        document.getElementById("nowPlaying").textContent = "Airhorn / Stream";

        board.innerHTML = '<option>All boards</option><option>Stream</option><option>Reactions</option>';
        input.innerHTML = '<option>Microphone (Realtek Audio)</option>';
        output.innerHTML = '<option>CABLE Input (VB-Audio Virtual Cable)</option>';
        monitor.innerHTML = '<option>Headphones (USB Audio)</option>';

        list.innerHTML = "";
        for (const sample of samples) {
          const card = document.createElement("article");
          card.className = "imported-item" + (sample.favorite ? " favorite" : "") + (sample.pinned ? " pinned" : "");
          card.style.setProperty("--tone", sample.tone);
          card.innerHTML =
            '<button class="pad imported-pad" type="button">' +
              '<span class="pad-topline">' +
                '<span class="pad-tag">' + (sample.pinned ? "Pinned / " : sample.favorite ? "Favorite / " : "") + sample.board + '</span>' +
                '<span class="pad-key">' + sample.key + '</span>' +
              '</span>' +
              '<span class="imported-name">' + sample.name + '</span>' +
              '<span class="imported-meta">' + sample.size + ' / ' + sample.mode + '</span>' +
            '</button>' +
            '<div class="pad-volume-row">' +
              '<span class="pad-volume-icon">◖</span>' +
              '<input class="pad-volume-slider" type="range" value="' + sample.volume + '" style="--vol-pct:' + sample.volume + '%" />' +
              '<span class="pad-volume-label">' + sample.volume + '%</span>' +
            '</div>' +
            '<div class="imported-actions">' +
              '<button class="mixer-action" type="button">' + sample.key + '</button>' +
              '<button class="mixer-action' + (sample.favorite ? " active" : "") + '" type="button">' + (sample.favorite ? "Favorited" : "Favorite") + '</button>' +
              '<button class="mixer-action' + (sample.pinned ? " active" : "") + '" type="button">' + (sample.pinned ? "Pinned" : "Pin") + '</button>' +
              '<button class="mixer-action" type="button">Unbind</button>' +
              '<button class="mixer-action" type="button">Edit</button>' +
              '<button class="mixer-action imported-remove" type="button">Remove</button>' +
            '</div>';
          list.appendChild(card);
        }

        document.getElementById("meterFill").style.width = "62%";
        document.getElementById("meterFillFooter").style.width = "62%";
        document.getElementById("dbValue").textContent = "-8.4 dB";
        document.getElementById("dbValueFooter").textContent = "-8.4 dB";
        document.getElementById("hzValue").textContent = "184 Hz";
      })();
    `);
  });
}

app.whenReady().then(createPreviewWindow);
app.on("window-all-closed", () => app.quit());
