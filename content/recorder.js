// Turns a meeting's live captions into a stored transcript. Everything specific to Google
// Meet, Teams or Zoom (where the captions are, who is speaking, how to turn captions on,
// whether you're still in the call) comes from MT_PLATFORM (content/platforms/*.js).
//
// Captions render as one block per utterance: a name and a line of text that is revised in
// place as speech recognition firms up (and, in Meet, trimmed at the front once it gets long).
// We keep one transcript entry per block, overwrite its text on every revision, stitch trimmed
// text back together, and split long monologues at sentence boundaries so the transcript
// keeps useful timestamps.

(() => {
  const P = MT_PLATFORM;
  const POLL_MS = 1000;
  const FAST_POLL_MS = 300;             // while waiting for captions to appear, so no first words are lost
  const SAVE_DEBOUNCE_MS = 1500;
  const RESUME_WINDOW_MS = 10 * 60_000; // a rejoin within this window continues the same transcript
  const SPLIT_AT = 400;                 // split an entry once it is this long...
  const STABLE_TAIL = 150;              // ...but never inside the still-changing last N chars
  const ENDED_AFTER_MS = 3000;          // call UI gone this long = the user left the call
  const GAP_MIN_MS = 20_000;            // shorter stretches without captions aren't worth marking
  const GENERIC_SPEAKER = /^(speaker|unknown)$/i;
  const SELF_KEY = P.id === "meet" ? "selfName" : "selfName:" + P.id;

  let settings = null;
  let alive = true;
  let code = null;      // the call this tab is in
  let missingSince = 0; // when the call id disappeared
  let region = null;
  let observer = null;
  let session = null;   // { meta, entries } once the first line arrives
  let sessionPromise = null;
  let blocks = new WeakMap();
  let lastSpeaker = "";
  let saveTimer = null;
  let autoTries = 0;
  let lastAutoTry = 0;
  let lastStatus = "";
  let participants = new Set();
  let outOfCallSince = 0;
  let selfName = "";
  let gap = null;       // { from, reason } while captions aren't being recorded mid-call

  const enabled = () => !settings.platforms || settings.platforms[P.id] !== false;
  const me = () => settings.myName || selfName;

  // "You" becomes your name; names you renamed in the viewer ("for future calls") are applied.
  function speakerName(raw) {
    let name = (raw || "").replace(/\s+/g, " ").trim() || "Unknown";
    if (me() && /^you$/i.test(name)) name = me();
    return MT.mapName(settings.nameMap, name);
  }

  function detectSelfName() {
    const name = P.selfName();
    if (name && name !== selfName) {
      selfName = name;
      chrome.storage.local.set({ [SELF_KEY]: selfName }); // e.g. Meet only shows it before you join
    }
  }

  function collectParticipants() {
    const add = (name) => {
      name = MT.dedupeName((name || "").trim());
      if (!name || name.length > 60 || /^\(?(you|me|unknown|speaker)\)?$/i.test(name) || MT.isIconName(name)) return;
      participants.add(MT.mapName(settings.nameMap, name));
    };
    for (const name of P.participants()) add(name);
    if (me()) add(me());
  }

  // --- text stitching -------------------------------------------------------------------

  const key = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const words = (s) => s.split(/\s+/).filter(Boolean);

  // Returns the combined text if `next` continues `prev` (a revision, an extension, or a
  // version whose front was trimmed off), or null if it looks like unrelated new speech.
  // Tries every offset at which `next` could start inside `prev` and keeps the best word
  // alignment; offset 0 is a plain revision/extension.
  function mergeText(prev, next) {
    if (!prev) return next;
    const pw = words(prev), nw = words(next);
    const pk = pw.map(key), nk = nw.map(key);
    let best = -1, bestScore = 0;
    for (let i = 0; i < pk.length; i++) {
      const len = Math.min(nk.length, pk.length - i);
      if (len < Math.max(1, nk.length / 2) && i > 0) break;
      let same = 0;
      for (let j = 0; j < len; j++) if (pk[i + j] === nk[j]) same++;
      const score = same / len;
      if (score > bestScore) { best = i; bestScore = score; }
      if (score === 1) break;
    }
    if (best < 0 || bestScore < 0.6) return null;
    return best === 0 ? next : pw.slice(0, best).concat(nw).join(" ");
  }

  // A block we haven't seen can still be speech we already have: the page re-drew its caption
  // list, or Zoom's transcript panel repeats what the overlay showed. Finds that entry among
  // the last few, so the speech isn't recorded twice.
  function adopt(speaker, text) {
    if (words(text).length < 5) return null; // short phrases ("Yes, sure.") genuinely repeat
    for (const e of session.entries.slice(-12).reverse()) {
      const sameSpeaker = e.speaker === speaker || GENERIC_SPEAKER.test(e.speaker) || GENERIC_SPEAKER.test(speaker);
      if (!sameSpeaker || words(e.text).length < 5) continue;
      const later = mergeText(e.text, text); // the block repeats or extends the entry
      if (later !== null) return { entry: e, prefix: later.slice(0, later.length - text.length).trim() };
      const earlier = mergeText(text, e.text); // the entry was a later part of the block
      if (earlier !== null) return { entry: e, prefix: "" };
    }
    return null;
  }

  // --- caption parsing ------------------------------------------------------------------

  // `inferred`: the block doesn't name its speaker, so the adapter guessed (the previous
  // speaker, or Zoom's active-speaker tile). A block keeps the speaker it was first given.
  function parse(block, st) {
    const parsed = P.parseBlock(block, lastSpeaker);
    if (!parsed) return null;
    const text = (parsed.text || "").replace(/\s+/g, " ").trim();
    if (!text) return null;
    return { speaker: parsed.inferred && st ? st.speaker : speakerName(parsed.speaker), text };
  }

  function addEntry(speaker, text) {
    const entry = { speaker, text, ts: Date.now() };
    session.entries.push(entry);
    return entry;
  }

  function scan() {
    if (!region || !session || settings.paused || !enabled()) return;
    let changed = false;
    for (const block of P.blocks(region)) {
      let st = blocks.get(block);
      const parsed = parse(block, st);
      if (!parsed) continue;
      const { speaker, text } = parsed;
      lastSpeaker = speaker;
      let full = st && st.speaker === speaker ? mergeText(st.full, text) : null;
      if (full === null) {
        const known = !st && adopt(speaker, text);
        if (known) {
          if (GENERIC_SPEAKER.test(known.entry.speaker)) known.entry.speaker = speaker;
          st = { speaker, full: "", committed: 0, prefix: known.prefix, entry: known.entry };
          full = text;
          if (known.entry.text.length > (known.prefix ? known.prefix + " " : "").length + text.length) {
            blocks.set(block, { ...st, full: text }); // the entry already holds more than the block shows
            continue;
          }
          blocks.set(block, st);
        } else {
          st = { speaker, full: text, committed: 0, prefix: "", entry: addEntry(speaker, text) };
          blocks.set(block, st);
          changed = true;
          continue;
        }
      }
      if (full === st.full) continue;
      st.full = full;
      changed = true;

      let start = st.committed;
      while (start > 0 && start < full.length && !/\s/.test(full[start - 1])) start++; // snap to a word
      let rest = full.slice(start);
      // Split long monologues at a sentence end that is old enough not to be revised.
      let cut = -1;
      if (rest.length > SPLIT_AT) {
        const re = /[.?!]\s/g;
        let m;
        while ((m = re.exec(rest)) && m.index < rest.length - STABLE_TAIL) if (m.index > 100) cut = m.index + 1;
      }
      const lead = st.prefix ? st.prefix + " " : "";
      if (cut > 0) {
        st.entry.text = lead + rest.slice(0, cut).trim();
        st.committed = start + cut;
        st.prefix = "";
        st.entry = addEntry(speaker, rest.slice(cut).trim());
      } else {
        st.entry.text = lead + rest.trim();
      }
    }
    if (changed) { scheduleSave(); capturedAt = Date.now(); }
  }

  // --- captions on screen, nothing recorded -----------------------------------------------
  //
  // When Meet, Teams or Zoom change their page, the caption area is still found but its lines
  // no longer read: captions keep changing on screen and nothing is captured. After STUCK_MS of
  // that, the pill and the popup say so instead of "Recording", and offer the report.
  const STUCK_MS = 60_000;
  let stuckAfter = STUCK_MS; // tests shorten it (storage "stuckAfterMs")
  let captionText = "", captionChangedAt = 0, capturedAt = 0;
  function noteCaptions() {
    const text = region ? region.textContent : "";
    if (text !== captionText) { captionText = text; captionChangedAt = Date.now(); }
  }
  const stuck = () => !!region && !!session && !settings.paused && enabled() && captionChangedAt - capturedAt > stuckAfter;

  // --- gaps: stretches of a call with nothing recorded ----------------------------------

  function trackGap() {
    if (!session) return;
    const recording = !!region && !settings.paused && enabled();
    if (!recording && !gap) gap = { from: Date.now(), reason: settings.paused ? "paused" : "captions" };
    if (recording && gap) closeGap();
  }

  function closeGap(to = Date.now()) {
    if (!gap) return;
    if (session && to - gap.from >= GAP_MIN_MS) {
      session.meta.gaps = [...(session.meta.gaps || []), { from: gap.from, to, reason: gap.reason }];
      scheduleSave();
    }
    gap = null;
  }

  // --- session + persistence ------------------------------------------------------------

  async function ensureSession() {
    if (session) return session;
    if (!sessionPromise) {
      sessionPromise = (async () => {
        const now = Date.now();
        const recent = (await MT.listMeetings()).find((m) => (m.platform || "meet") === P.id && m.code === code &&
          now - (m.endedAt || m.startedAt) < RESUME_WINDOW_MS && (P.resumeAfterLeave || !m.left));
        let meta;
        if (recent) {
          meta = { ...recent, left: false };
          if (now - recent.endedAt >= GAP_MIN_MS) meta.gaps = [...(recent.gaps || []), { from: recent.endedAt, to: now, reason: "left" }];
        } else {
          meta = { id: code + "-" + now, code, platform: P.id, eventTitle: P.eventTitle(), startedAt: now, endedAt: now };
        }
        const entries = recent ? await MT.getTranscript(recent.id) : [];
        session = { meta, entries };
        return session;
      })();
    }
    return sessionPromise;
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, SAVE_DEBOUNCE_MS);
    sendStatus();
  }

  async function save() {
    clearTimeout(saveTimer);
    if (!session || !session.entries.length || !alive) return;
    const { meta, entries } = session;
    meta.platform = P.id;
    meta.link = P.link(meta.code) || meta.link || "";
    meta.eventTitle = P.eventTitle() || meta.eventTitle || "";
    meta.self = me() || meta.self || "";
    meta.participants = [...participants];
    meta.endedAt = Math.max(meta.endedAt || 0, entries[entries.length - 1].ts);
    try {
      await MT.saveMeeting(meta, entries.filter((e) => e.text));
      chrome.runtime.sendMessage({ type: "meetingSaved", id: meta.id });
    } catch (err) {
      if (String(err).includes("context invalidated")) shutdown();
      else console.warn("[Meeting Transcripts] save failed", err);
    }
  }

  async function endSession() {
    if (!session) return;
    closeGap();
    session.meta.left = true;
    const id = session.meta.id; // resetSession clears `session` while we save
    await save();
    try { chrome.runtime.sendMessage({ type: "meetingEnded", id }); } catch {}
  }

  function resetSession() {
    endSession();
    session = null;
    sessionPromise = null;
    blocks = new WeakMap();
    autoTries = 0;
    participants = new Set();
    outOfCallSince = 0;
    gap = null;
  }

  // --- page integration -----------------------------------------------------------------

  function attach(el) {
    if (observer) observer.disconnect();
    region = el;
    captionText = el ? el.textContent : "";
    captionChangedAt = capturedAt = Date.now();
    applyHide(); // also undoes it for a caption area that's gone
    if (!el) return;
    let pending = false;
    observer = new MutationObserver(() => {
      if (pending) return;
      pending = true;
      setTimeout(() => { pending = false; applyHide(); scan(); noteCaptions(); }, 250); // the page may re-render around the captions
    });
    observer.observe(el, { childList: true, subtree: true, characterData: true });
    ensureSession().then(scan);
  }

  // Hiding captions: the caption area is lifted out of the page (fixed, off-screen, invisible)
  // rather than display:none, so the page keeps rendering text we can read. The containers
  // it leaves empty are collapsed, and the page is told the window resized, so the call
  // recalculates its video layout into the space (Meet sizes its tiles by script). A
  // container is only collapsed while it holds no video, no participant tile, none of the
  // call's controls and no more than a third of the window: never the call layout itself.
  const HIDE_CSS = `
    .mt-hidden-captions { position: fixed !important; left: -10000px !important; top: 0 !important;
      width: var(--mt-width, 40rem) !important; max-height: none !important; opacity: 0 !important; pointer-events: none !important; }
    .mt-collapsed { height: 0 !important; min-height: 0 !important; max-height: 0 !important; flex: 0 0 0 !important;
      padding-top: 0 !important; padding-bottom: 0 !important; margin-top: 0 !important; margin-bottom: 0 !important;
      border-width: 0 !important; overflow: hidden !important; }`;
  let collapsed = [];
  // The call's own controls: a container holding any of these is part of the control bar.
  const CONTROLS = ['microphone', 'camera', 'leave', 'hang up', 'end call', 'turn on captions', 'turn off captions',
    'turn on live captions', 'turn off live captions'].map((l) => `button[aria-label*="${l}" i]`)
    .concat(P.controlSel || []).join(", "); // labels are English; the platform's own ids aren't

  function collapsible(el) {
    if (!el || el === document.body || el === document.documentElement) return false;
    if (el.querySelector("video, [data-participant-id]")) return false;
    if (el.querySelector(CONTROLS)) return false;
    const r = el.getBoundingClientRect();
    return r.height <= window.innerHeight / 3 || el.classList.contains("mt-collapsed");
  }

  function applyHide() {
    const hide = !!region && settings.hideCaptions && enabled();
    if (hide && !document.getElementById("mt-hide-css")) {
      const style = document.createElement("style");
      style.id = "mt-hide-css";
      style.textContent = HIDE_CSS;
      (document.head || document.documentElement).append(style);
    }
    document.querySelectorAll(".mt-hidden-captions").forEach((el) => { if (el !== region || !hide) el.classList.remove("mt-hidden-captions"); });
    // Lift the captions out first, so the containers are measured without them.
    if (hide && !region.classList.contains("mt-hidden-captions")) {
      region.style.setProperty("--mt-width", Math.max(320, region.getBoundingClientRect().width) + "px");
      region.classList.add("mt-hidden-captions");
    }
    const chain = [];
    if (hide) for (let el = region.parentElement, i = 0; i < 6 && collapsible(el); el = el.parentElement, i++) chain.push(el);
    const changed = chain.length !== collapsed.length || chain.some((el, i) => el !== collapsed[i]);
    for (const el of collapsed) if (!chain.includes(el)) el.classList.remove("mt-collapsed");
    for (const el of chain) el.classList.add("mt-collapsed");
    collapsed = chain;
    const refit = fitStage(hide);
    if (changed || refit) window.dispatchEvent(new Event("resize"));
  }

  // Meet positions its video stage and the tiles in it itself (inline offsets and sizes), with
  // room for the caption panel, and recalculates neither when the panel collapses. So while
  // captions are hidden, the tiles Meet drew are scaled up as one block (a CSS transform on the
  // stage) to fill the space down to the controls, where the collapsed panel now sits, keeping
  // the stage's side margin as the gap, never wider than the stage, centered. Meet's layout
  // itself is untouched: turning hiding off removes the transform. Everything is measured on
  // screen each time, so it fits any window size and any number of tiles. Meet re-renders the
  // stage and resets its classes, so the rule names the stage by the page's own class.
  let fitInfo = "";

  // The stage: the largest positioned container, with an inline bottom offset, around any video
  // or participant tile. Every one is checked: the first on the page can be an avatar in the
  // top bar rather than a tile on the stage.
  function findStage() {
    let best = null, bestArea = 0;
    const seen = new Set();
    for (const tile of [...document.querySelectorAll("video, [data-participant-id]")].slice(0, 60)) {
      for (let el = tile.parentElement; el && el !== document.body && !seen.has(el); el = el.parentElement) {
        seen.add(el);
        if (!/px$/.test(el.style.bottom) || el.contains(region)) continue;
        const pos = getComputedStyle(el).position;
        if (pos !== "absolute" && pos !== "fixed") continue;
        const r = el.getBoundingClientRect();
        if (r.width * r.height > bestArea) { best = el; bestArea = r.width * r.height; }
      }
    }
    return best;
  }

  function selectorFor(el) {
    const tag = el.tagName.toLowerCase();
    for (const c of el.classList) {
      if (c.startsWith("mt-")) continue;
      const sel = `${tag}.${CSS.escape(c)}`;
      if (document.querySelectorAll(sel).length === 1) return sel;
    }
    document.querySelectorAll("[data-mt-stage]").forEach((x) => { if (x !== el) delete x.dataset.mtStage; });
    el.dataset.mtStage = "";
    return "[data-mt-stage]";
  }

  // The part of an element that shows: Meet draws a camera's video larger than its tile and
  // lets the tile crop it, so the video's own box reaches past the tile (and the screen).
  function visibleRect(el, stageEl) {
    let { left, top, right, bottom } = el.getBoundingClientRect();
    for (let a = el.parentElement; a && a !== stageEl.parentElement; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.overflowX === "visible" && cs.overflowY === "visible" && cs.clipPath === "none") continue;
      const r = a.getBoundingClientRect();
      left = Math.max(left, r.left); top = Math.max(top, r.top); right = Math.min(right, r.right); bottom = Math.min(bottom, r.bottom);
    }
    return { left, top, right, bottom, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
  }

  // Where the shown caption panel starts: the top of the captions and the containers around
  // them that hold nothing else (the same ones hiding collapses).
  function captionTop() {
    let top = Infinity;
    for (let el = region, i = 0; el && i < 7 && (el === region || collapsible(el)); el = el.parentElement, i++) {
      const r = el.getBoundingClientRect();
      if (r.height > 0 && r.width > 0) top = Math.min(top, r.top);
    }
    return top < Infinity && top > window.innerHeight / 3 ? top : 0;
  }

  // Where the call's controls start: the bar (at least half the window wide) around its buttons.
  function controlsTop() {
    for (const button of document.querySelectorAll(CONTROLS)) {
      for (let el = button.parentElement; el && el !== document.body; el = el.parentElement) {
        const r = el.getBoundingClientRect();
        if (r.width < window.innerWidth / 2) continue;
        if (r.height > window.innerHeight / 3 || el.contains(region)) break;
        if (r.top > window.innerHeight / 2) return r.top;
        break;
      }
    }
    return 0;
  }

  function fitStage(hide) {
    let css = document.getElementById("mt-stage-css");
    const before = css ? css.textContent : "";
    // Measure Meet's own layout, without our transform (no paint happens in between).
    if (css) css.textContent = "";
    // Hidden: the tiles fill the space down to the controls. Shown: they fit above the caption
    // panel. Meet only re-measures that space on its own events (someone joining, a resize), so
    // after captions were hidden it can keep laying the tiles out over the panel once they're back.
    const edge = !region ? 0 : hide ? (collapsed.length ? controlsTop() || collapsed[collapsed.length - 1].getBoundingClientRect().top : 0)
      : captionTop();
    const stageEl = edge > 0 ? findStage() : null;
    let rule = "";
    if (!region) fitInfo = "no captions";
    else if (!edge) fitInfo = hide ? "no collapsed caption panel" : "no caption panel";
    else if (!stageEl) fitInfo = "no stage found";
    else {
      const st = stageEl.getBoundingClientRect();
      const margin = Math.min(parseFloat(getComputedStyle(stageEl).left) || 0, 24);
      // The tiles: every video and participant tile on the stage, as drawn. Not layers covering
      // the whole stage (Meet's stage holds some), which would make the tiles look full already,
      // and not icons or avatars inside a tile.
      let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
      for (const c of stageEl.querySelectorAll("video, [data-participant-id]")) {
        const cr = visibleRect(c, stageEl);
        if (cr.width < 80 || cr.height < 45) continue;
        if (cr.width >= st.width * 0.98 && cr.height >= st.height * 0.98) continue;
        l = Math.min(l, cr.left); t = Math.min(t, cr.top); r = Math.max(r, cr.right); b = Math.max(b, cr.bottom);
      }
      const availH = edge - margin - st.top, cw = r - l, ch = b - t;
      const fit = cw > 0 && ch > 0 ? Math.min(availH / ch, st.width / cw) : 0;
      // Hidden, only ever enlarged; shown, only ever shrunk (when Meet's tiles run under the panel).
      // Hidden and already as wide as the stage (a row of cameras), they can't grow without
      // stretching the video: they're centered in the space instead of left at its top.
      const scale = hide && fit >= 0.98 ? Math.max(1, fit) : fit;
      const centerGap = hide ? Math.abs((availH - ch * scale) / 2 - (t - st.top) * scale) : 0;
      if (hide ? scale > 1.02 || (fit >= 0.98 && centerGap > 8) : scale > 0 && scale < 0.98 && b > edge + 2) {
        // transform-origin is the stage's top-left: a point p lands at d + scale·p.
        const dx = (st.width - cw * scale) / 2 - scale * (l - st.left);
        const dy = (availH - ch * scale) / 2 - scale * (t - st.top);
        const sel = selectorFor(stageEl);
        // Scaled, the stage can reach past the space it should fill: clip it to that space
        // (in its own, unscaled pixels), so its empty edges never cover a side panel or the
        // window's edge, nor take the clicks meant for what's under them.
        const inset = [-dy / scale, st.width - (st.width - dx) / scale, st.height - (availH - dy) / scale, -dx / scale]
          .map((v) => Math.max(0, v).toFixed(1) + "px").join(" ");
        rule = `${sel} { transform: translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px) scale(${scale.toFixed(4)}) !important;` +
          ` transform-origin: 0 0 !important; clip-path: inset(${inset}) !important; }`;
        fitInfo = `${describe(stageEl)} tiles ${Math.round(cw)}×${Math.round(ch)} ${scale > 1.02 || scale < 0.98 ? "scaled ×" + scale.toFixed(2) : "centered"} via ${sel}`;
      } else fitInfo = `${describe(stageEl)} tiles ${Math.round(cw)}×${Math.round(ch)} ${hide ? "already fill" : "fit in"} ${Math.round(st.width)}×${Math.round(availH)}`;
    }
    if (!css && !rule) return false;
    if (!css) {
      css = document.createElement("style");
      css.id = "mt-stage-css";
      (document.head || document.documentElement).append(css);
    }
    css.textContent = rule;
    return rule !== before;
  }

  // Where the caption area sits and what holds it: sizes and structure, never text.
  function layoutReport() {
    if (!region) return null;
    const lines = [`window ${window.innerWidth}×${window.innerHeight}, hide ${settings.hideCaptions ? "on" : "off"}`];
    lines.push("stage fit: " + (fitInfo || "not run"));
    for (let el = region, i = 0; el && el !== document.documentElement && i < 10; el = el.parentElement, i++) {
      const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
      lines.push(`${"  ".repeat(i)}${describe(el)} ${Math.round(r.width)}×${Math.round(r.height)} at ${Math.round(r.top)}` +
        ` ${cs.display}/${cs.position}${cs.flex !== "0 1 auto" ? " flex " + cs.flex : ""}${cs.height !== "auto" ? " h " + cs.height : ""}` +
        `${el.classList.contains("mt-collapsed") ? " COLLAPSED" : ""}${el.querySelector("video") ? " +video" : ""} children ${el.children.length}`);
    }
    // How the call's main area is sized, cameras on or off: the blocks of the call layout (the
    // innermost window-sized container around the captions), two levels deep, with the
    // positioning the page sets on them. The one that stops short of the controls is the stage.
    const box = (el) => {
      const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
      const inline = ["top", "bottom", "left", "height", "inset", "transform"].map((k) => el.style[k] && `${k}:${el.style[k]}`).filter(Boolean).join(" ");
      return `${describe(el)} ${Math.round(r.width)}×${Math.round(r.height)} at ${Math.round(r.top)}–${Math.round(r.bottom)} ${cs.position}` +
        `${cs.bottom !== "auto" && cs.position !== "static" ? " bottom " + cs.bottom : ""}${inline ? " {" + inline + "}" : ""}` +
        `${el.contains(region) ? " ◀captions" : ""}${el.querySelector("video") ? " +video" : ""}`;
    };
    let call = region.parentElement || region;
    while (call.parentElement && call !== document.body && call.getBoundingClientRect().height < window.innerHeight * 0.9) call = call.parentElement;
    lines.push("call layout:", "  " + box(call));
    const big = (el) => [...el.children].filter((c) => { const r = c.getBoundingClientRect(); return r.width * r.height > 20000 || c.contains(region); });
    for (const c of big(call).slice(0, 12)) {
      lines.push("    " + box(c));
      for (const g of big(c).slice(0, 6)) lines.push("      " + box(g));
    }
    // From the main video (or a participant tile, cameras off) up to the call container: every
    // level, since the stage often hangs off zero-size wrappers. Computed offsets included,
    // so the level whose bottom stops short of the controls shows.
    const tile = document.querySelector("video") || document.querySelector("[data-participant-id]");
    if (tile) {
      lines.push("stage path:");
      for (let el = tile, i = 0; el && el !== call && i < 16; el = el.parentElement, i++) {
        const cs = getComputedStyle(el);
        const offs = ["top", "bottom", "height", "max-height", "transform", "inset"].map((k) => {
          const v = cs.getPropertyValue(k);
          return v && !/^(auto|none|0px|normal)$/.test(v) && !(k === "height") ? `${k} ${v}` : "";
        }).filter(Boolean).join(", ");
        lines.push(`  ${box(el)} ${cs.display}${offs ? " [" + offs + "]" : ""}`);
      }
    }
    return lines.join("\n");
  }

  async function tryEnableCaptions(force = false) {
    // Everything depends on captions, so they're always turned on; only not while paused,
    // which is how you keep a call out of your transcripts.
    if (!force && (settings.paused || autoTries >= 3 || Date.now() - lastAutoTry < 8000)) return;
    lastAutoTry = Date.now();
    autoTries++;
    try { await P.enableCaptions(); } catch (err) { console.warn("[Meeting Transcripts] couldn't turn on captions", err); }
  }

  function status() {
    return {
      platform: P.id,
      inMeeting: !!code && enabled(),
      disabled: !!code && !enabled(),
      captionsOn: !!region,
      stuck: stuck(),
      paused: settings.paused,
      count: session ? session.entries.length : 0,
      title: session ? MT.title(session.meta) : code ? P.eventTitle() || "Call" : "",
      meetingId: session ? session.meta.id : null,
      captionHint: P.captionHint,
    };
  }

  // A call page can be split into frames (Zoom's web client may be); the frame showing the
  // call answers for the tab, and the others stay quiet.
  const isTop = window === window.top;
  const showsCall = () => !!region || P.inCall();

  function sendStatus() {
    const s = status();
    renderPill(s);
    if (!isTop && !showsCall()) return;
    const sig = JSON.stringify([s.inMeeting, s.captionsOn, s.paused, s.disabled, s.stuck]);
    if (sig === lastStatus) return;
    lastStatus = sig;
    try { chrome.runtime.sendMessage({ type: "status", ...s }); } catch { shutdown(); }
  }

  function tick() {
    if (!alive) return;
    const id = P.callId();
    if (id && id !== code) {
      if (code) resetSession();
      code = id;
      attach(null);
    }
    // Teams and Zoom only show a call id while the call UI is up; give it a few seconds.
    const now = Date.now();
    missingSince = id || !code ? 0 : missingSince || now;
    if (missingSince && now - missingSince >= ENDED_AFTER_MS) {
      resetSession();
      code = null;
      attach(null);
    }
    if (code && enabled()) {
      const el = P.captionRegion();
      if (el !== region) attach(el);
      if (!region && P.inCall()) tryEnableCaptions();
      detectSelfName();
      collectParticipants();
      const inCall = !!region || P.inCall();
      if (inCall) outOfCallSince = 0;
      else if (!outOfCallSince) outOfCallSince = now;
      else if (outOfCallSince > 0 && now - outOfCallSince >= ENDED_AFTER_MS) {
        outOfCallSince = -1; // ended; stays so until the call UI is back
        endSession();
      }
      if (inCall) trackGap();
    } else if (region) {
      attach(null);
    }
    sendStatus();
  }

  // --- the in-call indicator --------------------------------------------------------------
  //
  // A small pill in the corner of the call: red while recording, with one click to pause,
  // resume or turn captions on. Only you see it.

  let pill = null;
  let pillHidden = false;

  function makePill() {
    const host = document.createElement("div");
    host.id = "meeting-transcripts-indicator";
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `<style>
      :host { all: initial; position: fixed; left: 16px; bottom: 96px; z-index: 2147483000; }
      .pill { display: flex; align-items: center; gap: 6px; height: 28px; padding: 0 4px 0 10px; border-radius: 999px;
        font: 600 12px/1 system-ui, -apple-system, "Segoe UI", sans-serif; color: #fff; letter-spacing: 0.01em;
        background: rgba(28, 28, 30, 0.82); backdrop-filter: blur(16px) saturate(180%); -webkit-backdrop-filter: blur(16px) saturate(180%);
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25), inset 0 0 0 0.5px rgba(255, 255, 255, 0.18);
        transition: transform 100ms ease-out, opacity 200ms ease; user-select: none; cursor: grab; touch-action: none; }
      .pill.dragging { cursor: grabbing; }
      .grip { width: 6px; height: 14px; margin-right: -2px; flex: none; opacity: 0.45;
        background: radial-gradient(circle, #fff 1px, transparent 1.3px) 0 0 / 3px 3.5px; }
      button { all: unset; cursor: pointer; display: flex; align-items: center; gap: 6px; height: 28px; }
      .main:active { transform: scale(0.97); }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: #8e8e93; flex: none; }
      .rec .dot { background: #ff453a; animation: pulse 1.6s ease-in-out infinite; }
      .warn .dot { background: #ff9f0a; }
      .cc { padding: 0 8px; border-radius: 999px; background: rgba(255, 255, 255, 0.14); font-size: 11px; }
      .cc:hover { background: rgba(255, 255, 255, 0.22); }
      .cc[hidden] { display: none; }
      .x { width: 20px; justify-content: center; border-radius: 50%; color: rgba(255, 255, 255, 0.6); font-size: 14px; }
      .x:hover { background: rgba(255, 255, 255, 0.14); color: #fff; }
      button:focus-visible { outline: 2px solid #0a84ff; outline-offset: 2px; border-radius: 999px; }
      @keyframes pulse { 50% { opacity: 0.35; } }
      @media (prefers-reduced-motion: reduce) { .rec .dot { animation: none; } .main:active { transform: none; } }
      @media (prefers-reduced-transparency: reduce) { .pill { background: #1c1c1e; backdrop-filter: none; } }
    </style><div class="pill" part="pill" title="Drag to move · double-click to put back"><span class="grip"></span><button class="main"><span class="dot"></span><span class="text"></span></button>` +
      `<button class="cc"></button>` +
      `<button class="x" aria-label="Hide for this call" title="Hide for this call">×</button></div>`;
    const [main, cc, x] = root.querySelectorAll("button");
    // Captions shown or hidden on screen, right from the call (same as the popup's switch).
    cc.addEventListener("click", () => MT.saveSettings({ hideCaptions: !settings.hideCaptions }));
    main.addEventListener("click", () => {
      if (settings.paused) MT.saveSettings({ paused: false });
      else if (region) MT.saveSettings({ paused: true });
      else tryEnableCaptions(true);
    });
    x.addEventListener("click", () => { pillHidden = true; host.remove(); pill = null; });
    const box = root.querySelector(".pill");
    makeDraggable(host, box, root);
    return { host, box, main, cc, text: root.querySelector(".text") };
  }

  // The pill can be dragged anywhere on the call page. Where it was left is kept as a share of
  // the free space (0 = left/top edge, 1 = right/bottom), so it lands in the same spot on any
  // window or screen size, and it's always kept fully on screen. Double-click puts it back.
  const PILL_POS = "pillPos";
  let pillPos = null; // { x, y } in 0..1, or null for the default corner

  function placePill(host) {
    if (!pillPos) { host.style.removeProperty("left"); host.style.removeProperty("top"); host.style.removeProperty("bottom"); return; }
    const w = host.offsetWidth, h = host.offsetHeight;
    const clamp = (v) => Math.min(1, Math.max(0, v));
    host.style.setProperty("left", Math.round(clamp(pillPos.x) * Math.max(0, window.innerWidth - w)) + "px", "important");
    host.style.setProperty("top", Math.round(clamp(pillPos.y) * Math.max(0, window.innerHeight - h)) + "px", "important");
    host.style.setProperty("bottom", "auto", "important");
  }

  function makeDraggable(host, box, root) {
    let start = null, moved = false;
    // Once pressed on the pill, the pointer is followed across the whole window (it soon
    // leaves the small pill). Not captured: a press that doesn't move stays a click on its button.
    const move = (e) => {
      if (!start || e.pointerId !== start.id) return;
      const dx = e.clientX - start.x, dy = e.clientY - start.y;
      if (!moved && Math.hypot(dx, dy) < 4) return; // a click, not a drag
      if (!moved) { moved = true; box.classList.add("dragging"); }
      e.preventDefault();
      const w = host.offsetWidth, h = host.offsetHeight;
      pillPos = { x: (start.left + dx) / Math.max(1, window.innerWidth - w), y: (start.top + dy) / Math.max(1, window.innerHeight - h) };
      placePill(host);
    };
    const end = (e) => {
      if (!start || e.pointerId !== start.id) return;
      start = null;
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", end, true);
      window.removeEventListener("pointercancel", end, true);
      box.classList.remove("dragging");
      if (moved) {
        pillPos = { x: Math.min(1, Math.max(0, pillPos.x)), y: Math.min(1, Math.max(0, pillPos.y)) };
        chrome.storage.local.set({ [PILL_POS]: pillPos });
        setTimeout(() => { moved = false; }, 0); // after the click that ends the drag
      }
    };
    box.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const r = host.getBoundingClientRect();
      start = { x: e.clientX, y: e.clientY, left: r.left, top: r.top, id: e.pointerId };
      moved = false;
      window.addEventListener("pointermove", move, true);
      window.addEventListener("pointerup", end, true);
      window.addEventListener("pointercancel", end, true);
    });
    // Its text changes its width ("Paused", "Recording captions"…): keep it in place, on screen.
    new ResizeObserver(() => placePill(host)).observe(box);
    // The click that ends a drag isn't a click on the button under it.
    root.addEventListener("click", (e) => { if (moved) { e.stopPropagation(); e.preventDefault(); } }, true);
    box.addEventListener("dblclick", (e) => {
      if (e.target.closest("button")) return;
      pillPos = null;
      chrome.storage.local.remove(PILL_POS);
      placePill(host);
    });
  }

  function renderPill(s) {
    const show = s.inMeeting && settings.showIndicator !== false && !pillHidden && (!!region || P.inCall());
    if (!show) {
      if (pill) { pill.host.remove(); pill = null; }
      return;
    }
    if (!pill) pill = makePill();
    if (!pill.host.isConnected) { document.documentElement.append(pill.host); placePill(pill.host); }
    const [cls, text, tip] = s.paused
      ? ["warn", "Paused", "Meeting Transcripts is paused. Click to resume recording."]
      : s.stuck
        ? ["warn", "Captions on · nothing recorded", "The captions on screen aren't being picked up: the page has probably changed. " +
          "Click Meeting Transcripts in Chrome's toolbar and Copy a report."]
      : s.captionsOn
        ? ["rec", "Recording captions", "Meeting Transcripts is saving this call's captions. Click to pause."]
        : ["warn", "Captions off · not recording", "Click to turn on captions. " + P.captionHint];
    pill.box.className = "pill " + cls;
    pill.text.textContent = text;
    pill.main.title = tip;
    pill.cc.hidden = !region || s.paused;
    pill.cc.textContent = settings.hideCaptions ? "Show captions" : "Hide captions";
    pill.cc.title = settings.hideCaptions ? "Show the captions on screen (still recording either way)"
      : "Hide the captions on screen and keep recording";
  }

  // --- diagnostics ---------------------------------------------------------------------------
  //
  // When captions aren't picked up (most likely after Teams or Zoom changes its page), the
  // popup copies this report: the structure of the page around the captions, never the
  // caption text itself.

  // Labels are shown only when every word is a generic control word: tiles and buttons on a call
  // page carry participants' names ("Pin Arthy Moorthy"), and a report must hold no names.
  const SAFE_WORDS = new Set(("captions caption turn on off open close jump to the most recent settings type language and " +
    "speech microphone mic camera video leave call end hang up more options live show hide chat people participants present " +
    "presenting now raise lower hand reactions closed transcript transcription subtitles c d e menu toolbar controls meeting " +
    "details activities share screen apps panel") .split(" "));
  const safeLabel = (label) => (label.toLowerCase().match(/[a-z]+/g) || []).every((w) => SAFE_WORDS.has(w));
  function describe(el) {
    const attrs = ["data-tid", "role", "aria-live", "jsname"].map((a) => el.getAttribute(a) && `[${a}=${el.getAttribute(a)}]`).filter(Boolean);
    const aria = el.getAttribute("aria-label");
    if (aria) attrs.push(safeLabel(aria) ? `[aria-label=${aria.slice(0, 40)}${aria.length > 40 ? "…" : ""}]` : "[aria-label=…]");
    // The page's first classes, plus ours (mt-…) wherever they are, to show what we changed.
    const all = typeof el.className === "string" ? el.className.trim().split(/\s+/).filter(Boolean) : [];
    const shown = [...all.filter((c) => !c.startsWith("mt-")).slice(0, 4), ...all.filter((c) => c.startsWith("mt-"))];
    const cls = shown.length ? "." + shown.join(".") : "";
    return `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}${cls}${attrs.join("")} (${(el.textContent || "").length} chars)`;
  }

  function outline(el, depth, indent = "") {
    let out = indent + describe(el) + "\n";
    if (depth > 0) for (const c of [...el.children].slice(0, 6)) out += outline(c, depth - 1, indent + "  ");
    return out;
  }

  function diagnose() {
    const candidates = [...document.querySelectorAll("[id], [class], [data-tid], [aria-label]")].filter((el) =>
      /caption|subtitle|transcri/i.test([el.id, typeof el.className === "string" ? el.className : "",
        el.getAttribute("data-tid"), el.getAttribute("aria-label")].join(" "))).slice(0, 12);
    return {
      extension: chrome.runtime.getManifest().version,
      platform: P.id,
      page: location.hostname + location.pathname.replace(/\d{5,}/g, "<number>"),
      inCall: P.inCall(),
      captionsFound: !!region,
      blocks: region ? P.blocks(region).length : 0,
      linesRecorded: session ? session.entries.length : 0,
      captionArea: region ? outline(region, 3) : null,
      captionLayout: layoutReport(),
      candidates: candidates.map((el) => outline(el, 2)),
    };
  }

  function shutdown() {
    alive = false;
    if (observer) observer.disconnect();
    if (pill) pill.host.remove();
  }

  async function init() {
    settings = await MT.getSettings();
    selfName = (await chrome.storage.local.get(SELF_KEY))[SELF_KEY] || "";
    stuckAfter = (await chrome.storage.local.get("stuckAfterMs")).stuckAfterMs || STUCK_MS;
    pillPos = (await chrome.storage.local.get(PILL_POS))[PILL_POS] || null;
    chrome.storage.onChanged.addListener((changes) => {
      if (changes[PILL_POS]) { pillPos = changes[PILL_POS].newValue || null; if (pill) placePill(pill.host); } // moved in another call tab
      if (!changes.settings) return;
      settings = { ...settings, ...changes.settings.newValue };
      applyHide();
      lastStatus = "";
      trackGap();
      sendStatus();
    });
    chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
      if ((msg.type === "getStatus" || msg.type === "diagnose") && !showsCall()) {
        if (!isTop) return false;
        // Give a frame that shows the call the chance to answer first.
        setTimeout(() => reply(msg.type === "getStatus" ? status() : diagnose()), 200);
        return true;
      }
      if (msg.type === "getStatus") reply(status());
      if (msg.type === "diagnose") reply(diagnose());
      if (msg.type === "enableCaptions") tryEnableCaptions(true).then(() => reply(status()));
      if (msg.type === "flush") save().then(() => reply(status()));
      return msg.type === "flush" || msg.type === "enableCaptions";
    });
    window.addEventListener("pagehide", save);
    // A new window size (resized, or moved to another screen) moves the controls: refit the
    // stage. Our own resize signal changes nothing here, so it doesn't loop.
    // Meet re-renders its layout without touching the captions: re-check, hidden or shown.
    setInterval(() => { if (region) applyHide(); }, 1000);
    let resizeTimer = 0;
    window.addEventListener("resize", () => {
      if (pill) placePill(pill.host); // same spot, still on screen
      clearTimeout(resizeTimer); resizeTimer = setTimeout(applyHide, 150);
    });
    document.addEventListener("visibilitychange", () => document.hidden && save());
    const loop = () => {
      tick();
      if (alive) setTimeout(loop, code && !region && enabled() ? FAST_POLL_MS : POLL_MS);
    };
    loop();
  }

  init();
})();
