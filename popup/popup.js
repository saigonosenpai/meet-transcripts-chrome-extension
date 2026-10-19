const $ = (id) => document.getElementById(id);
let tab = null;
let current = null;

// Pages the recorder runs on, matching the manifest's content scripts.
const CALL_PAGES = /^https:\/\/(meet\.google\.com|teams\.microsoft\.com|teams\.live\.com|teams\.cloud\.microsoft|([\w-]+\.)?zoom\.us\/wc)\//;

async function refresh() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  current = null;
  if (tab && CALL_PAGES.test(tab.url || "")) {
    try { current = await chrome.tabs.sendMessage(tab.id, { type: "getStatus" }); } catch {}
  }
  render();
}

// The status card's colour follows the state: blue when idle, red while recording, orange when attention is needed.
function setTone(tone) {
  $("status").dataset.tone = tone;
}

let copiedAt = 0; // when a report was last copied, to keep "Copied." on screen a moment

function render() {
  const dot = $("dot"), state = $("state"), detail = $("detail");
  dot.className = "dot";
  setTone("idle");
  $("meetActions").hidden = !current || !current.inMeeting;
  // A report can be copied any time in a call; it's offered as the fix when nothing is recorded.
  $("diagnose").hidden = !current || !current.inMeeting;
  if (current && current.inMeeting && Date.now() - copiedAt > 4000) {
    $("diagnose").textContent = current.paused || (current.captionsOn && current.count > 0 && !current.stuck)
      ? "Copy a report for troubleshooting" : "Captions not being picked up? Copy a report";
  }
  if (!current) {
    state.textContent = "Not in a call";
    detail.textContent = tab && CALL_PAGES.test(tab.url || "")
      ? "Reload this tab so the recorder can start."
      : "Join a Google Meet, Teams or Zoom call in Chrome and its captions are recorded automatically.";
    return;
  }
  const where = MT.PLATFORMS[current.platform].name;
  if (current.disabled) {
    setTone("off");
    state.textContent = "Not recording " + where;
    detail.textContent = "Turned off below, under Record calls in.";
    return;
  }
  if (!current.inMeeting) {
    state.textContent = "Waiting for a call";
    detail.textContent = "";
    return;
  }
  $("pause").textContent = current.paused ? "Resume" : "Pause";
  $("viewCurrent").disabled = !current.meetingId;
  if (current.paused) {
    setTone("warn");
    dot.classList.add("warn");
    state.textContent = "Paused";
  } else if (current.stuck) {
    setTone("warn");
    dot.classList.add("warn");
    state.textContent = "Captions on · nothing recorded";
    detail.textContent = "The captions on screen aren't being picked up, probably because the call page changed. Copy a report below and send it in.";
    return;
  } else if (current.captionsOn) {
    setTone("rec");
    dot.classList.add("rec");
    state.textContent = "Recording · " + MT.PLATFORMS[current.platform].short;
  } else {
    setTone("warn");
    dot.classList.add("warn");
    state.textContent = "Captions are off";
  }
  detail.textContent = current.captionsOn || current.count
    ? `${current.title} · ${current.count} line${current.count === 1 ? "" : "s"} captured`
    : current.captionHint + " The transcript comes from the call's live captions.";
}

// The meetings and their saved-file records (f:<id>), without loading every transcript.
async function libraryRecords() {
  const base = await chrome.storage.local.get(["meetings", "libraryDownloadId", "librarySavedAt"]);
  base.backupId = base.libraryDownloadId;
  const files = await chrome.storage.local.get(Object.keys(base.meetings || {}).map((id) => "f:" + id));
  return { ...base, ...files };
}

async function fileRecords() {
  const all = await libraryRecords();
  return Object.entries(all).filter(([k]) => k.startsWith("f:")).map(([, v]) => v);
}

async function latestFile() {
  return (await fileRecords()).filter((f) => f.downloadId).sort((a, b) => b.savedAt - a.savedAt)[0] || null;
}

async function renderFiles() {
  const f = await latestFile();
  const name = f ? f.filename.split(/[\\/]/).pop().replace(/^\d{4}-\d{2}-\d{2} - /, "").replace(/\.docx$/, "") : "";
  $("lastSaved").textContent = name ? `Last saved: ${name}.` : "";
  const blocked = (await fileRecords()).some((r) => r.error && r.askSetting);
  $("askWarning").hidden = !blocked;
}

// --- the library at a glance ---------------------------------------------------------------

function bytes(n) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return Math.round(n / 1024) + " KB";
  return (n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0) + " MB";
}

function hours(ms) {
  const mins = Math.round(ms / 60000);
  if (mins < 1) return ms > 0 ? "<1 min" : "0 min";
  if (mins < 60) return mins + " min";
  return (mins / 60).toFixed(mins < 600 ? 1 : 0).replace(/\.0$/, "") + " h";
}

function ago(ts) {
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return mins + " min ago";
  if (mins < 60 * 24) return Math.round(mins / 60) + " h ago";
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

async function renderStats() {
  const all = await libraryRecords();
  const meetings = Object.values(all.meetings || {});
  $("calls").textContent = meetings.length;
  $("recorded").textContent = hours(meetings.reduce((t, m) => t + Math.max(0, (m.endedAt || m.startedAt) - m.startedAt), 0));

  // What's actually on disk: the saved documents that still exist, plus library.json.
  const ids = Object.entries(all).filter(([k, f]) => k.startsWith("f:") && f && f.downloadId).map(([, f]) => f.downloadId);
  if (all.backupId) ids.push(all.backupId);
  const items = (await Promise.all(ids.map((id) => chrome.downloads.search({ id }).catch(() => [])))).flat()
    .filter((i) => i && i.exists && i.state === "complete");
  $("size").textContent = bytes(items.reduce((t, i) => t + (i.fileSize > 0 ? i.fileSize : i.totalBytes > 0 ? i.totalBytes : 0), 0));
  const docs = items.filter((i) => i.id !== all.backupId).length;

  const counts = Object.entries(MT.PLATFORMS)
    .map(([id, p]) => [p.short, meetings.filter((m) => MT.platformOf(m) === id).length])
    .filter(([, n]) => n).map(([name, n]) => `${name} ${n}`);
  const parts = [];
  if (counts.length) parts.push(counts.join(" · "));
  parts.push(`${docs} Word document${docs === 1 ? "" : "s"}`);
  if (all.librarySavedAt && items.some((i) => i.id === all.backupId)) parts.push(`backup saved ${ago(all.librarySavedAt)}`);
  $("statsDetail").textContent = meetings.length ? parts.join(" · ") + "." : "";
}

async function init() {
  $("version").textContent = "v" + chrome.runtime.getManifest().version;
  const s = await MT.getSettings();
  $("hideCaptions").checked = s.hideCaptions;
  $("showIndicator").checked = s.showIndicator;
  $("myName").value = s.myName;
  for (const box of document.querySelectorAll(".platform")) {
    box.checked = s.platforms[box.dataset.platform] !== false;
    box.addEventListener("change", async () => {
      const { platforms } = await MT.getSettings();
      await MT.saveSettings({ platforms: { ...platforms, [box.dataset.platform]: box.checked } });
      setTimeout(refresh, 150);
    });
  }
  $("diagnose").addEventListener("click", async () => {
    let report;
    try { report = await chrome.tabs.sendMessage(tab.id, { type: "diagnose" }); } catch {}
    await navigator.clipboard.writeText(JSON.stringify(report || { error: "the page didn't answer" }, null, 2));
    $("diagnose").textContent = "Copied. Paste it into a GitHub issue (it has no transcript text).";
    copiedAt = Date.now();
  });
  for (const id of ["hideCaptions", "showIndicator"]) {
    $(id).addEventListener("change", (e) => MT.saveSettings({ [id]: e.target.checked }));
  }
  $("myName").addEventListener("input", (e) => MT.saveSettings({ myName: e.target.value.trim() }));
  // Its keyboard shortcut, as set in Chrome (none if the user removed it).
  chrome.commands.getAll().then((cmds) => {
    const key = (cmds.find((c) => c.name === "toggle-pause") || {}).shortcut;
    $("pause").title = key ? `Pause or resume recording (${key})` : "Pause or resume recording";
  });
  $("pause").addEventListener("click", async () => {
    await MT.saveSettings({ paused: !(await MT.getSettings()).paused });
    setTimeout(refresh, 100);
  });
  $("viewCurrent").addEventListener("click", async () => {
    try { await chrome.tabs.sendMessage(tab.id, { type: "flush" }); } catch {}
    chrome.tabs.create({ url: chrome.runtime.getURL("viewer/viewer.html#" + encodeURIComponent(current.meetingId)) });
  });
  $("openViewer").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("viewer/viewer.html") }));

  $("autoSave").checked = s.autoSave;
  $("autoSave").addEventListener("change", (e) => MT.saveSettings({ autoSave: e.target.checked }));
  $("showFolder").addEventListener("click", async () => {
    const f = await latestFile();
    chrome.runtime.sendMessage({ type: "showFile", downloadId: f && f.downloadId });
  });
  $("dlSettings").addEventListener("click", () => chrome.runtime.sendMessage({ type: "openDownloadSettings" }));
  $("statCalls").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("viewer/viewer.html") }));
  $("statSize").addEventListener("click", async () => {
    const f = await latestFile();
    chrome.runtime.sendMessage({ type: "showFile", downloadId: f && f.downloadId });
  });
  renderFiles();
  renderStats();
  await refresh();
  setInterval(refresh, 2000);
}

init();
