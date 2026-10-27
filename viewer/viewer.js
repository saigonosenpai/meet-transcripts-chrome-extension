const $ = (id) => document.getElementById(id);
// Apple system colors, readable behind white initials in light and dark.
const COLORS = ["#007aff", "#ff9500", "#34c759", "#af52de", "#ff2d55", "#5ac8fa", "#a2845e", "#5856d6"];

let meetings = [];
let current = null;   // meeting meta
let entries = [];
let filter = "all";
let query = "";
let libQuery = "";
let libIndex = null;  // id -> lowercased transcript text, built on first library search

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// Matches are found in the text as written, then each piece is escaped: searching "a" in
// "Tom & Jerry" must not match inside the "&amp;" the escaping adds.
function highlight(text) {
  if (!query) return esc(text);
  const re = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
  return text.split(re).map((piece, i) => (i % 2 ? `<mark>${esc(piece)}</mark>` : esc(piece))).join("");
}

const initials = (name) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";

const avatar = (name, color) => `<span class="avatar" style="--c:${color}">${esc(initials(name))}</span>`;

// A toast that rises from the bottom; with `action`, it offers one button (e.g. Undo) and stays longer.
function toast(msg, action) {
  const t = $("toast"), btn = $("toastAction");
  $("toastText").textContent = msg;
  btn.hidden = !action;
  btn.onclick = null;
  if (action) {
    btn.textContent = action.label;
    btn.onclick = () => { hideToast(); action.run(); };
  }
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(hideToast, action ? 6000 : 2200);
}

function hideToast() {
  clearTimeout(toast.timer);
  $("toast").classList.remove("show");
}

// --- library ------------------------------------------------------------------------------

async function loadLibrary() {
  meetings = await MT.listMeetings();
  renderList();
}

async function buildIndex() {
  const all = await chrome.storage.local.get(null);
  libIndex = {};
  for (const m of meetings) {
    libIndex[m.id] = (MT.title(m) + " " + (m.speakers || []).join(" ") + " " +
      (all["t:" + m.id] || []).map((e) => e.text).join(" ")).toLowerCase();
  }
}

function renderList() {
  const list = $("list");
  const q = libQuery.toLowerCase();
  const shown = meetings.filter((m) => !q || (libIndex && libIndex[m.id]
    ? libIndex[m.id].includes(q)
    : (MT.title(m) + " " + (m.speakers || []).join(" ")).toLowerCase().includes(q)));
  $("emptyLib").hidden = meetings.length > 0;
  let lastDay = "";
  list.innerHTML = "";
  for (const m of shown) {
    const day = new Date(m.startedAt).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
    if (day !== lastDay) {
      const d = document.createElement("li");
      d.className = "day";
      d.textContent = day;
      list.append(d);
      lastDay = day;
    }
    const li = document.createElement("li");
    li.className = current && current.id === m.id ? "on" : "";
    const time = new Date(m.startedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    li.tabIndex = 0;
    li.innerHTML = `<div class="t"></div><div class="s"></div>`;
    li.querySelector(".t").textContent = MT.title(m);
    li.querySelector(".s").textContent = `${time} · ${MT.PLATFORMS[MT.platformOf(m)].short} · ${MT.duration(m)} · ` +
      `${(m.speakers || []).length} speaker${(m.speakers || []).length === 1 ? "" : "s"}`;
    li.addEventListener("click", () => { location.hash = encodeURIComponent(m.id); });
    li.addEventListener("keydown", (e) => { if (e.key === "Enter") location.hash = encodeURIComponent(m.id); });
    list.append(li);
  }
  if (q && !shown.length) list.innerHTML = `<li class="day">No meetings match</li>`;
}

// --- one meeting --------------------------------------------------------------------------

async function openMeeting(id) {
  current = meetings.find((m) => m.id === id) || null;
  $("placeholder").hidden = !!current;
  $("meeting").hidden = !current;
  renderList();
  if (!current) return;
  entries = await MT.getTranscript(id);
  document.title = MT.title(current) + " · " + MT.APP;
  // Turns rise in when a meeting opens, not on every live update.
  const list = $("transcript");
  list.classList.add("entering");
  setTimeout(() => list.classList.remove("entering"), 400);
  renderMeeting();
  document.querySelector("main").scrollTo(0, 0);
  requestAnimationFrame(placeThumb);
}

function speakerColors() {
  const map = {};
  (current.speakers || []).forEach((s, i) => (map[s] = COLORS[i % COLORS.length]));
  return map;
}

function renderMeeting() {
  const colors = speakerColors();
  $("title").textContent = MT.title(current);
  $("meta").textContent = `${MT.platformName(current)} · ${MT.dateTime(current.startedAt)} · ${MT.duration(current)}`;

  // Talk share by word count.
  const wordsBy = {};
  let total = 0;
  for (const e of entries) {
    const n = e.text.split(/\s+/).length;
    wordsBy[e.speaker] = (wordsBy[e.speaker] || 0) + n;
    total += n;
  }
  $("speakers").innerHTML = Object.entries(wordsBy).sort((a, b) => b[1] - a[1]).map(([s, n]) => {
    const pct = Math.round((n / total) * 100);
    return `<button class="spk" data-name="${esc(s)}" aria-haspopup="dialog" aria-expanded="false" ` +
      `title="${esc(s)} spoke ${pct}% of the words. Click to rename.">${avatar(s, colors[s] || COLORS[0])}` +
      `${esc(s)}<span class="pct">${pct}%</span></button>`;
  }).join("");

  renderTranscript();
  renderFile();
}

const DOC_ICON = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 1.5h-5a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V4.5z"/><path d="M9.5 1.5v3h3M5.5 8.5h5M5.5 11h5"/></svg>`;

function savedWhen(ts) {
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  return new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

async function renderFile() {
  const f = await MT.getFile(current.id);
  let html = "";
  if (f && f.downloadId) {
    const name = f.filename.split(/[\\/]/).pop();
    html += `<span class="doc" title="${esc(f.filename)}">${DOC_ICON}<span>Saved as <b>${esc(name)}</b></span></span>` +
      `<span class="sep">·</span><span>${esc(savedWhen(f.savedAt))}</span>` +
      `<button id="showFile" class="btn link">Show in folder</button>`;
  } else if (current.syncedFrom) {
    html += `<span class="doc" title="Imported from a library exported on that computer; its Word document is on that computer">${DOC_ICON}` +
      `<span>Recorded on <b>${esc(current.syncedFrom)}</b></span></span>`;
  } else if (current.importedFrom) {
    html += `<span class="doc" title="${esc(current.importedFrom)}">${DOC_ICON}<span>Restored from <b>${esc(current.importedFrom)}</b></span></span>`;
  } else {
    html += `<span class="doc">${DOC_ICON}<span>Not saved as a Word document yet</span></span>`;
  }
  // A finished call's document may hold the user's edits: rewriting it is a choice, not a click.
  const settled = MT.isSettled(current, f);
  if (f && f.outdated) html += `<span class="sep">·</span><span class="stale" title="The call was renamed, or speakers, after this document was saved. It isn't rewritten automatically, in case you edited it in Word.">Changed since</span>`;
  html += settled
    ? `<span class="menu inline"><button id="saveNow" class="btn link" aria-haspopup="menu" aria-expanded="false">${f.outdated ? "Update .docx…" : "Save again…"}</button>` +
      `<div id="saveMenu" class="popover" role="menu">` +
      `<button data-mode="copy" role="menuitem">Save as a new copy<span>keeps this one</span></button>` +
      `<button data-mode="replace" role="menuitem">Replace this document<span>edits made in Word are lost</span></button></div></span>`
    : `<button id="saveNow" class="btn link">${f && f.downloadId ? "Save again" : "Save .docx"}</button>`;
  if (f && f.error) html += `<span class="err">${esc(f.error)}</span>`;
  if (f && f.error && f.askSetting) html += `<button id="dlSettings" class="btn link">Open Chrome download settings</button>`;
  $("file").innerHTML = html;
  if ($("dlSettings")) $("dlSettings").addEventListener("click", () =>
    chrome.runtime.sendMessage({ type: "openDownloadSettings" }));
  if ($("showFile")) $("showFile").addEventListener("click", () =>
    chrome.runtime.sendMessage({ type: "showFile", downloadId: f.downloadId }));
  const btn = $("saveNow");
  const save = async (mode) => {
    btn.disabled = true;
    btn.textContent = "Saving…";
    const r = await chrome.runtime.sendMessage({ type: "saveNow", id: current.id, mode });
    toast(r.ok ? (mode === "copy" ? "Saved as a new copy; the earlier document is kept" : "Saved to Downloads/Meeting Transcripts")
      : "Couldn't save: " + r.error);
    renderFile();
  };
  if (!settled) return btn.addEventListener("click", () => save("replace"));
  const menu = $("saveMenu");
  const show = (open) => { if (open) keepInWindow(menu); menu.classList.toggle("open", open); btn.setAttribute("aria-expanded", String(open)); };
  btn.addEventListener("click", (e) => { e.stopPropagation(); show(!menu.classList.contains("open")); });
  menu.addEventListener("click", (e) => {
    const mode = e.target.closest("button")?.dataset.mode;
    if (mode) { show(false); save(mode); }
  });
}

function renderTranscript() {
  const colors = speakerColors();
  const q = query.toLowerCase();
  let turns;
  if (filter === "all") {
    turns = q ? MT.groupTurns(entries) : MT.timeline(current, entries); // gaps only in the full transcript
  } else {
    // Sentence-level filters: each matching sentence stands on its own.
    turns = MT.highlights(entries, filter).map((h) => ({ speaker: h.speaker, ts: h.ts, lines: [{ text: h.text }] }));
  }
  if (q) turns = turns.filter((t) => t.lines.some((l) => l.text.toLowerCase().includes(q)) || t.speaker.toLowerCase().includes(q));
  const count = turns.filter((t) => t.kind !== "gap").length;

  const note = $("filterNote");
  note.hidden = filter === "all" && !q;
  note.textContent = filter === "all"
    ? `${count} matching turn${count === 1 ? "" : "s"}`
    : `${count} ${MT.FILTERS[filter].label.toLowerCase()} · picked out by keywords, so skim them in context`;

  const recent = Date.now() - current.endedAt < 15_000;
  $("transcript").innerHTML = turns.map((t, i) => {
    if (t.kind === "gap") return `<div class="gap" role="separator">${esc(MT.gapText(current, t))}</div>`;
    const isLive = recent && i === turns.length - 1 && filter === "all" && !q;
    return `<div class="turn">${avatar(t.speaker, colors[t.speaker] || COLORS[0])}<div>` +
      `<div class="head"><span class="who">${esc(t.speaker)}</span>` +
      `<time title="${esc(new Date(t.ts).toLocaleTimeString())}">${MT.clock(t.ts - current.startedAt)}</time>` +
      `${isLive ? '<span class="live-pill">Live</span>' : ""}</div>` +
      `<p>${highlight(t.lines.map((l) => l.text).join(" "))}</p></div></div>`;
  }).join("") || `<div class="empty-state"><strong>Nothing here</strong>${
    q ? "No lines match your search." : "No sentences matched this filter."}</div>`;
}

// --- actions ------------------------------------------------------------------------------

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const fileBase = () => MT.docName(current);

async function copy(text, msg) {
  await navigator.clipboard.writeText(text);
  toast(msg);
}

const aiPrompt = (meta) => `Below is a transcript of a ${MT.platformName(meta)} call, generated from live captions (expect some recognition errors). Please give me:
1. A 3–5 sentence summary
2. Key points and decisions
3. Action items, with owners and deadlines where mentioned
4. Open questions or unresolved issues

---

`;

// Slides the segmented control's thumb under the selected option.
function placeThumb() {
  const on = $("filters").querySelector("button.on");
  const thumb = $("filters").querySelector(".thumb");
  if (!on || !on.offsetWidth) return;
  thumb.style.width = on.offsetWidth + "px";
  thumb.style.transform = `translateX(${on.offsetLeft}px)`;
}

// A pop-up opens next to its button; in a narrow window, where the buttons wrap, that can be
// past the window's edge: nudge it back in (measured from layout, not from its opening animation).
function keepInWindow(pop) {
  pop.style.translate = "";
  if (!pop.offsetParent) return;
  const left = pop.offsetParent.getBoundingClientRect().left + pop.offsetLeft, right = left + pop.offsetWidth, m = 8;
  const dx = left < m ? m - left : right > innerWidth - m ? Math.max(m - left, innerWidth - m - right) : 0;
  if (dx) pop.style.translate = `${Math.round(dx)}px 0`;
}

function setMenu(open) {
  if (open) keepInWindow($("exportMenu"));
  $("exportMenu").classList.toggle("open", open);
  $("exportBtn").setAttribute("aria-expanded", String(open));
}

function bindActions() {
  $("search").addEventListener("input", (e) => { query = e.target.value.trim(); renderTranscript(); });
  $("filters").addEventListener("pointerdown", (e) => {
    // Select on press: the thumb starts moving the moment the finger lands.
    const b = e.target.closest("button");
    if (!b || b.classList.contains("on")) return;
    filter = b.dataset.filter;
    for (const x of $("filters").querySelectorAll("button")) {
      x.classList.toggle("on", x === b);
      x.setAttribute("aria-pressed", String(x === b));
    }
    placeThumb();
    renderTranscript();
  });
  $("filters").addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") e.target.closest("button")?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  });
  window.addEventListener("resize", placeThumb);
  document.querySelector("main").addEventListener("scroll", (e) =>
    e.target.classList.toggle("scrolled", e.target.scrollTop > 8), { passive: true });

  $("title").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); e.target.blur(); } });
  $("title").addEventListener("blur", async (e) => {
    const title = e.target.textContent.trim();
    if (!title || title === MT.title(current)) { e.target.textContent = MT.title(current); return; }
    current.renamed = true;
    current.title = title;
    await MT.updateMeeting(current.id, { title, renamed: true });
    chrome.runtime.sendMessage({ type: "resave", id: current.id });
    toast("Renamed");
  });

  $("copyAI").addEventListener("click", () => copy(aiPrompt(current) + MT.toText(current, entries), "Copied — paste into your AI chat"));

  // Rename a speaker: click their chip.
  let renaming = null;
  const closeRename = () => {
    $("renameBox").classList.remove("open");
    if (renaming) renaming.setAttribute("aria-expanded", "false");
    renaming = null;
  };
  $("speakers").addEventListener("click", (e) => {
    const chip = e.target.closest("button.spk");
    if (!chip) return;
    e.stopPropagation();
    if (renaming === chip) return closeRename();
    closeRename();
    renaming = chip;
    chip.setAttribute("aria-expanded", "true");
    const box = $("renameBox");
    box.style.left = chip.offsetLeft + "px";
    box.style.top = chip.offsetTop + chip.offsetHeight + 6 + "px";
    $("renameFrom").textContent = chip.dataset.name;
    $("renameInput").value = chip.dataset.name;
    $("renameFuture").checked = false;
    keepInWindow(box);
    box.classList.add("open");
    $("renameInput").focus();
    $("renameInput").select();
  });
  $("renameBox").addEventListener("click", (e) => e.stopPropagation());
  $("renameCancel").addEventListener("click", closeRename);
  $("renameBox").addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); closeRename(); } });
  $("renameBox").addEventListener("submit", async (e) => {
    e.preventDefault();
    const from = renaming && renaming.dataset.name, to = $("renameInput").value.trim(), future = $("renameFuture").checked;
    closeRename();
    if (!from || !to || to === from) return;
    await MT.renameSpeaker(current.id, from, to, future);
    chrome.runtime.sendMessage({ type: "resave", id: current.id });
    toast(future ? `Renamed to “${to}”, here and in future calls` : `Renamed to “${to}”`);
  });
  document.addEventListener("click", closeRename);

  $("exportBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    setMenu(!$("exportMenu").classList.contains("open"));
  });
  document.addEventListener("click", () => setMenu(false));
  // The Save menu of a finished call's document (rebuilt with the file line).
  const closeSaveMenu = () => { $("saveMenu")?.classList.remove("open"); $("saveNow")?.setAttribute("aria-expanded", "false"); };
  document.addEventListener("click", closeSaveMenu);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSaveMenu(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") setMenu(false); });
  $("exportMenu").addEventListener("click", async (e) => {
    const kind = e.target.closest("button")?.dataset.export;
    setMenu(false);
    if (kind === "docx") download(fileBase() + ".docx", await DOCX.build(MT.docBlocks(current, entries)), DOCX.MIME);
    if (kind === "md") download(fileBase() + ".md", MT.toMarkdown(current, entries), "text/markdown");
    if (kind === "txt") download(fileBase() + ".txt", MT.toText(current, entries), "text/plain");
    if (kind === "json") download(fileBase() + ".json", JSON.stringify({ ...current, entries }, null, 2), "application/json");
    if (kind === "copy") copy(MT.toText(current, entries), "Transcript copied");
  });

  // Delete at once, with Undo, instead of a blocking "are you sure?" dialog.
  $("delete").addEventListener("click", async () => {
    const meta = current, lines = entries, file = await MT.getFile(meta.id);
    await MT.deleteMeeting(meta.id);
    location.hash = "";
    toast(`Deleted “${MT.title(meta)}”`, {
      label: "Undo",
      run: async () => {
        await MT.saveMeeting(meta, lines);
        await MT.untrash(meta.id);
        if (meta.renamed) await MT.updateMeeting(meta.id, { title: meta.title, renamed: true });
        if (file) await MT.setFile(meta.id, file);
        location.hash = encodeURIComponent(meta.id);
      },
    });
  });

  // Import: the Meeting Transcripts folder (library.json and every .docx in its day folders),
  // or files: a library exported on another computer, a library.json, .docx.
  const importMenu = (open) => {
    if (open) keepInWindow($("importMenu"));
    $("importMenu").classList.toggle("open", open);
    $("importBtn").setAttribute("aria-expanded", String(open));
  };
  $("importBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    $("importBtn").classList.remove("pulse");
    importMenu(!$("importMenu").classList.contains("open"));
  });
  document.addEventListener("click", () => importMenu(false));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") importMenu(false); });
  $("importMenu").addEventListener("click", (e) => {
    const kind = e.target.closest("button")?.dataset.import;
    importMenu(false);
    if (kind) $(kind === "folder" ? "importFolder" : "importInput").click();
  });
  const importPicked = async (input) => {
    const picked = [...input.files];
    input.value = "";
    if (!picked.length) return;
    const btn = $("importBtn");
    btn.disabled = true;
    const result = await restoreFrom(picked, (text) => (btn.lastChild.textContent = ` ${text}`), { chosen: input.id === "importInput" });
    btn.disabled = false;
    btn.lastChild.textContent = " Import…";
    libIndex = null;
    await loadLibrary();
    toast(result);
  };
  $("importFolder").addEventListener("change", (e) => importPicked(e.target));
  $("importInput").addEventListener("change", (e) => importPicked(e.target));

  // Export: the whole library as one file, named after this computer, to import elsewhere.
  $("libExport").addEventListener("click", async () => {
    const all = await chrome.storage.local.get(null);
    const device = await MT.getDevice();
    const transcripts = {};
    for (const [k, v] of Object.entries(all)) if (k.startsWith("t:")) transcripts[k.slice(2)] = v;
    const count = Object.keys(all.meetings || {}).length;
    if (!count) return toast("Nothing to export yet");
    const date = new Date().toISOString().slice(0, 10);
    const name = `Meeting Transcripts library - ${date} - ${device.name}.json`.replace(/[\\/:*?"<>|]+/g, " ");
    download(name, JSON.stringify({ app: "meet-transcripts", kind: "library", version: 1, savedAt: Date.now(),
      device, settings: {}, meetings: all.meetings, transcripts }), "application/json");
    toast(`Exported ${count} call${count === 1 ? "" : "s"} to Downloads`);
  });

  $("startFresh").addEventListener("click", async () => {
    await chrome.storage.local.set({ libraryReady: true });
    $("importBtn").classList.remove("pulse");
    $("welcomeChoice").hidden = true;
    toast("Starting a new library");
  });

  let libTimer;
  $("libSearch").addEventListener("input", async (e) => {
    libQuery = e.target.value.trim();
    if (libQuery.length >= 3 && !libIndex) await buildIndex();
    clearTimeout(libTimer);
    libTimer = setTimeout(renderList, 120);
  });
}

// Live updates while a meeting is being recorded in another tab.
chrome.storage.onChanged.addListener(async (changes) => {
  if (changes.meetings) {
    libIndex = null;
    meetings = await MT.listMeetings();
    const fresh = current && meetings.find((m) => m.id === current.id);
    if (current && !fresh) return openMeeting(null);
    if (fresh) current = fresh;
    renderList();
  }
  if (current && changes["f:" + current.id]) renderFile();
  if (current && changes["t:" + current.id]) {
    entries = changes["t:" + current.id].newValue || [];
    const main = document.querySelector("main");
    const atBottom = main.scrollHeight - main.scrollTop - main.clientHeight < 80;
    renderMeeting();
    if (atBottom && filter === "all" && !query) main.scrollTop = main.scrollHeight;
  }
});

// Imports the picked files: library files (library.json with everything and settings, or a
// library exported on another computer), then any .docx they don't cover (calls saved after the
// last library.json, or files from before it).
// `chosen`: files picked one by one (Import › File…), not a whole folder: a call deleted here
// comes back if its file is chosen; from a folder, it's skipped.
async function restoreFrom(picked, progress, { chosen = false } = {}) {
  let added = 0, already = 0, failed = 0, skipped = 0, settingsRestored = false;
  const trash = await MT.getTrash(), back = [];
  const isKnown = (meta, title) => meetings.some((m) => m.id === meta.id ||
    (Math.abs(m.startedAt - meta.startedAt) < 120_000 && MT.title(m) === title));

  // library.json, "library (since reinstall).json" from an install that wasn't restored, files
  // exported from the library, and 2.4's sync files (devices/<id>.json).
  const libs = [];
  const isLibrary = (f) => /\.json$/i.test(f.name);
  for (const f of picked.filter(isLibrary)) {
    const parsed = DOCX_IMPORT.parseLibrary(await f.text());
    if (parsed) libs.push(parsed);
  }
  const me = await MT.getDevice();
  for (const lib of libs) {
    progress("Restoring library…");
    if (lib.device) {
      // Exported on another computer (or a 2.4 sync file): calls it has are added, newer
      // copies win, nothing is removed.
      const r = await MT.mergeLibrary(lib, lib.device.id === me.id ? undefined : lib.device.name);
      added += r.added + r.updated;
      already += Math.max(0, lib.meetings.length - r.added - r.updated);
      meetings = await MT.listMeetings();
      continue;
    }
    if (Object.keys(lib.settings).length) { await MT.saveSettings(lib.settings); settingsRestored = true; }
    // library.json from before a reinstall: the calls deleted back then stay deleted.
    Object.assign(trash, lib.trash);
    await chrome.storage.local.set({ trash: { ...lib.trash, ...(await MT.getTrash()) } });
    const store = {};
    const { meetings: stored = {} } = await chrome.storage.local.get("meetings");
    for (const m of lib.meetings) {
      if (isKnown(m, MT.title(m))) { already++; continue; }
      if (!chosen && MT.isTrashed(trash, m)) { skipped++; continue; }
      back.push(m.id);
      stored[m.id] = m;
      store["t:" + m.id] = lib.transcripts[m.id];
      if (lib.files[m.id]) store["f:" + m.id] = lib.files[m.id];
      added++;
    }
    await chrome.storage.local.set({ ...store, meetings: stored });
    meetings = await MT.listMeetings();
  }

  // Word files of meetings already here (by their file name) aren't even opened.
  const known = new Set(meetings.map((m) => MT.docName(m).toLowerCase()));
  const docs = picked.filter((f) => /\.docx$/i.test(f.name) && !f.name.startsWith("~$"));
  if (!chosen) {
    const gone = docs.filter((f) => MT.isTrashed(trash, { file: f.name }));
    skipped += gone.length;
    docs.splice(0, docs.length, ...docs.filter((f) => !gone.includes(f)));
  }
  already += docs.filter((f) => known.has(f.name.replace(/( \(\d+\))?\.docx$/i, "").toLowerCase())).length;
  docs.splice(0, docs.length, ...docs.filter((f) => !known.has(f.name.replace(/( \(\d+\))?\.docx$/i, "").toLowerCase())));
  for (const [i, file] of docs.entries()) {
    progress(`Reading ${i + 1} of ${docs.length}…`);
    try {
      const { meta, entries: lines } = await DOCX_IMPORT.parse(await file.arrayBuffer(), file.name);
      if (isKnown(meta, MT.title({ ...meta, speakers: [] }))) { already++; continue; }
      if (!chosen && MT.isTrashed(trash, meta)) { skipped++; continue; }
      await MT.saveMeeting(meta, lines);
      back.push(meta.id); // and the call it was saved from (its id kept times to the millisecond):
      for (const [id] of Object.entries(trash).filter(([id]) => MT.isTrashed({ [id]: trash[id] }, { file: file.name }))) back.push(id);
      meetings = await MT.listMeetings();
      added++;
    } catch {
      failed++;
    }
  }
  if (!libs.length && !docs.length && !skipped) return "No library or Word files to import there";
  // From now on, keep library.json up to date: once there's a library to keep. Importing nothing
  // (an empty or wrong file) mustn't let an empty library replace one waiting in the folder.
  if (added || libs.some((l) => !l.device && l.meetings.length)) await chrome.storage.local.set({ libraryReady: true });
  if (chosen && back.length) await MT.untrash(back); // brought back on purpose
  return [`Imported ${added} call${added === 1 ? "" : "s"}`, settingsRestored && "settings",
    already && `${already} already here`, skipped && `${skipped} you deleted, skipped`,
    failed && `${failed} couldn't be read`].filter(Boolean).join(" · ");
}

// "#<meeting id>" opens a meeting; "#welcome" (after a fresh install) points at Restore.
async function route() {
  const id = decodeURIComponent(location.hash.slice(1));
  if (id === "welcome") {
    history.replaceState(null, "", location.pathname);
    meetings = await MT.listMeetings();
    const { libraryReady } = await chrome.storage.local.get("libraryReady");
    const isFresh = !meetings.length && !libraryReady;
    $("importBtn").classList.toggle("pulse", isFresh);
    $("welcomeChoice").hidden = !isFresh;
    renderList();
    return openMeeting(null);
  }
  openMeeting(id || null);
}

window.addEventListener("hashchange", route);

(async () => {
  bindActions();
  await loadLibrary();
  route();
})();
