importScripts("lib/shared.js", "lib/docx.js");

// --- toolbar badge ------------------------------------------------------------------------

function setBadge(tabId, msg) {
  let text = "", color = "#5f6368", title = MT.APP;
  if (msg.inMeeting && msg.paused) {
    text = "II"; title = MT.APP + ": paused";
  } else if (msg.inMeeting && msg.captionsOn) {
    text = "REC"; color = "#d93025"; title = MT.APP + ": recording captions";
  } else if (msg.inMeeting) {
    text = "CC"; title = MT.APP + ": turn on captions to record";
  }
  chrome.action.setBadgeText({ tabId, text });
  chrome.action.setBadgeBackgroundColor({ tabId, color });
  chrome.action.setTitle({ tabId, title });
}

// --- saving .docx files -------------------------------------------------------------------
//
// Files go to <Downloads>/Meeting Transcripts/<YYYY-MM-DD>/ through chrome.downloads, which
// needs no folder permission and works from this service worker. A later save of the same
// meeting overwrites its file; if the name changed (renamed, more participants), the old
// file is deleted so each meeting has exactly one document.

const FOLDER = "Meeting Transcripts"; // "Meet Transcripts" before Teams and Zoom support

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return String(h);
}

function waitForDownload(downloadId) {
  return new Promise((resolve, reject) => {
    const done = (item) => {
      chrome.downloads.onChanged.removeListener(onChanged);
      if (item.state === "complete") resolve(item);
      else reject(new Error("Couldn't save the file" + (item.error ? ": " + item.error : "")));
    };
    const onChanged = async (delta) => {
      if (delta.id !== downloadId || !delta.state || delta.state.current === "in_progress") return;
      done((await chrome.downloads.search({ id: downloadId }))[0]);
    };
    chrome.downloads.onChanged.addListener(onChanged);
    chrome.downloads.search({ id: downloadId }).then(([item]) => item && item.state !== "in_progress" && done(item));
  });
}

const norm = (p) => p.replace(/\\/g, "/");

// "Meeting Transcripts/2026-10-11/<name>.docx", adding " (2)", " (3)"… if another meeting
// (say, a second call with the same people that day) already has that name.
// The saved-file records only (f:<id>), without loading every transcript.
async function fileRecords() {
  const { meetings = {} } = await chrome.storage.local.get("meetings");
  return chrome.storage.local.get(Object.keys(meetings).map((id) => "f:" + id));
}

async function uniquePath(id, day, base, avoid) {
  const all = await fileRecords();
  const taken = Object.entries(all)
    .filter(([k, f]) => k.startsWith("f:") && k !== "f:" + id && f && f.filename)
    .map(([, f]) => norm(f.filename).toLowerCase());
  if (avoid) taken.push(norm(avoid).toLowerCase()); // a new copy beside the call's own document
  for (let n = 1; ; n++) {
    const rel = `${FOLDER}/${day}/${base}${n > 1 ? ` (${n})` : ""}.docx`;
    if (!taken.some((f) => f.endsWith("/" + rel.toLowerCase()))) return rel;
  }
}

const saving = new Map(); // meeting id -> promise, so overlapping triggers share one save

function saveDoc(id, opts = {}) {
  if (!saving.has(id)) saving.set(id, doSave(id, opts).finally(() => saving.delete(id)));
  return saving.get(id);
}

// `final`: saved as the call ends. `mode` (asked for in the viewer, for a finished call's
// document): "replace" rewrites it, "copy" writes a new one beside it and leaves it alone.
async function doSave(id, { manual = false, final = false, mode = "replace" } = {}) {
  if (!manual && !(await MT.getSettings()).autoSave) return null;
  const meta = (await MT.listMeetings()).find((m) => m.id === id);
  const entries = await MT.getTranscript(id);
  if (!meta || !entries.length) return null;

  const prev = (await MT.getFile(id)) || {};
  const copy = manual && mode === "copy" && prev.downloadId;
  const rel = await uniquePath(id, MT.dayFolder(meta), MT.docName(meta), copy ? prev.filename : null);
  const blocks = MT.docBlocks(meta, entries);
  const h = hash(DOCX.FORMAT + rel + JSON.stringify(blocks)); // a new format rewrites the file
  if (prev.downloadId && prev.hash === h && !prev.error && !manual) {
    if (final && !prev.final) await MT.setFile(id, { ...prev, final: true });
    return prev;
  }
  // The call is over and its document may hold the user's own edits: leave it, and let the
  // viewer offer to update it.
  if (!manual && MT.isSettled(meta, prev)) {
    if (!prev.outdated) await MT.setFile(id, { ...prev, outdated: true });
    return prev;
  }

  try {
    if (prev.downloadId && !copy) {
      const [old] = await chrome.downloads.search({ id: prev.downloadId });
      if (old && old.exists && !norm(old.filename).endsWith("/" + rel)) await chrome.downloads.removeFile(old.id).catch(() => {});
      await chrome.downloads.erase({ id: prev.downloadId });
    }
    // Automatic saves happen mid-call; keep Chrome's download bubble out of the way.
    if (!manual) await chrome.downloads.setUiOptions({ enabled: false }).catch(() => {});
    let item;
    try {
      const downloadId = await chrome.downloads.download({
        url: DOCX.dataUrl(await DOCX.build(blocks)),
        filename: rel,
        conflictAction: "overwrite",
        saveAs: false,
      });
      item = await waitForDownload(downloadId);
    } finally {
      if (!manual) await chrome.downloads.setUiOptions({ enabled: true }).catch(() => {});
    }
    const result = { downloadId: item.id, filename: item.filename, savedAt: Date.now(), hash: h, error: null,
      final: final || !!prev.final || (manual && MT.isSettled(meta, prev)), outdated: false };
    await MT.setFile(id, result);
    return result;
  } catch (err) {
    // With Chrome's "Ask where to save each file" on, every save opens a dialog; closing it
    // (or saving while nobody is at the screen) cancels the download.
    const askSetting = /USER_CANCELED/.test(err.message);
    const error = askSetting
      ? "Chrome asked where to save the file and the dialog was closed. To save automatically, turn off " +
        "\u201cAsk where to save each file before downloading\u201d in Chrome\u2019s download settings."
      : err.message;
    await MT.setFile(id, { ...prev, error, askSetting });
    throw new Error(error);
  }
}

// --- when to save -------------------------------------------------------------------------
//
// A meeting is saved when its tab closes, when the user leaves the call, or after IDLE_MIN
// minutes without new captions (so a crash loses little). Later captions update the file.

const IDLE_MIN = 2;

// Files saved by older versions used other names/folders. Re-save them once in the current
// layout. Runs whenever the worker starts, so it doesn't depend on Chrome reporting the update.
const LAYOUT = 4; // 2: one folder per day, "Call with …"; 3: "Meeting Transcripts" instead of "Meet Transcripts";
                  // 4: compressed .docx, names without icon glyphs or doubled names

// Documents of finished calls are the user's (see MT.isSettled) and stay where they are: the
// new layout applies to calls still being recorded and to documents saved from now on.
async function migrateFiles() {
  if ((await chrome.storage.local.get("fileLayout")).fileLayout === LAYOUT) return; // the usual case: one small read
  for (const [key, f] of Object.entries(await fileRecords())) {
    if (key.startsWith("f:") && f && f.downloadId) await saveDoc(key.slice(2)).catch(() => {});
  }
  await chrome.storage.local.set({ fileLayout: LAYOUT });
}
migrateFiles();

// --- library.json: the history, kept in the folder ---------------------------------------
//
// Downloads/Meeting Transcripts/library.json holds every meeting (title, participants, every
// line with speaker and time) and your settings, rewritten a few seconds after anything
// changes. Removing the extension clears Chrome's copy; Import in the transcripts page reads
// this file (and the .docx files) back.
//
// A fresh install must not overwrite a good library.json with a nearly empty library: until
// the history is imported (or you choose to start fresh, "libraryReady"), it writes
// "library (since reinstall).json" instead. Import reads both and then keeps one. A library
// with no calls is never written at all: it has nothing to keep, and must not replace one.

const LIBRARY_FILE = FOLDER + "/library.json";
const INTERIM_FILE = FOLDER + "/library (since reinstall).json";
const BACKED_UP = ["hideCaptions", "myName", "autoSave", "showIndicator", "platforms", "nameMap"]; // not "paused": that's momentary
let libraryTimer = null;

async function writeLibraryFile() {
  const all = await chrome.storage.local.get(null);
  if (!Object.keys(all.meetings || {}).length) return; // nothing to keep, and never an empty library over a full one
  const filename = all.libraryReady ? LIBRARY_FILE : INTERIM_FILE;
  const idKey = all.libraryReady ? "libraryDownloadId" : "interimDownloadId";
  const settings = Object.fromEntries(BACKED_UP.filter((k) => all.settings && k in all.settings).map((k) => [k, all.settings[k]]));
  const transcripts = {}, files = {};
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith("t:")) transcripts[k.slice(2)] = v;
    if (k.startsWith("f:")) files[k.slice(2)] = v;
  }
  const json = JSON.stringify({ app: "meet-transcripts", kind: "library", version: 1, savedAt: Date.now(),
    settings, meetings: all.meetings || {}, transcripts, files });
  const bytes = new TextEncoder().encode(json);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  await chrome.downloads.setUiOptions({ enabled: false }).catch(() => {});
  try {
    const id = await chrome.downloads.download({
      url: "data:application/json;base64," + btoa(bin), filename, conflictAction: "overwrite", saveAs: false,
    });
    const written = await waitForDownload(id);
    if (all[idKey] && all[idKey] !== id) {
      // The same file, overwritten; or one in the old "Meet Transcripts" folder, now moved.
      const [old] = await chrome.downloads.search({ id: all[idKey] });
      if (old && old.exists && norm(old.filename) !== norm(written.filename)) await chrome.downloads.removeFile(old.id).catch(() => {});
      await chrome.downloads.erase({ id: all[idKey] }).catch(() => {});
    }
    await chrome.storage.local.set({ [idKey]: id, librarySavedAt: Date.now() });
    // Once library.json holds everything, the interim file has served its purpose. Find it in
    // Chrome's download history: an earlier install may have written it.
    if (all.libraryReady) {
      const stale = await chrome.downloads.search({ filenameRegex: "library \\(since reinstall\\)\\.json$", exists: true });
      for (const item of stale) {
        await chrome.downloads.removeFile(item.id).catch(() => {});
        await chrome.downloads.erase({ id: item.id }).catch(() => {});
      }
      await chrome.storage.local.remove("interimDownloadId");
    }
  } catch {
    // e.g. Chrome set to ask where to save each file; the .docx warning already covers that.
  } finally {
    await chrome.downloads.setUiOptions({ enabled: true }).catch(() => {});
  }
}

const isHistoryKey = (k) => k === "meetings" || k === "settings" || k === "libraryReady" || k.startsWith("t:") || k.startsWith("f:");

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !Object.keys(changes).some(isHistoryKey)) return;
  if (changes.settings && !changes.meetings && !Object.keys(changes).some((k) => k.startsWith("t:"))) {
    const before = changes.settings.oldValue || {}, after = changes.settings.newValue || {};
    if (!BACKED_UP.some((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))) return; // only "paused" moved
  }
  // A transcript updated in place means a call is being recorded.
  scheduleLibraryWrite(Object.entries(changes).some(([k, c]) => k.startsWith("t:") && c.oldValue && c.newValue));
});

// Writing the library reads all of it and builds the file in memory. While a call is being
// recorded (its captions change all the time) it's written at most every 30 s; other changes
// (a rename, a deletion, a setting) within 3 s. The last state is always written: any change
// after a write schedules the next one.
let lastLibraryWrite = 0, libraryDue = 0;
function scheduleLibraryWrite(recording) {
  const wait = recording ? Math.max(3000, 30_000 - (Date.now() - lastLibraryWrite)) : 3000;
  if (libraryTimer && libraryDue <= Date.now() + wait) return; // already due sooner
  clearTimeout(libraryTimer);
  libraryDue = Date.now() + wait;
  libraryTimer = setTimeout(async () => {
    libraryTimer = null;
    lastLibraryWrite = Date.now();
    await writeLibraryFile();
  }, wait);
}

// 2.4 could sync through a folder, writing Meeting Transcripts/devices/<id>.json instead of
// library.json. That's gone (Export and Import in the library replace it): forget its state, so
// library.json is written again; a devices/ file can still be imported.
chrome.storage.local.get("sync").then(({ sync }) => {
  if (sync) chrome.storage.local.remove(["sync", "deleted", "deviceFileDownloadId"]).then(settleLibraryReady)
    .then(() => scheduleLibraryWrite(false));
});

// Whether this install may write library.json. A fresh install says no (libraryReady false)
// until you import or start fresh. Installs from before that flag existed (undefined) may, if
// they've written library.json themselves or there's none in the folder; not when there's one
// they didn't write, which is someone's history waiting to be imported.
async function settleLibraryReady() {
  const all = await chrome.storage.local.get(["meetings", "libraryReady", "libraryDownloadId"]);
  if (all.libraryReady !== undefined || !Object.keys(all.meetings || {}).length) return;
  if (!all.libraryDownloadId) {
    const theirs = await chrome.downloads.search({ filenameRegex: "Meeting Transcripts[\\\\/]library\\.json$", exists: true }).catch(() => []);
    if (theirs.length) return chrome.storage.local.set({ libraryReady: false });
  }
  await chrome.storage.local.set({ libraryReady: true });
}
settleLibraryReady();

// After a fresh install, open the transcripts page so a previous library can be imported. An
// update keeps whatever the library was; it doesn't make an unimported one "ready".
chrome.runtime.onInstalled.addListener(async ({ reason, previousVersion }) => {
  // Before 2.6.0, hiding captions left an empty strip in the call, so many turned it off.
  // It now gives the video that space: switch it on once for everyone (it's on by default).
  const [major, minor] = (previousVersion || "").split(".").map(Number);
  if (reason === "update" && (major < 2 || (major === 2 && minor < 6))) {
    const { settings } = await chrome.storage.local.get("settings");
    if (settings && settings.hideCaptions === false) await MT.saveSettings({ hideCaptions: true });
  }
  if (reason !== "install") return;
  const { libraryReady } = await chrome.storage.local.get("libraryReady");
  if (libraryReady === undefined) await chrome.storage.local.set({ libraryReady: false });
  chrome.tabs.create({ url: chrome.runtime.getURL("viewer/viewer.html#welcome") });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name.startsWith("save:")) saveDoc(alarm.name.slice(5)).catch(() => {});
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const key = "tab:" + tabId;
  const id = (await chrome.storage.session.get(key))[key];
  if (!id) return;
  await chrome.storage.session.remove(key);
  chrome.alarms.clear("save:" + id);
  saveDoc(id, { final: true }).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const tabId = sender.tab && sender.tab.id;
  switch (msg.type) {
    case "status":
      if (tabId) setBadge(tabId, msg);
      return false;
    case "meetingSaved":
      if (tabId) chrome.storage.session.set({ ["tab:" + tabId]: msg.id });
      chrome.alarms.create("save:" + msg.id, { delayInMinutes: IDLE_MIN });
      // Rejoined (the same transcript goes on): its document is live again until the call ends.
      MT.getFile(msg.id).then((f) => f && f.final && MT.setFile(msg.id, { ...f, final: false }));
      return false;
    case "meetingEnded":
      chrome.alarms.clear("save:" + msg.id);
      saveDoc(msg.id, { final: true }).catch(() => {});
      return false;
    case "resave": // renamed in the viewer: bring an already saved file up to date
      MT.getFile(msg.id).then((f) => f && f.downloadId && saveDoc(msg.id).catch(() => {}));
      return false;
    case "saveNow":
      saveDoc(msg.id, { manual: true, mode: msg.mode })
        .then((r) => reply({ ok: true, result: r }), (e) => reply({ ok: false, error: e.message }));
      return true;
    case "openDownloadSettings":
      chrome.tabs.create({ url: "chrome://settings/downloads" });
      return false;
    case "showFile":
      chrome.downloads.search({ id: msg.downloadId || -1 }).then(([item]) => {
        if (item && item.exists) chrome.downloads.show(item.id);
        else chrome.downloads.showDefaultFolder();
      });
      return false;
  }
  return false;
});
