// Storage layout and helpers shared by the content script, popup and viewer.
//
//   meetings         -> { [id]: { id, platform, code, link, title, eventTitle, renamed, self,
//                                  startedAt, endedAt, entryCount, speakers, participants,
//                                  gaps: [{ from, to, reason }], nameMap: { old: new }, left } }
//   t:<id>           -> [ { speaker, text, ts } ]   (ts = epoch ms when the line started)
//   f:<id>           -> { downloadId, filename, savedAt, hash, error }   (the saved .docx)
//   settings         -> { hideCaptions, myName, paused, autoSave, showIndicator,
//                         platforms: { meet, teams, zoom }, nameMap: { lowercased old: new } }
//   device           -> { id, name }   (this computer, named in its exports)
//
// Every meeting carries `updatedAt` (epoch ms of its last change); when a library exported on
// another computer is imported, the newer copy of a meeting wins. Meetings that came from
// another computer carry `syncedFrom` (that computer's name).
//
// Meetings recorded before Teams and Zoom support have no `platform`: they're Google Meet.

const MT = (() => {
  const DEFAULT_SETTINGS = {
    hideCaptions: true, myName: "", paused: false, autoSave: true,
    showIndicator: true, platforms: { meet: true, teams: true, zoom: true }, nameMap: {},
  };

  const APP = "Meeting Transcripts";
  const PLATFORMS = {
    meet: { name: "Google Meet", short: "Meet" },
    teams: { name: "Microsoft Teams", short: "Teams" },
    zoom: { name: "Zoom", short: "Zoom" },
  };
  const platformOf = (meta) => PLATFORMS[meta.platform] ? meta.platform : "meet";
  const platformName = (meta) => PLATFORMS[platformOf(meta)].name;

  // A name as renamed by the user: `map` is { old name: new name }, matched ignoring case.
  function mapName(map, name) {
    if (!map || !name) return name;
    const hit = Object.entries(map).find(([from]) => from.toLowerCase() === name.toLowerCase());
    return hit ? hit[1] : name;
  }

  const get = (keys) => chrome.storage.local.get(keys);
  const set = (obj) => chrome.storage.local.set(obj);

  async function getSettings() {
    const { settings } = await get("settings");
    return { ...DEFAULT_SETTINGS, ...(settings || {}) };
  }

  async function saveSettings(patch) {
    const settings = { ...(await getSettings()), ...patch };
    await set({ settings });
    return settings;
  }

  async function listMeetings() {
    const { meetings } = await get("meetings");
    return Object.values(meetings || {}).sort((a, b) => b.startedAt - a.startedAt);
  }

  async function getTranscript(id) {
    const key = "t:" + id;
    return (await get(key))[key] || [];
  }

  async function saveMeeting(meta, entries) {
    const { meetings = {} } = await get("meetings");
    const existing = meetings[meta.id] || {};
    // Speakers renamed in the viewer stay renamed while the call is still being recorded.
    const nameMap = { ...(meta.nameMap || {}), ...(existing.nameMap || {}) };
    if (Object.keys(nameMap).length) {
      entries = entries.map((e) => ({ ...e, speaker: mapName(nameMap, e.speaker) }));
      meta = { ...meta, self: mapName(nameMap, meta.self), participants: (meta.participants || []).map((n) => mapName(nameMap, n)) };
    }
    const merged = {
      ...existing,
      ...meta,
      nameMap,
      renamed: existing.renamed || meta.renamed,
      title: existing.renamed ? existing.title : meta.title, // keep a title the user renamed in the viewer
      entryCount: entries.length,
      speakers: [...new Set(entries.map((e) => e.speaker))],
      participants: [...new Set([...(existing.participants || []), ...(meta.participants || [])])],
    };
    merged.title = title(merged);
    merged.updatedAt = Date.now();
    meetings[meta.id] = merged;
    await set({ meetings, ["t:" + meta.id]: entries });
  }

  // Renames a speaker throughout one meeting; with `future`, also in calls recorded from now on.
  async function renameSpeaker(id, from, to, future) {
    to = to.replace(/\s+/g, " ").trim();
    if (!to || to === from) return;
    const { meetings = {} } = await get("meetings");
    const meta = meetings[id];
    if (!meta) return;
    const nameMap = { ...(meta.nameMap || {}) };
    for (const k of Object.keys(nameMap)) if (nameMap[k] === from) nameMap[k] = to; // A→B then B→C means A→C
    nameMap[from] = to;
    const rename = (n) => (n === from ? to : n);
    const entries = (await getTranscript(id)).map((e) => ({ ...e, speaker: rename(e.speaker) }));
    meetings[id] = { ...meta, nameMap, self: rename(meta.self), participants: (meta.participants || []).map(rename) };
    await set({ meetings });
    await saveMeeting(meetings[id], entries);
    if (future) {
      const s = await getSettings();
      const map = { ...(s.nameMap || {}) };
      for (const k of Object.keys(map)) if (map[k] === from) map[k] = to;
      map[from.toLowerCase()] = to;
      await saveSettings({ nameMap: map });
    }
  }

  async function updateMeeting(id, patch) {
    const { meetings = {} } = await get("meetings");
    if (!meetings[id]) return;
    meetings[id] = { ...meetings[id], ...patch, updatedAt: Date.now() };
    await set({ meetings });
  }

  // A deleted call is remembered (its id and its Word document's name), so importing the
  // Meeting Transcripts folder, where its document and an older library.json still are, doesn't
  // bring it back. Undo, or importing its file on purpose, forgets that.
  async function deleteMeeting(id) {
    const { meetings = {}, trash = {} } = await chrome.storage.local.get(["meetings", "trash"]);
    if (meetings[id]) trash[id] = { doc: docName(meetings[id]).toLowerCase(), deletedAt: Date.now() };
    delete meetings[id];
    await set({ meetings, trash });
    await chrome.storage.local.remove(["t:" + id, "f:" + id]);
  }
  async function untrash(ids) {
    const { trash = {} } = await get("trash");
    for (const id of [].concat(ids)) delete trash[id];
    await set({ trash });
  }
  async function getTrash() { return (await get("trash")).trash || {}; }
  // Deleted here, by id or, for a Word file, by its name (" (2)" and ".docx" aside).
  const isTrashed = (trash, { id, file }) => !!(id && trash[id]) ||
    (!!file && Object.values(trash).some((t) => t.doc === file.replace(/( \(\d+\))?\.docx$/i, "").toLowerCase()));

  // --- moving the library between computers ---------------------------------------------------
  //
  // Export (in the library) saves the whole library as one file, named after this computer;
  // Import on another computer merges it in. Nothing goes anywhere but the files you move.

  async function getDevice() {
    const { device } = await get("device");
    if (device && device.id) return device;
    const id = [...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "";
    const kind = /mac/i.test(platform) ? "Mac" : /win/i.test(platform) ? "Windows PC" : /linux|cros/i.test(platform) ? "Linux computer" : "Computer";
    const fresh = { id, name: kind };
    await set({ device: fresh });
    return fresh;
  }

  // When a meeting last changed; older recordings have no updatedAt.
  const stamp = (m) => m.updatedAt || m.endedAt || m.startedAt || 0;

  // Merges a library exported on another computer (as read by DOCX_IMPORT.parseLibrary) into
  // this one: meetings it doesn't have are added, and the newer copy of each meeting wins.
  // Nothing is ever removed. Its saved-file records aren't taken: those are the other
  // computer's files.
  async function mergeLibrary(lib, from) {
    const { meetings = {} } = await get("meetings");
    const store = {};
    let added = 0, updated = 0, changed = false;
    const trash = await getTrash();
    for (const m of lib.meetings) {
      const local = meetings[m.id];
      if (local && stamp(local) >= stamp(m)) continue;
      if (!local && trash[m.id] && trash[m.id].deletedAt >= stamp(m)) continue; // deleted here since
      // Where it came from: kept for a meeting recorded here, else the device it was recorded on.
      const syncedFrom = local ? local.syncedFrom : m.syncedFrom || from;
      meetings[m.id] = { ...m, updatedAt: stamp(m), syncedFrom };
      if (!syncedFrom) delete meetings[m.id].syncedFrom;
      store["t:" + m.id] = lib.transcripts[m.id];
      if (local) updated++; else added++;
      changed = true;
    }
    if (changed) await set({ ...store, meetings });
    return { added, updated };
  }

  async function getFile(id) {
    const key = "f:" + id;
    return (await get(key))[key] || null;
  }

  const setFile = (id, value) => set({ ["f:" + id]: value });

  // Consecutive lines from the same speaker read better as one paragraph.
  function groupTurns(entries) {
    const turns = [];
    for (const e of entries) {
      const last = turns[turns.length - 1];
      if (last && last.speaker === e.speaker && e.ts - last.endTs < 60_000) {
        last.lines.push(e);
        last.endTs = e.ts;
      } else {
        turns.push({ speaker: e.speaker, ts: e.ts, endTs: e.ts, lines: [e] });
      }
    }
    return turns;
  }

  // Turns and gaps (stretches with nothing recorded) in time order.
  function timeline(meta, entries) {
    const items = groupTurns(entries).map((t) => ({ kind: "turn", ...t }));
    for (const g of meta.gaps || []) {
      const i = items.findIndex((x) => (x.kind === "turn" ? x.ts : x.from) > g.from);
      items.splice(i < 0 ? items.length : i, 0, { kind: "gap", ...g });
    }
    return items;
  }

  const GAP_REASONS = {
    captions: "Captions were off",
    paused: "Recording was paused",
    left: "Not in the call",
  };

  // "Captions were off 12:40–19:52 (7 min); nothing was recorded"
  function gapText(meta, g) {
    const mins = Math.max(1, Math.round((g.to - g.from) / 60000));
    return `${GAP_REASONS[g.reason] || GAP_REASONS.captions} ${clock(g.from - meta.startedAt)}–${clock(g.to - meta.startedAt)} ` +
      `(${mins} min); nothing was recorded`;
  }

  const pad = (n) => String(n).padStart(2, "0");

  function clock(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600);
    return (h ? h + ":" + pad(Math.floor(s / 60) % 60) : Math.floor(s / 60)) + ":" + pad(s % 60);
  }

  function dateTime(ts) {
    return new Date(ts).toLocaleString(undefined, {
      weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    });
  }

  function duration(meta) {
    const mins = Math.round(((meta.endedAt || meta.startedAt) - meta.startedAt) / 60000);
    if (mins < 1) return "<1 min";
    return mins < 60 ? mins + " min" : Math.floor(mins / 60) + " h" + (mins % 60 ? " " + (mins % 60) + " min" : "");
  }

  // A call's Word document is the user's once the call is over: they may open it in Word and
  // add notes, and Chrome can't tell us whether they did (it never re-reads a file it saved).
  // So it's never rewritten or removed automatically after that, only when asked (Update .docx).
  // Over = it was saved as the call ended, or nothing new came in for SETTLE_MS (as long as a
  // rejoin still continues the same transcript).
  const SETTLE_MS = 10 * 60_000;
  const isSettled = (meta, f) => !!(f && f.downloadId &&
    (f.final || Date.now() - ((meta && (meta.endedAt || meta.startedAt)) || 0) > SETTLE_MS));

  // Sentence-level highlight filters, used by the viewer and the Google Doc.
  const FILTERS = {
    questions: { label: "Questions", test: (s) => /\?\s*$/.test(s) },
    actions: {
      label: "Possible action items",
      test: (s) => /\b(action items?|follow[- ]?up|to-?do|next steps?|deadline|due|i'll|i will|we'll|we will|we need to|we should|you need to|can you|could you|let's|assign|owner|by (mon|tues|wednes|thurs|fri|satur|sun)day|by (tomorrow|tonight|eod|end of)|next week)\b/i.test(s),
    },
    decisions: {
      label: "Possible decisions",
      test: (s) => /\b(decided|decision|agreed|agree|let's go with|we'll go with|going with|final(ize|ized)?|approved?|settled|conclusion)\b/i.test(s),
    },
  };

  function highlights(entries, filter) {
    const out = [];
    for (const e of entries) {
      const hits = (e.text.match(/[^.?!]+[.?!]*/g) || []).map((s) => s.trim()).filter(FILTERS[filter].test);
      if (hits.length) out.push({ speaker: e.speaker, ts: e.ts, text: hits.join(" … ") });
    }
    return out;
  }

  // Icon-font ligatures such as "keep_outline" or "frame_person" that a call page can draw as
  // text next to a name. No one's name is lowercase words joined by underscores.
  const isIconName = (n) => /^[a-z0-9]+(_[a-z0-9]+)+$/.test(n);

  // A name read together with a hidden copy of itself, whole or cut short:
  // "Isuru IlangarathneIsuru Ilangarathne", "Chathuranga BalasooriyaChathuranga Bala".
  // The copy starts right after a lowercase letter, with no space, and repeats the name's
  // start: all of it, or at least past its first word. "McDonald" and "Ann McAnn" stay.
  function dedupeName(n) {
    for (let k = 2; k < n.length - 1; k++) {
      const rest = n.slice(k);
      if ((rest.length === k || rest.includes(" ")) && /\p{Ll}/u.test(n[k - 1]) && /\p{Lu}/u.test(n[k]) && n.startsWith(rest)) return n.slice(0, k);
    }
    return n;
  }

  // Everyone seen in the call (tiles / people panel) plus everyone who spoke.
  function people(meta) {
    const all = [...(meta.participants || []), ...(meta.speakers || [])].map((n) => n && dedupeName(n))
      .filter((n) => n && !/^(you|unknown|speaker)$/i.test(n) && !isIconName(n));
    const seen = new Map();
    for (const n of all) if (!seen.has(n.toLowerCase())) seen.set(n.toLowerCase(), n);
    return [...seen.values()];
  }

  // Everyone except you.
  const others = (meta) => people(meta).filter((n) => !meta.self || n.toLowerCase() !== meta.self.toLowerCase());

  const nameList = (names) => names.slice(0, 4).join(", ") + (names.length > 4 ? ` +${names.length - 4}` : "");

  // Recordings made before eventTitle existed stored "Meet abc-defg-hij" for untitled calls.
  const LEGACY_UNTITLED = /^Meet [a-z]{3,4}-[a-z]{4}-[a-z]{3,4}$/;

  // A calendar event (or a meeting the user named) rather than a spontaneous call.
  function isScheduled(meta) {
    if (meta.renamed || meta.eventTitle) return true;
    return meta.eventTitle === undefined && !!meta.title && !LEGACY_UNTITLED.test(meta.title);
  }

  // Scheduled: the event title. Spontaneous: named after who else joined.
  function title(meta) {
    if (meta.renamed) return meta.title;
    if (meta.eventTitle) return meta.eventTitle;
    if (isScheduled(meta)) return meta.title;
    const o = others(meta);
    return o.length ? "Call with " + nameList(o) : "Solo call";
  }

  function isoDate(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  // Scheduled:   "2026-10-11 - Weekly sync - Alice, Bob, Sam +2"
  // Spontaneous: "2026-10-11 - Call with Alice, Bob"   (the names are already in the title)
  function docName(meta) {
    const parts = [isoDate(meta.startedAt), title(meta)];
    if (isScheduled(meta) && people(meta).length) parts.push(nameList(people(meta)));
    // Safe as a file name on macOS and Windows: no path or reserved characters, no control
    // characters, no leading/trailing dots or spaces, and short enough for Windows paths.
    return parts.join(" - ")
      .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ")
      .slice(0, 150).replace(/^[.\s]+|[.\s]+$/g, "") || "Meeting transcript";
  }

  // Files are grouped in one folder per day: "Meeting Transcripts/2026-10-11/".
  const dayFolder = (meta) => isoDate(meta.startedAt);

  // The saved document, as blocks for docx.js: details, speaking time, highlights, transcript.
  function docBlocks(meta, entries) {
    const GREY = "80868B";
    const when = (ts) => ({ text: `[${clock(ts - meta.startedAt)}]`, color: GREY });
    const label = (name, value) => [{ text: name + ": ", bold: true }, { text: value }];
    const blocks = [
      { style: "Title", runs: [{ text: title(meta) }] },
      { runs: [
        ...label("Date", `${dateTime(meta.startedAt)} (${duration(meta)})`),
        { br: true }, ...label("Platform", platformName(meta)),
        { br: true }, ...label("Participants", people(meta).join(", ") || "—"),
        ...(link(meta) ? [{ br: true }, { text: "Meeting link: ", bold: true },
          { text: link(meta).replace(/^https:\/\//, ""), link: link(meta) }] : []),
      ] },
    ];

    const words = {};
    let total = 0;
    for (const e of entries) {
      const n = e.text.split(/\s+/).length;
      words[e.speaker] = (words[e.speaker] || 0) + n;
      total += n;
    }
    blocks.push({ style: "Heading1", runs: [{ text: "Speaking time" }] });
    for (const [s, n] of Object.entries(words).sort((a, b) => b[1] - a[1])) {
      blocks.push({ style: "Bullet", runs: [{ text: `${s}: ${Math.round((n / total) * 100)}%` }] });
    }

    blocks.push({ style: "Heading1", runs: [{ text: "Highlights" }] },
      { runs: [{ text: "Picked out by keywords from the captions; check the transcript for context.", italic: true, color: GREY }] });
    for (const f of ["actions", "decisions", "questions"]) {
      const hits = highlights(entries, f);
      if (!hits.length) continue;
      blocks.push({ style: "Heading2", runs: [{ text: FILTERS[f].label }] });
      for (const h of hits) {
        blocks.push({ style: "Bullet", runs: [when(h.ts), { text: ` ${h.speaker}: `, bold: true }, { text: h.text }] });
      }
    }

    blocks.push({ style: "Heading1", runs: [{ text: "Transcript" }] });
    for (const t of timeline(meta, entries)) {
      if (t.kind === "gap") {
        blocks.push({ runs: [{ text: "— " + gapText(meta, t) + " —", italic: true, color: GREY }] });
        continue;
      }
      blocks.push({ runs: [{ text: t.speaker, bold: true }, { text: " " }, when(t.ts), { br: true },
        { text: t.lines.map((l) => l.text).join(" ") }] });
    }
    blocks.push({ runs: [{ text: `Recorded from ${platformName(meta)} live captions by ${APP}; expect some recognition errors.`,
      italic: true, color: GREY }] });
    return blocks;
  }

  // The meeting's link, for calls that have one (Meet always, Zoom by meeting number).
  const link = (meta) => meta.link !== undefined ? meta.link : platformOf(meta) === "meet" && meta.code
    ? "https://meet.google.com/" + meta.code : "";

  function toText(meta, entries) {
    const head = `${title(meta)}\n${platformName(meta)} · ${dateTime(meta.startedAt)} · ${duration(meta)}\n\n`;
    return head + timeline(meta, entries)
      .map((t) => t.kind === "gap" ? `--- ${gapText(meta, t)} ---`
        : `[${clock(t.ts - meta.startedAt)}] ${t.speaker}: ${t.lines.map((l) => l.text).join(" ")}`)
      .join("\n\n") + "\n";
  }

  function toMarkdown(meta, entries) {
    const head = `# ${title(meta)}\n\n*${platformName(meta)} · ${dateTime(meta.startedAt)} · ${duration(meta)} · ` +
      `${people(meta).join(", ")}*\n\n`;
    return head + timeline(meta, entries)
      .map((t) => t.kind === "gap" ? `*— ${gapText(meta, t)} —*`
        : `**${t.speaker}** \`${clock(t.ts - meta.startedAt)}\`  \n${t.lines.map((l) => l.text).join(" ")}`)
      .join("\n\n") + "\n";
  }

  return {
    APP, PLATFORMS, platformOf, platformName, mapName, isIconName, dedupeName,
    getSettings, saveSettings, listMeetings, getTranscript, saveMeeting, renameSpeaker, updateMeeting, deleteMeeting, untrash, getTrash, isTrashed,
    getDevice, mergeLibrary,
    getFile, setFile, isSettled, groupTurns, timeline, gapText, clock, dateTime, duration, toText, toMarkdown,
    FILTERS, highlights, people, others, title, isScheduled, docName, dayFolder, docBlocks, link,
  };
})();
