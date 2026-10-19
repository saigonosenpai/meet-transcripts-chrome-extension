// End-to-end test: loads the extension in Chromium, serves a fake Meet call, and checks
// the stored transcript and the .docx file it saves to Downloads/Meeting Transcripts. Teams and
// Zoom run the same way against their own mock pages.
//   node tests/e2e.mjs [extension dir, default: the repo root] [screenshot dir]
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";

import { chromium } from "playwright";

const ext = path.resolve(process.argv[2] || new URL("..", import.meta.url).pathname);
const shots = process.argv[3] || ".";
const fixture = (name) => fs.readFileSync(new URL("./fixtures/" + name, import.meta.url), "utf8");
const mock = fixture("mock-meet.html");
// Launch Chromium ourselves and attach over CDP: Playwright's own launch intercepts
// downloads and renames them, and we want to see the files exactly as Chrome saves them.
async function launch({ askWhereToSave = false } = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "mt-profile-"));
  const downloads = fs.mkdtempSync(path.join(os.tmpdir(), "mt-downloads-"));
  fs.mkdirSync(path.join(profile, "Default"));
  fs.writeFileSync(path.join(profile, "Default", "Preferences"),
    JSON.stringify({ download: { default_directory: downloads, prompt_for_download: askWhereToSave } }));
  const port = 9300 + Math.floor(Math.random() * 500);
  const proc = spawn(chromium.executablePath(), [
    "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run",
    // Containers run as root, and CI runners' AppArmor blocks Chromium's sandbox.
    ...(process.env.CI || (process.getuid && process.getuid() === 0) ? ["--no-sandbox"] : []),
    `--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "about:blank",
  ], { stdio: "ignore" });
  let browser;
  for (let i = 0; i < 50 && !browser; i++) {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => null);
    if (!browser) await new Promise((r) => setTimeout(r, 200));
  }
  // Playwright redirects downloads to GUID-named files even when attached; restore Chrome's own behavior.
  await (await browser.newBrowserCDPSession()).send("Browser.setDownloadBehavior", { behavior: "default" });
  return { browser, ctx: browser.contexts()[0], downloads, close: async () => { await browser.close(); proc.kill(); } };
}

const { ctx, downloads, close } = await launch();
await ctx.route("https://meet.google.com/**", (r) => r.fulfill({ contentType: "text/html", body: mock }));

// The extension ID follows from the manifest key; any extension page can read its storage.
const key = Buffer.from(JSON.parse(fs.readFileSync(path.join(ext, "manifest.json"))).key, "base64");
const id = [...createHash("sha256").update(key).digest("hex").slice(0, 32)]
  .map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
const sw = await ctx.newPage();
await sw.goto(`chrome-extension://${id}/viewer/viewer.html`);
const today = new Date(); const pad = (n) => String(n).padStart(2, "0");
const date = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
const dayDir = path.join(downloads, "Meeting Transcripts", date);
assert.equal((await sw.evaluate(() => MT.getSettings())).hideCaptions, true, "captions are hidden on screen by default");
const fileOf = (mid) => sw.evaluate((k) => chrome.storage.local.get(k).then((d) => d[k]), "f:" + mid);

// Names read together with a hidden copy of themselves are collapsed; real names are left alone.
const deduped = await sw.evaluate(() => [
  "Isuru IlangarathneIsuru Ilangarathne", "Chathuranga BalasooriyaChathuranga Bala", "AnnAnn",
  "McDonald", "Ann McAnn", "DeShawn De", "Mary-Jane O'Neil", "Lee Lee", "Ó SúilleabháinÓ Súil",
].map(MT.dedupeName));
assert.deepEqual(deduped, ["Isuru Ilangarathne", "Chathuranga Balasooriya", "Ann",
  "McDonald", "Ann McAnn", "DeShawn De", "Mary-Jane O'Neil", "Lee Lee", "Ó Súilleabháin"]);

// --- a scheduled call ("Weekly sync") ---------------------------------------------------------
// No name configured: "You" in captions must become the Google account name, "Sam Lee".
const page = await ctx.newPage();
await page.goto("https://meet.google.com/abc-defg-hij");
await page.waitForFunction(() => window.done, null, { timeout: 30000 });
await page.waitForTimeout(2500);
let data = await sw.evaluate(() => chrome.storage.local.get(null));
const meta = Object.values(data.meetings)[0];
const t = data["t:" + meta.id];
console.log("meeting:", JSON.stringify({ title: meta.title, participants: meta.participants, speakers: meta.speakers }));
const bob = t.filter((e) => e.speaker === "Bob").map((e) => e.text).join(" ");
for (let i = 1; i <= 30; i++) assert.equal(bob.split(`Sentence number ${i} `).length, 2, `sentence ${i} once`);
assert.deepEqual(meta.speakers, ["Alice", "Sam Lee", "Bob"]);
assert.equal(meta.title, "Weekly sync");
assert.equal(data["f:" + meta.id], undefined, "nothing saved mid-call");

// Leave the call -> the .docx is saved.
await page.evaluate(() => window.leave());
const fileState = () => fileOf(meta.id);
let file;
for (let i = 0; i < 40 && !(file = await fileState()); i++) await page.waitForTimeout(250);
assert.ok(file && !file.error, "saved after leaving: " + JSON.stringify(file));
const expected = `${date} - Weekly sync - Alice, Bob, Carol Diaz, Sam Lee.docx`;
console.log("saved:", file.filename);
assert.equal(path.basename(file.filename), expected);
assert.equal(path.dirname(file.filename), dayDir, "grouped in a folder per day");
assert.ok(fs.existsSync(file.filename));
fs.copyFileSync(file.filename, shots + "/saved.docx");

// --- the user's Word document is theirs once the call is over --------------------------------
// Edited in Word, then the call renamed: the edits must survive. The viewer offers an update
// instead (a new copy, or replace), never a silent rewrite.
assert.equal((await fileState()).final, true, "saved as the call ended: final");
fs.appendFileSync(file.filename, Buffer.from("notes typed in Word"));
const edited = fs.readFileSync(file.filename);
const v = await ctx.newPage();
await v.setViewportSize({ width: 1200, height: 900 });
await v.goto(`chrome-extension://${id}/viewer/viewer.html#` + encodeURIComponent(meta.id));
await v.waitForSelector("#showFile");
await v.click("#title");
await v.keyboard.press("End");
await v.keyboard.type(" (Q4)");
await v.keyboard.press("Enter");
await v.waitForFunction(() => document.querySelector("#file").textContent.includes("Changed since"), null, { timeout: 10000 });
await v.waitForTimeout(1000);
assert.ok(fs.existsSync(file.filename) && fs.readFileSync(file.filename).equals(edited), "edited document left exactly as it was");
assert.equal((await fileState()).filename, file.filename, "still the same document");
assert.equal(await v.textContent("#saveNow"), "Update .docx…");
// Update › Save as a new copy: a new document with the new name; the edited one stays.
await v.click("#saveNow");
await v.waitForSelector("#saveMenu.open");
await v.click('#saveMenu [data-mode="copy"]');
await v.waitForFunction(() => document.querySelector("#file").textContent.includes("(Q4)"));
const renamed = await fileState();
console.log("renamed:", path.basename(renamed.filename));
assert.ok(path.basename(renamed.filename).includes("Weekly sync (Q4) - Alice"));
assert.ok(fs.existsSync(renamed.filename), "new copy exists");
assert.ok(fs.readFileSync(file.filename).equals(edited), "the edited document is kept, untouched");
assert.ok(!renamed.outdated && renamed.final, "the copy is up to date, and itself final");
// Let Chrome finish writing before listing the folder (an unfinished download shows as
// "Unconfirmed ….crdownload").
const listing = () => fs.readdirSync(path.dirname(renamed.filename)).sort();
for (let i = 0; i < 40 && listing().some((f) => f.endsWith(".crdownload")); i++) await v.waitForTimeout(250);
assert.deepEqual(listing(), [path.basename(file.filename), path.basename(renamed.filename)].sort());
// Save again › Replace: rewrites the call's own (current) document, nothing else.
await v.click("#saveNow");
await v.waitForSelector("#saveMenu.open");
await v.click('#saveMenu [data-mode="replace"]');
await v.waitForFunction((t) => document.querySelector("#saveNow") && !document.querySelector("#saveNow").disabled, renamed.savedAt);
await v.waitForTimeout(800);
const replaced = await fileState();
assert.equal(replaced.filename, renamed.filename, "replaced in place");
assert.ok(replaced.savedAt > renamed.savedAt, "rewritten");
assert.ok(fs.readFileSync(file.filename).equals(edited), "the edited document still untouched");
console.log("Word edits: kept after a rename; Update offers a new copy or replace");
// The edited original is the user's now; out of the way for the rest of the test.
fs.unlinkSync(file.filename);

// --- find in a transcript: text with &, <, > and " highlights correctly -----------------------------
{
  const T0 = Date.now() - 600_000;
  await v.evaluate((T0) => MT.saveMeeting({ id: "hl-1", code: "hig-hlig-hte", eventTitle: "Highlight test", startedAt: T0, endedAt: T0 + 60_000 },
    [{ speaker: "Ann", text: 'Tom & Jerry said "a <b>bold</b> plan" > the old one.', ts: T0 }]), T0);
  await v.goto(`chrome-extension://${id}/viewer/viewer.html#hl-1`);
  await v.waitForSelector(".turn p");
  const shown = async (q) => {
    await v.fill("#search", q);
    await v.waitForTimeout(200);
    return v.evaluate(() => { const p = document.querySelector(".turn p");
      return { text: p.textContent, marks: [...p.querySelectorAll("mark")].map((m) => m.textContent), bold: !!p.querySelector("b") }; });
  };
  const said = 'Tom & Jerry said "a <b>bold</b> plan" > the old one.';
  let r = await shown("a");
  assert.equal(r.text, said, "text shown as written");
  assert.deepEqual(r.marks, ["a", "a", "a"], "only the real a's marked (none inside &amp;)");
  assert.ok(!r.bold, "no markup from the text");
  r = await shown("&");
  assert.deepEqual([r.text, r.marks], [said, ["&"]]);
  r = await shown("<b>");
  assert.deepEqual([r.text, r.marks], [said, ["<b>"]]);
  r = await shown('"');
  assert.deepEqual([r.text, r.marks], [said, ['"', '"']]);
  await v.fill("#search", "");
  await v.evaluate(() => MT.deleteMeeting("hl-1"));
  await v.goto(`chrome-extension://${id}/viewer/viewer.html#` + encodeURIComponent(meta.id));
  await v.waitForSelector(".turn p");
  console.log("find: &, <, > and \" highlight as written");
}
await v.screenshot({ path: shots + "/viewer.png" });

// --- delete is immediate and undoable (no blocking confirm dialog) ---------------------------------
const before = await sw.evaluate((k) => chrome.storage.local.get(k), ["meetings", "t:" + meta.id, "f:" + meta.id]);
await v.click("#delete");
await v.waitForSelector("#toast.show");
assert.match(await v.textContent("#toastText"), /^Deleted “Weekly sync \(Q4\)”/);
assert.equal((await sw.evaluate(() => chrome.storage.local.get("meetings"))).meetings[meta.id], undefined, "deleted");
await v.click("#toastAction");
await v.waitForFunction((id) => location.hash.includes(encodeURIComponent(id)), meta.id);
await v.waitForSelector(".turn p");
const after = await sw.evaluate((k) => chrome.storage.local.get(k), ["meetings", "t:" + meta.id, "f:" + meta.id]);
assert.equal(after.meetings[meta.id].title, before.meetings[meta.id].title, "title restored");
assert.deepEqual(after["t:" + meta.id], before["t:" + meta.id], "transcript restored");
assert.deepEqual(after["f:" + meta.id], before["f:" + meta.id], "saved-file record restored");
assert.equal(await v.textContent("#title"), "Weekly sync (Q4)");
console.log("delete + undo: restored");

// --- the library fits any window width: nothing spills sideways, pop-ups open on screen ------------
{
  const size = v.viewportSize() || { width: 1280, height: 800 };
  const fit = () => v.evaluate(() => {
    const out = [];
    if (document.documentElement.scrollWidth > innerWidth + 1) out.push(`page ${document.documentElement.scrollWidth}px wide`);
    for (const e of document.querySelectorAll(".toolbar button, .toolbar input, .sidebar-foot .btn, #title, .spk, #libSearch")) {
      const r = e.getBoundingClientRect();
      if (e.closest(".popover")) continue; // menus: checked when open
      if (r.width && (r.left < -1 || r.right > innerWidth + 1)) out.push(`${e.id || e.className || e.tagName} at ${Math.round(r.left)}–${Math.round(r.right)}`);
    }
    // Toolbar controls never on top of each other.
    const bs = [...document.querySelectorAll(".toolbar > *:not(.spacer):not(.thumb)")].map((e) => [e, e.getBoundingClientRect()]).filter(([, r]) => r.width);
    for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) {
      const a = bs[i][1], b = bs[j][1];
      if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 2 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 2) out.push(`overlap ${bs[i][0].className || bs[i][0].id} × ${bs[j][0].className || bs[j][0].id}`);
    }
    return out;
  });
  const onScreen = (sel) => v.evaluate((sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return r.left >= -1 && r.right <= innerWidth + 1; }, sel);
  for (const w of [1280, 1024, 900, 760, 600, 414, 375, 320]) {
    await v.setViewportSize({ width: w, height: 800 });
    await v.waitForTimeout(250);
    assert.deepEqual(await fit(), [], `library fits at ${w}px`);
    await v.click("#exportBtn");
    await v.waitForTimeout(300);
    assert.ok(await onScreen("#exportMenu"), `Export menu on screen at ${w}px`);
    await v.keyboard.press("Escape");
    await v.waitForTimeout(250);
  }
  await v.setViewportSize(size);
  console.log("library: fits and menus open on screen from 1280px down to 320px");
}

const p = await ctx.newPage();
await p.setViewportSize({ width: 340, height: 600 });
await p.goto(`chrome-extension://${id}/popup/popup.html`);
await p.waitForTimeout(500);
assert.ok((await p.textContent("#lastSaved")).includes("(Q4)"));
// The library at a glance: one call, its document (and library.json) on disk.
await p.waitForFunction(() => document.getElementById("size").textContent !== "–");
const stats = await p.evaluate(() => ["calls", "recorded", "size", "statsDetail"].map((id) => document.getElementById(id).textContent));
console.log("popup stats:", stats.join(" | "));
const manifestVersion = JSON.parse(fs.readFileSync(path.join(ext, "manifest.json"))).version;
assert.equal(await p.textContent("#version"), "v" + manifestVersion, "popup shows the installed version");
assert.equal(stats[0], "1");
assert.match(stats[2], /^\d+(\.\d)? (KB|MB)$/);
assert.match(stats[3], /^Meet 1 · 1 Word document/);
await p.screenshot({ path: shots + "/popup.png" });

// --- spontaneous calls: named after who else joined ---------------------------------------------
async function runCall(code) {
  const pg = await ctx.newPage();
  await pg.goto("https://meet.google.com/" + code);
  await pg.waitForFunction(() => window.done, null, { timeout: 30000 });
  await pg.waitForTimeout(2000);
  await pg.evaluate(() => window.leave());
  const { meetings } = await sw.evaluate(() => chrome.storage.local.get("meetings"));
  const m = Object.values(meetings).find((x) => x.code === code);
  let f;
  for (let i = 0; i < 40 && !(f = await fileOf(m.id)); i++) await pg.waitForTimeout(250);
  await pg.close();
  return { m, f };
}
const call1 = await runCall("xtk-wiod-gkq");
console.log("spontaneous:", call1.m.title, "->", path.basename(call1.f.filename));
assert.equal(call1.m.title, "Call with Alice, Bob, Carol Diaz");
assert.equal(call1.f.filename, path.join(dayDir, `${date} - Call with Alice, Bob, Carol Diaz.docx`));
// Same people again the same day: a second file, not an overwrite.
const call2 = await runCall("pqr-stuv-wxy");
console.log("second call, same people:", path.basename(call2.f.filename));
assert.equal(call2.f.filename, path.join(dayDir, `${date} - Call with Alice, Bob, Carol Diaz (2).docx`));
assert.equal(fs.readdirSync(dayDir).length, 3);

// Recordings from before this version stored "Meet <code>" for untitled calls.
assert.equal(await sw.evaluate(() => MT.title({ title: "Meet xtk-wiod-gkq", speakers: ["You"] })), "Solo call");
assert.equal(await sw.evaluate(() => MT.title({ title: "Meet xtk-wiod-gkq", speakers: ["Ann", "You"] })), "Call with Ann");
assert.equal(await sw.evaluate(() => MT.title({ title: "Weekly sync", speakers: ["Ann"] })), "Weekly sync");

await v.goto(`chrome-extension://${id}/viewer/viewer.html#` + encodeURIComponent(call1.m.id));
await v.waitForSelector("#showFile");
await v.screenshot({ path: shots + "/viewer-list.png" });

// --- reinstall: settings.json + .docx files bring everything back -------------------------------
await v.evaluate(() => MT.saveSettings({ myName: "Sam Lee", hideCaptions: true }));
// A fresh install that hasn't restored yet keeps its calls in an interim file, never library.json.
const libraryPath = path.join(downloads, "Meeting Transcripts", "library (since reinstall).json");
const readLibrary = () => { try { return JSON.parse(fs.readFileSync(libraryPath, "utf8")); } catch { return null; } };
for (let i = 0; i < 60 && readLibrary()?.settings?.myName !== "Sam Lee"; i++) await v.waitForTimeout(250);
const savedLib = readLibrary();
assert.deepEqual({ ...savedLib.settings, showIndicator: undefined, platforms: undefined, nameMap: undefined },
  { hideCaptions: true, myName: "Sam Lee", autoSave: true, showIndicator: undefined, platforms: undefined, nameMap: undefined });
assert.deepEqual(savedLib.settings.platforms, { meet: true, teams: true, zoom: true });
assert.equal(Object.keys(savedLib.meetings).length, 3);
console.log("library.json written:", Object.keys(savedLib.meetings).length, "meetings,", JSON.stringify(savedLib.settings));

const titlesBefore = (await v.evaluate(async () => (await MT.listMeetings()).map((m) => MT.title(m)))).sort();
const linesBefore = await v.evaluate(async () => Object.fromEntries(await Promise.all(
  (await MT.listMeetings()).map(async (m) => [MT.title(m), (await MT.getTranscript(m.id)).length]))));
await v.evaluate(() => chrome.storage.local.clear()); // what removing the extension does
await v.goto("about:blank");
await v.goto(`chrome-extension://${id}/viewer/viewer.html#welcome`);
await v.waitForSelector("#emptyLib:not([hidden])");
assert.ok(await v.$("#importBtn.pulse"), "Import highlighted on a fresh library");
// What picking the folder hands the page: every file in it, day folders included.
const folderFiles = fs.readdirSync(path.join(downloads, "Meeting Transcripts"), { recursive: true })
  .map((f) => path.join(downloads, "Meeting Transcripts", f)).filter((f) => fs.statSync(f).isFile());
await v.evaluate(() => document.getElementById("importInput").removeAttribute("webkitdirectory"));
await v.setInputFiles("#importInput", folderFiles);
await v.waitForSelector("#toast.show");
console.log("restore:", await v.textContent("#toastText"));
const titlesAfter = (await v.evaluate(async () => (await MT.listMeetings()).map((m) => MT.title(m)))).sort();
assert.deepEqual(titlesAfter, titlesBefore, "every meeting restored");
const linesAfter = await v.evaluate(async () => Object.fromEntries(await Promise.all(
  (await MT.listMeetings()).map(async (m) => [MT.title(m), (await MT.getTranscript(m.id)).length]))));
assert.deepEqual(linesAfter, linesBefore, "every line restored, exactly as recorded");
// library.json comes first; the .docx files of the same calls are recognized, not added twice.
assert.equal(await v.textContent("#toastText"), "Imported 3 calls · settings · 3 already here");
// After a restore, library.json holds everything and the interim file is gone.
const mainLib = path.join(downloads, "Meeting Transcripts", "library.json");
for (let i = 0; i < 60 && !(fs.existsSync(mainLib) && !fs.existsSync(libraryPath)); i++) await v.waitForTimeout(250);
assert.equal(Object.keys(JSON.parse(fs.readFileSync(mainLib, "utf8")).meetings).length, 3, "library.json has all 3");
assert.ok(!fs.existsSync(libraryPath), "interim file removed");
console.log("folder now:", fs.readdirSync(path.join(downloads, "Meeting Transcripts")).join(" | "));
const restored = await v.evaluate(() => MT.getSettings());
assert.equal(restored.myName, "Sam Lee");
assert.equal(restored.hideCaptions, true);
console.log("restored meetings:", titlesAfter.join(" | "));

// --- hiding captions: the caption strip gives its space back, and recording goes on ---------------
{
  // "Hide captions on screen" is on (restored above).
  const hp = await ctx.newPage();
  await hp.setViewportSize({ width: 1000, height: 700 });
  await hp.goto("https://meet.google.com/hid-ecap-tns");
  await hp.waitForFunction(() => window.done, null, { timeout: 30000 });
  await hp.waitForTimeout(800);
  // The tile block as seen on screen (after any scaling), and where the controls start.
  const layout = () => hp.evaluate(() => ({
    tile: (({ top, bottom, left, right, width, height }) => ({ top, bottom, left, right, width, height }))(document.getElementById("grid").getBoundingClientRect()),
    stage: document.getElementById("stage").getBoundingClientRect().height,
    strip: document.getElementById("capbar").getBoundingClientRect().height,
    captionsLeft: document.querySelector('[role="region"]').getBoundingClientRect().left,
    controls: document.getElementById("controls").getBoundingClientRect().height,
  }));
  // Hidden captions: the tiles fill the space down to 16px above the controls, or the stage's
  // width if that comes first, centered, and never over the controls.
  const fits = (l, w, h, what) => {
    const t = l.tile, floor = h - 80 - 16, near = (a, b) => Math.abs(a - b) <= 2;
    assert.ok(t.top >= -1 && t.left >= -1 && t.right <= w + 1, `${what}: tiles stay on screen ${JSON.stringify(t)}`);
    assert.ok(t.bottom <= floor + 1, `${what}: tiles stay above the controls ${JSON.stringify(t)}`);
    assert.ok(near(t.bottom, floor) || near(t.width, w - 32), `${what}: tiles fill the space ${JSON.stringify(t)}`);
    assert.ok(near(t.left - 16, w - 16 - t.right), `${what}: tiles centered ${JSON.stringify(t)}`);
    // As wide as they can be (a row of cameras, a tall window): centered top to bottom too.
    if (!near(t.bottom, floor)) assert.ok(near(t.top, floor - t.bottom), `${what}: tiles centered top to bottom ${JSON.stringify(t)}`);
  };
  const hidden = await layout();
  console.log("captions hidden:", JSON.stringify(hidden));
  assert.equal(hidden.strip, 0, "caption strip collapsed");
  fits(hidden, 1000, 700, "1000×700");
  assert.ok(hidden.tile.height > 500, "tiles grew from 440px: " + hidden.tile.height);
  assert.equal(hidden.controls, 80, "controls untouched");
  assert.ok(hidden.captionsLeft < -5000, "captions moved off-screen");
  const recordedLines = () => sw.evaluate(async () => {
    const m = Object.values((await chrome.storage.local.get("meetings")).meetings || {}).find((x) => x.code === "hid-ecap-tns");
    return m ? (await chrome.storage.local.get("t:" + m.id))["t:" + m.id] || [] : [];
  });
  let lines = [];
  for (let i = 0; i < 40 && !lines.some((e) => e.text.includes("Great, thanks everyone.")); i++) {
    lines = await recordedLines();
    await hp.waitForTimeout(250);
  }
  assert.ok(lines.some((e) => e.text.includes("Great, thanks everyone.")), "still recording while hidden");
  // Any screen size, and resizing mid-call (Meet re-sets its own offset when the window resizes).
  // Only on real resizes: Meet doesn't lay out again for the resize event the extension sends.
  await hp.evaluate(() => addEventListener("resize", (e) => e.isTrusted && layoutStage()));
  // Nothing spills past the stage: scaled up, the stage is clipped to the space it fills, so its
  // empty edges don't cover the window's edges or the controls, nor take their clicks.
  const overflow = () => hp.evaluate(() => {
    const stage = document.getElementById("stage"), st = getComputedStyle(stage);
    const area = { left: parseFloat(st.left), right: innerWidth - parseFloat(st.right), bottom: document.getElementById("controls").getBoundingClientRect().top };
    const onStage = (x, y) => stage.contains(document.elementFromPoint(x, y));
    const out = [[2, 200], [innerWidth - 3, 200], [area.right + 2, 200], [innerWidth / 2, area.bottom + 4]]
      .filter(([x, y]) => x < area.left || x > area.right || y > area.bottom).filter(([x, y]) => onStage(x, y));
    const cp = getComputedStyle(stage).clipPath;
    return { covered: out, clipped: cp !== "none" || getComputedStyle(stage).transform === "none" };
  });
  const sizes = [[1366, 768], [1920, 1080], [2560, 1440], [1280, 720], [800, 500], [700, 1000], [3440, 1440], [1024, 640], [1536, 864]];
  for (const [w, h] of sizes) {
    await hp.setViewportSize({ width: w, height: h });
    await hp.waitForTimeout(500);
    const l = await layout();
    assert.equal(l.strip, 0, `strip collapsed at ${w}×${h}`);
    fits(l, w, h, `${w}×${h}`);
    const o = await overflow();
    assert.deepEqual(o.covered, [], `nothing spills past the stage at ${w}×${h}`);
    assert.ok(o.clipped, `stage clipped when scaled at ${w}×${h}`);
  }
  // Resizing in small steps, as when dragging the window's edge: it refits every time.
  for (let w = 1400; w >= 900; w -= 125) {
    await hp.setViewportSize({ width: w, height: Math.round(w * 0.6) });
    await hp.waitForTimeout(250);
  }
  await hp.waitForTimeout(400);
  fits(await layout(), 900, 540, "after dragging the window smaller");
  // A side panel open (chat, people): Meet narrows the stage, and the tiles stay out of the panel.
  await hp.setViewportSize({ width: 1440, height: 900 });
  await hp.evaluate(() => {
    const panel = document.createElement("aside");
    panel.id = "panel";
    panel.style.cssText = "position:absolute;top:16px;right:16px;bottom:96px;width:344px;background:#222";
    document.body.prepend(panel); // earlier in the page: the stage paints over it if it spills
    document.getElementById("stage").style.right = "376px";
    layoutStage();
  });
  await hp.waitForTimeout(1500);
  {
    const t = (await layout()).tile, floor = 900 - 80 - 16, near = (a, b) => Math.abs(a - b) <= 2;
    assert.ok(t.left >= 15 && t.right <= 1440 - 376 + 1 && t.bottom <= floor + 1 && t.top >= -1, "tiles stay beside the side panel " + JSON.stringify(t));
    assert.ok(near(t.left - 16, 1440 - 376 - t.right), "tiles centered on the narrower stage " + JSON.stringify(t));
    assert.ok(t.height > 500, "tiles still enlarged beside the panel " + JSON.stringify(t));
    const hits = await hp.evaluate(() => [[1440 - 300, 150], [1440 - 200, 450], [1440 - 360, 700]]
      .map(([x, y]) => document.elementFromPoint(x, y)?.id));
    assert.deepEqual(hits, ["panel", "panel", "panel"], "the side panel stays visible and clickable");
  }
  await hp.evaluate(() => { document.getElementById("panel").remove(); document.getElementById("stage").style.right = ""; layoutStage(); });
  await hp.setViewportSize({ width: 1000, height: 700 });
  await hp.waitForTimeout(500);
  console.log("hide captions: tiles fit, nothing spills past the stage at", sizes.map((s) => s.join("×")).join(", "), "· while resizing · with a side panel open");

  // The in-call indicator can be dragged anywhere and stays where it was left.
  {
    const pillRect = () => hp.evaluate(() => (({ left, top, right, bottom, width, height }) => ({ left, top, right, bottom, width, height }))(
      document.getElementById("meeting-transcripts-indicator").getBoundingClientRect()));
    const before = await pillRect();
    const pausedBefore = (await sw.evaluate(() => MT.getSettings())).paused;
    // Grab it by its grip (left end) and drag it to the top right.
    const gx = before.left + 6, gy = before.top + before.height / 2;
    await hp.mouse.move(gx, gy);
    await hp.mouse.down();
    for (let i = 1; i <= 10; i++) await hp.mouse.move(gx + (700 - gx) * i / 10, gy + (40 - gy) * i / 10);
    await hp.mouse.up();
    await hp.waitForTimeout(300);
    const moved = await pillRect();
    // Where the grab point was taken, unless that would put the pill past the window's edge
    // (its width depends on the system's fonts).
    const wantLeft = Math.min(700 - 6, 1000 - moved.width);
    assert.ok(Math.abs(moved.left - wantLeft) <= 2 && Math.abs(moved.top + moved.height / 2 - 40) <= 2, "pill follows the drag " + JSON.stringify(moved));
    assert.equal((await sw.evaluate(() => MT.getSettings())).paused, pausedBefore, "dragging isn't a click: recording not paused");
    const saved = await sw.evaluate(() => chrome.storage.local.get("pillPos").then((d) => d.pillPos));
    assert.ok(saved && saved.x > 0 && saved.y >= 0, "position saved " + JSON.stringify(saved));
    // Dragged past the edge: it stops at the edge, fully on screen.
    await hp.mouse.move(moved.left + 6, moved.top + moved.height / 2);
    await hp.mouse.down();
    for (let i = 1; i <= 5; i++) await hp.mouse.move(moved.left + 6 + 120 * i, moved.top - 30 * i);
    await hp.mouse.up();
    await hp.waitForTimeout(300);
    const edge = await pillRect();
    assert.ok(Math.abs(edge.right - 1000) <= 1 && Math.abs(edge.top) <= 1, "pill stops at the window's edge " + JSON.stringify(edge));
    // A smaller window: same corner, still fully on screen.
    await hp.setViewportSize({ width: 640, height: 480 });
    await hp.waitForTimeout(400);
    const small = await pillRect();
    assert.ok(small.right <= 640 + 0.5 && small.left >= 0 && small.top >= 0 && Math.abs(small.right - 640) <= 1, "pill on screen in a smaller window " + JSON.stringify(small));
    await hp.setViewportSize({ width: 1000, height: 700 });
    await hp.waitForTimeout(400);
    // Kept for the next call: a new call page puts it in the same place.
    const hp2 = await ctx.newPage();
    await hp2.setViewportSize({ width: 1000, height: 700 });
    await hp2.goto("https://meet.google.com/pil-lpos-tns");
    await hp2.waitForFunction(() => document.getElementById("meeting-transcripts-indicator"), null, { timeout: 30000 });
    await hp2.waitForTimeout(500);
    const next = await hp2.evaluate(() => document.getElementById("meeting-transcripts-indicator").getBoundingClientRect().toJSON());
    assert.ok(Math.abs(next.right - 1000) <= 1 && Math.abs(next.top) <= 1, "same place in the next call " + JSON.stringify(next));
    await hp2.close();
    // Double-click puts it back in its corner.
    await hp.mouse.dblclick(edge.left + 6, edge.top + edge.height / 2);
    await hp.waitForTimeout(300);
    const back = await pillRect();
    assert.ok(Math.abs(back.left - before.left) <= 1 && Math.abs(back.top - before.top) <= 1, "double-click puts it back " + JSON.stringify(back));
    assert.equal(await sw.evaluate(() => chrome.storage.local.get("pillPos").then((d) => d.pillPos)), undefined);
    console.log("pill: dragged to the top right, kept on screen at the edge and in a smaller window, same place next call, double-click puts it back");
  }
  // "Copy a report" includes the layout around the captions, never what was said.
  const report = await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: "https://meet.google.com/hid-ecap-tns" });
    return chrome.tabs.sendMessage(tab.id, { type: "diagnose" });
  });
  console.log("caption layout report:\n" + report.captionLayout);
  assert.match(report.captionLayout, /COLLAPSED/);
  assert.match(report.captionLayout, /stage fit: main#stage/);
  assert.match(report.captionLayout, /call layout:[\s\S]*main#stage/);
  assert.match(report.captionLayout, /stage path:\n  video [\s\S]*main#stage[^\n]*bottom/);
  assert.ok(!/launch|Friday|thanks/i.test(JSON.stringify(report)), "no caption text in the report");
  assert.ok(!/Alice|Walker|Carol|Bob|Sam Lee/.test(JSON.stringify(report)), "no participant names in the report (tile labels hidden)");
  assert.match(JSON.stringify(report), /aria-label=Captions/, "control labels kept");
  // The in-call pill has a switch for it. The pill is in a closed shadow root, which only the
  // DevTools protocol reaches: find its "Show captions" button there and click it.
  const cdp = await hp.context().newCDPSession(hp);
  const pillButton = async () => {
    const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    const cls = (n) => { const a = n.attributes || []; const i = a.indexOf("class"); return i >= 0 && i % 2 === 0 ? a[i + 1] : ""; };
    const find = (n) => n.nodeName === "BUTTON" && cls(n) === "cc" ? n
      : [...(n.children || []), ...(n.shadowRoots || [])].map(find).find(Boolean);
    const { object } = await cdp.send("DOM.resolveNode", { nodeId: find(root).nodeId });
    return object.objectId;
  };
  const pillCall = async (fn) => (await cdp.send("Runtime.callFunctionOn",
    { objectId: await pillButton(), functionDeclaration: fn, returnByValue: true })).result.value;
  assert.equal(await pillCall("function () { return this.textContent; }"), "Show captions");
  // Clicking it brings the strip back.
  await pillCall("function () { this.click(); }");
  await hp.waitForTimeout(600);
  assert.equal((await sw.evaluate(() => MT.getSettings())).hideCaptions, false, "pill switch turns hiding off");
  assert.equal(await pillCall("function () { return this.textContent; }"), "Hide captions");
  const shown = await layout();
  assert.ok(shown.strip >= 140 && shown.captionsLeft >= 0 && Math.round(shown.tile.height) === 440, "strip back, tiles as Meet laid them out: " + JSON.stringify(shown));
  await pillCall("function () { this.click(); }");
  await hp.waitForTimeout(600);
  // Now with a strip full of captions (taller than when the call began): still collapsed.
  const again = await layout();
  assert.equal(again.strip, 0, "collapsed again");
  fits(again, 1000, 700, "hidden again");
  // Someone joins while captions are hidden: Meet lays the tiles out with no room for captions.
  // Shown again, the tiles must fit above the caption panel, not run under it.
  await hp.evaluate(() => someoneJoined());
  await hp.waitForTimeout(1500);
  fits(await layout(), 1000, 700, "hidden, after Meet laid out again");
  await pillCall("function () { this.click(); }");
  await hp.waitForTimeout(1500);
  {
    const l = await layout();
    const panelTop = await hp.evaluate(() => document.getElementById("capbar").getBoundingClientRect().top);
    const t = l.tile, near = (a, b) => Math.abs(a - b) <= 2;
    console.log("shown after Meet laid out without captions:", JSON.stringify(t), "panel at", panelTop);
    assert.ok(l.strip >= 140 && l.captionsLeft >= 0, "captions back on screen");
    assert.ok(t.bottom <= panelTop - 16 + 1 && t.top >= -1, "tiles fit above the caption panel " + JSON.stringify(t));
    assert.ok(near(t.left - 16, 1000 - 16 - t.right), "tiles centered " + JSON.stringify(t));
    const hit = await hp.evaluate(() => document.elementFromPoint(500, document.getElementById("capbar").getBoundingClientRect().top + 30)?.closest("#capbar") !== null);
    assert.ok(hit, "the caption panel isn't covered by the stage");
  }
  // Meet lays out again with captions shown: its own layout fits, nothing of ours is applied.
  await hp.evaluate(() => someoneJoined());
  await hp.waitForTimeout(1500);
  assert.equal(await hp.evaluate(() => getComputedStyle(document.getElementById("stage")).transform), "none", "Meet's own layout, untouched, once it fits");
  await pillCall("function () { this.click(); }");
  await hp.waitForTimeout(1000);
  fits(await layout(), 1000, 700, "hidden once more");
  await hp.close();
  console.log("hide captions: tiles", Math.round(hidden.tile.width) + "×" + Math.round(hidden.tile.height), "(from 782×440), still recording; off again:", shown.strip, "px strip");
}

// --- captions on screen but nothing read (the page changed): said so, not "Recording" ---------------
{
  await sw.evaluate(() => chrome.storage.local.set({ stuckAfterMs: 3000 }));
  const gp = await ctx.newPage();
  await gp.goto("https://meet.google.com/gar-bled-cap");
  await gp.waitForFunction(() => window.done, null, { timeout: 30000 });
  const statusOf = () => sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: "https://meet.google.com/gar-bled-cap" });
    return chrome.tabs.sendMessage(tab.id, { type: "getStatus" });
  });
  await gp.waitForTimeout(4500);
  assert.equal((await statusOf()).stuck, false, "captions read: not stuck, even with nothing new on screen");
  await gp.evaluate(() => garble());
  let st;
  for (let i = 0; i < 40 && !(st = await statusOf()).stuck; i++) await gp.waitForTimeout(250);
  assert.ok(st.stuck && st.captionsOn, "unreadable captions for a while: stuck " + JSON.stringify(st));
  const badgeText = () => sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: "https://meet.google.com/gar-bled-cap" });
    return chrome.action.getBadgeText({ tabId: tab.id });
  });
  let badge;
  for (let i = 0; i < 20 && (badge = await badgeText()) !== "!"; i++) await gp.waitForTimeout(250); // updated on the next tick
  assert.equal(badge, "!", "toolbar badge warns");
  console.log("stuck: captions changing, nothing read -> pill, popup and badge say so");
  await sw.evaluate(() => chrome.storage.local.remove("stuckAfterMs"));
  await gp.close();
}

// --- Microsoft Teams ------------------------------------------------------------------------------
await v.evaluate(() => MT.saveSettings({ hideCaptions: false }));
await ctx.route("https://teams.microsoft.com/**", (r) => r.fulfill({ contentType: "text/html", body: fixture("mock-teams.html") }));
const meetingsOf = async (platform) => Object.values((await sw.evaluate(() => chrome.storage.local.get("meetings"))).meetings)
  .filter((m) => m.platform === platform);
const tp = await ctx.newPage();
await tp.goto("https://teams.microsoft.com/v2/");
// Captions are off: the recorder opens More › Language and speech › Turn on live captions itself.
await tp.waitForFunction(() => window.firstPart, null, { timeout: 30000 });
assert.ok(await tp.$("#meeting-transcripts-indicator"), "in-call indicator shown");
await tp.waitForTimeout(2000);
let [tm] = await meetingsOf("teams");
let tLines = await sw.evaluate((k) => chrome.storage.local.get(k).then((d) => d[k]), "t:" + tm.id);
console.log("teams lines:", tLines.map((e) => `${e.speaker}: ${e.text}`).join(" | "));
assert.deepEqual(tLines.map((e) => e.speaker), ["Dana Wu", "Eli Park", "Sam Lee"], "a re-drawn caption list isn't recorded twice");
assert.equal(tLines[1].text, "Thanks Dana. I will own the API work and send a plan by Friday.");
// The popup's "Copy a report": the page's layout, never what anyone said.
const report = await v.evaluate(async () => {
  const [tab] = await chrome.tabs.query({ url: "https://teams.microsoft.com/*" });
  return chrome.tabs.sendMessage(tab.id, { type: "diagnose" });
});
assert.equal(report.platform, "teams");
assert.equal(report.captionsFound, true);
assert.ok(report.captionArea.includes('[data-tid=closed-captions-renderer]'), report.captionArea);
assert.ok(!/API work|kickoff for the new portal|Dana Wu/.test(JSON.stringify(report)), "no caption text or names in the report");
console.log("diagnostics report:", report.blocks, "caption blocks found;", report.captionArea.split("\n")[0]);
// Pause for a while: the transcript shows the stretch with nothing recorded.
await v.evaluate(() => MT.saveSettings({ paused: true }));
await tp.waitForTimeout(22000);
await v.evaluate(() => MT.saveSettings({ paused: false }));
await tp.evaluate(() => window.continueCall());
await tp.waitForFunction(() => window.done, null, { timeout: 30000 });
await tp.waitForTimeout(2000);
await tp.evaluate(() => window.leave());
let tFile;
for (let i = 0; i < 40 && !(tFile = await fileOf(tm.id)); i++) await tp.waitForTimeout(250);
[tm] = await meetingsOf("teams");
console.log("teams:", tm.title, "->", path.basename(tFile.filename), "gaps:", JSON.stringify(tm.gaps.map((g) => [g.reason, Math.round((g.to - g.from) / 1000)])));
assert.equal(tm.title, "Project kickoff");
assert.equal(path.basename(tFile.filename), `${date} - Project kickoff - Sam Lee, Dana Wu, Eli Park.docx`);
assert.equal(tm.gaps.length, 1);
assert.equal(tm.gaps[0].reason, "paused");
// The saved document says where the call happened and reads back as a Teams call.
const tParsed = await v.evaluate(async (b64) => (await DOCX_IMPORT.parse(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer,
  "2026-10-11 - x.docx")).meta, fs.readFileSync(tFile.filename).toString("base64"));
assert.equal(tParsed.platform, "teams");
await v.goto(`chrome-extension://${id}/viewer/viewer.html#` + encodeURIComponent(tm.id));
await v.waitForSelector(".gap");
console.log("gap shown:", await v.textContent(".gap"));
assert.match(await v.textContent(".gap"), /^Recording was paused \d+:\d\d–\d+:\d\d \(1 min\); nothing was recorded$/);
assert.match(await v.textContent("#meta"), /^Microsoft Teams · /);
await v.screenshot({ path: shots + "/teams-viewer.png" });

// --- Zoom (web client) ------------------------------------------------------------------------------
await ctx.route("https://app.zoom.us/**", (r) => r.fulfill({ contentType: "text/html", body: fixture("mock-zoom.html") }));
const zp = await ctx.newPage();
await zp.goto("https://app.zoom.us/wc/9876543210/join");
await zp.waitForFunction(() => window.done, null, { timeout: 30000 });
await zp.waitForTimeout(2500);
let [zm] = await meetingsOf("zoom");
let zLines = await sw.evaluate((k) => chrome.storage.local.get(k).then((d) => d[k]), "t:" + zm.id);
console.log("zoom lines:", zLines.map((e) => `${e.speaker}: ${e.text}`).join(" | "));
assert.deepEqual(zLines.map((e) => e.speaker), ["Ann Lee", "Ben Cho", "Ann Lee"], "overlay lines keep their speaker; the transcript panel adds no duplicates");
await zp.evaluate(() => window.leave());
let zFile;
for (let i = 0; i < 40 && !(zFile = await fileOf(zm.id)); i++) await zp.waitForTimeout(250);
[zm] = await meetingsOf("zoom");
console.log("zoom:", zm.title, "->", path.basename(zFile.filename), zm.link);
assert.equal(zm.title, "Call with Ann Lee, Ben Cho");
assert.equal(zm.link, "https://zoom.us/j/9876543210");

// --- rename a speaker, here and in future calls; the finished call's document is offered an update ---
await v.goto(`chrome-extension://${id}/viewer/viewer.html#` + encodeURIComponent(zm.id));
await v.click('button.spk[data-name="Ben Cho"]');
await v.waitForSelector("#renameBox.open");
await v.fill("#renameInput", "Benjamin Cho");
await v.check("#renameFuture");
await v.screenshot({ path: shots + "/rename.png" });
await v.click('#renameBox button[type="submit"]');
await v.waitForSelector('button.spk[data-name="Benjamin Cho"]');
for (let i = 0; i < 40 && !(await fileOf(zm.id)).outdated; i++) await v.waitForTimeout(250);
assert.ok((await fileOf(zm.id)).outdated && fs.existsSync(zFile.filename), "document left as it was, marked out of date");
await v.click("#saveNow");
await v.waitForSelector("#saveMenu.open");
await v.click('#saveMenu [data-mode="replace"]');
for (let i = 0; i < 40 && !(await fileOf(zm.id)).filename.includes("Benjamin"); i++) await v.waitForTimeout(250);
const zRenamed = await fileOf(zm.id);
console.log("speaker renamed, then Update › Replace:", path.basename(zRenamed.filename));
assert.equal(path.basename(zRenamed.filename), `${date} - Call with Ann Lee, Benjamin Cho.docx`);
assert.ok(!fs.existsSync(zFile.filename), "replaced: the old name is gone");
assert.deepEqual((await v.evaluate(() => MT.getSettings())).nameMap, { "ben cho": "Benjamin Cho" });
zLines = await sw.evaluate((k) => chrome.storage.local.get(k).then((d) => d[k]), "t:" + zm.id);
assert.deepEqual(zLines.map((e) => e.speaker), ["Ann Lee", "Benjamin Cho", "Ann Lee"]);

// --- paused: captions aren't even turned on ----------------------------------------------------------
await v.evaluate(() => MT.saveSettings({ paused: true }));
const zp1 = await ctx.newPage();
await zp1.goto("https://app.zoom.us/wc/5556667778/join");
await zp1.waitForTimeout(5000);
assert.ok(!(await zp1.$('[role="menu"], #live-transcription-subtitle')), "captions left off while paused");
await zp1.close();
await v.evaluate(() => MT.saveSettings({ paused: false }));
console.log("paused: captions left off");

// --- turning a platform off: nothing is recorded there ------------------------------------------------
await v.evaluate(() => MT.getSettings().then((s) => MT.saveSettings({ platforms: { ...s.platforms, zoom: false } })));
const zp2 = await ctx.newPage();
await zp2.goto("https://app.zoom.us/wc/1112223334/join");
await zp2.waitForTimeout(5000);
assert.ok(!(await zp2.$('[role="menu"], #live-transcription-subtitle')), "captions not even turned on");
assert.equal((await meetingsOf("zoom")).length, 1, "no new Zoom meeting");
await zp2.close();
console.log("zoom turned off: nothing recorded");

await close();

// --- upgrading from "Meet Transcripts": files move to the new folder ---------------------------------
{
  const run = await launch();
  const v = await run.ctx.newPage();
  await v.goto(`chrome-extension://${id}/viewer/viewer.html`);
  const old = await v.evaluate(async () => {
    const done = (dl) => new Promise((r) => { const t = setInterval(async () => {
      const [it] = await chrome.downloads.search({ id: dl });
      if (it && it.state === "complete") { clearInterval(t); r(it); } }, 100); });
    const docx = await done(await chrome.downloads.download({ url: "data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==",
      filename: "Meet Transcripts/2026-10-01/2026-10-01 - Old call - Ann.docx" }));
    const lib = await done(await chrome.downloads.download({ url: "data:application/json,{}", filename: "Meet Transcripts/library.json" }));
    const m = { id: "abc-defg-hij-1", code: "abc-defg-hij", eventTitle: "Old call", startedAt: new Date(2026, 9, 1, 9).getTime(),
      endedAt: new Date(2026, 9, 1, 10).getTime(), speakers: ["Ann"] };
    await chrome.storage.local.set({ meetings: { [m.id]: m }, ["t:" + m.id]: [{ speaker: "Ann", text: "Hi.", ts: m.startedAt }],
      ["f:" + m.id]: { downloadId: docx.id, filename: docx.filename, savedAt: 1, hash: "x" },
      fileLayout: 2, libraryReady: true, libraryDownloadId: lib.id });
    return { docx: docx.filename, lib: lib.filename };
  });
  // Restart the background worker, as when Chrome loads a new version; it migrates on start.
  const cdp = await run.browser.newBrowserCDPSession();
  const { targetInfos } = await cdp.send("Target.getTargets");
  for (const t of targetInfos.filter((t) => t.type === "service_worker" && t.url.includes(id))) await cdp.send("Target.closeTarget", { targetId: t.targetId });
  await v.waitForTimeout(500);
  await v.evaluate(() => chrome.runtime.sendMessage({ type: "ping" }).catch(() => {}));
  const newDoc = path.join(run.downloads, "Meeting Transcripts", "2026-10-01", "2026-10-01 - Old call - Ann.docx");
  const newLib = path.join(run.downloads, "Meeting Transcripts", "library.json");
  const fileRec = () => v.evaluate(() => chrome.storage.local.get("f:abc-defg-hij-1").then((d) => d["f:abc-defg-hij-1"]));
  for (let i = 0; i < 80 && !(fs.existsSync(newLib) && !fs.existsSync(old.lib) && (await fileRec()).outdated); i++) await new Promise((r) => setTimeout(r, 250));
  assert.ok(fs.existsSync(newLib) && !fs.existsSync(old.lib), "library.json moved");
  // A finished call's document may hold the user's own edits: an update never rewrites, moves
  // or deletes it. The viewer offers to update it instead.
  assert.ok(fs.existsSync(old.docx), "old document left as it was");
  assert.ok(!fs.existsSync(newDoc), "no rewritten copy");
  assert.equal((await fileRec()).outdated, true, "marked as out of date, for the viewer to offer an update");
  console.log("upgrade: library.json moved; the finished call's document left untouched, offered for update");
  await run.close();
}

// --- Chrome set to "Ask where to save each file": a clear warning, not a silent failure ----
{
  const run = await launch({ askWhereToSave: true });
  const v = await run.ctx.newPage();
  await v.goto(`chrome-extension://${id}/viewer/viewer.html`);
  await v.evaluate((m) => chrome.storage.local.set({ meetings: { [m.id]: m }, ["t:" + m.id]: [{ speaker: "Ann", text: "Hello.", ts: m.startedAt }] }),
    { id: "x-1", code: "abc-defg-hij", title: "Ask test", startedAt: Date.now(), endedAt: Date.now(), speakers: ["Ann"] });
  await v.goto(`chrome-extension://${id}/viewer/viewer.html#x-1`);
  await v.click("#saveNow");
  await v.waitForSelector("#dlSettings", { timeout: 15000 });
  console.log("ask-where-to-save warning:", (await v.textContent("#file .err")).slice(0, 70) + "…");
  const p = await run.ctx.newPage();
  await p.goto(`chrome-extension://${id}/popup/popup.html`);
  await p.waitForSelector("#askWarning:not([hidden])");
  await run.close();
}

// --- library.json is never replaced by an empty or an unimported library ----------------------
// What happened to a real library: an install with an empty library (removed and added back)
// was then updated, which marked it ready, and the next change wrote an empty library.json over
// the full one. Nothing may do that.
{
  const run = await launch();
  const v = await run.ctx.newPage();
  await v.goto(`chrome-extension://${id}/viewer/viewer.html`);
  const lib = path.join(run.downloads, "Meeting Transcripts", "library.json");
  const T0 = Date.now() - 86400_000;
  const full = { app: "meet-transcripts", kind: "library", version: 1, savedAt: T0, settings: { myName: "Sam" },
    meetings: { "K-1": { id: "K-1", code: "abc-defg-hij", eventTitle: "Kept call", startedAt: T0, endedAt: T0 + 60_000, speakers: ["Ann"] } },
    transcripts: { "K-1": [{ speaker: "Ann", text: "Keep me.", ts: T0 }] }, files: {} };
  // The full library.json an earlier install wrote (it's in Chrome's download history).
  await v.evaluate(async (json) => {
    const id = await chrome.downloads.download({ url: "data:application/json;base64," + btoa(json), filename: "Meeting Transcripts/library.json" });
    await new Promise((r) => { const t = setInterval(async () => { const [it] = await chrome.downloads.search({ id }); if (it && it.state === "complete") { clearInterval(t); r(); } }, 100); });
  }, JSON.stringify(full));
  const intact = () => JSON.parse(fs.readFileSync(lib, "utf8")).meetings["K-1"] !== undefined;
  assert.ok(intact());
  const restartWorker = async () => {
    const cdp = await run.browser.newBrowserCDPSession();
    const { targetInfos } = await cdp.send("Target.getTargets");
    for (const t of targetInfos.filter((t) => t.type === "service_worker" && t.url.includes(id))) await cdp.send("Target.closeTarget", { targetId: t.targetId });
    await v.waitForTimeout(500);
    await v.evaluate(() => chrome.runtime.sendMessage({ type: "ping" }).catch(() => {}));
  };
  // 1. Empty, and marked ready (as the update used to do), then a setting changes: not written.
  await v.evaluate(() => chrome.storage.local.set({ libraryReady: true }));
  await v.evaluate(() => MT.saveSettings({ myName: "Someone" }));
  await v.waitForTimeout(4500);
  assert.ok(intact(), "an empty library never replaces library.json");
  // 2. An install from before the ready flag (undefined) with a new call, its worker restarted
  //    (as on an update): library.json is someone's history to import, so it isn't "ready".
  await v.evaluate(async () => {
    await chrome.storage.local.remove(["libraryReady", "libraryDownloadId"]);
    await MT.saveMeeting({ id: "N-1", code: "xyz-abcd-efg", eventTitle: "New call", startedAt: Date.now(), endedAt: Date.now(), speakers: ["Bo"] },
      [{ speaker: "Bo", text: "Hello.", ts: Date.now() }]);
  });
  await restartWorker();
  await v.waitForTimeout(4500);
  assert.equal((await v.evaluate(() => chrome.storage.local.get("libraryReady"))).libraryReady, false, "not ready while a library.json waits");
  assert.ok(intact(), "library.json untouched");
  assert.ok(fs.existsSync(path.join(run.downloads, "Meeting Transcripts", "library (since reinstall).json")), "new calls kept in the interim file");
  // 3. Importing nothing (an empty export) doesn't make it ready either.
  const empty = path.join(run.downloads, "empty.json");
  fs.writeFileSync(empty, JSON.stringify({ ...full, device: { id: "e0000000", name: "Elsewhere" }, meetings: {}, transcripts: {} }));
  await v.reload();
  await v.setInputFiles("#importInput", [empty]);
  await v.waitForSelector("#toast.show");
  assert.equal((await v.evaluate(() => chrome.storage.local.get("libraryReady"))).libraryReady, false);
  // 4. Importing the folder (library.json and all) does: everything is kept, merged.
  await v.evaluate(() => hideToast());
  await v.evaluate(() => document.getElementById("importFolder").removeAttribute("webkitdirectory"));
  const folderFiles = fs.readdirSync(path.join(run.downloads, "Meeting Transcripts")).map((f) => path.join(run.downloads, "Meeting Transcripts", f));
  await v.setInputFiles("#importFolder", folderFiles);
  await v.waitForSelector("#toast.show");
  console.log("import folder:", await v.textContent("#toastText"));
  for (let i = 0; i < 40 && !(fs.existsSync(lib) && JSON.parse(fs.readFileSync(lib, "utf8")).meetings["N-1"]); i++) await v.waitForTimeout(250);
  const after = JSON.parse(fs.readFileSync(lib, "utf8"));
  assert.deepEqual(Object.keys(after.meetings).sort(), ["K-1", "N-1"], "library.json now holds both");
  console.log("library safety: an empty or unimported library never replaced library.json; importing the folder merged both");
  await run.close();
}

// --- moving the library to another computer: Export, then Import there ----------------------
{
  const run = await launch();
  const v = await run.ctx.newPage();
  await v.goto(`chrome-extension://${id}/viewer/viewer.html`);
  const T0 = Date.now() - 3 * 3600_000;
  const meeting = (id, title, at) => ({ id, code: "abc-defg-hij", eventTitle: title, startedAt: at, endedAt: at + 600_000, speakers: ["Ann"] });
  // "Computer A": two calls, exported.
  await v.evaluate(async ([A, B]) => {
    await chrome.storage.local.set({ device: { id: "aaaa0001", name: "Office PC" } });
    for (const m of [A, B]) await MT.saveMeeting(m, [{ speaker: "Ann", text: "Hello " + m.id, ts: m.startedAt }]);
    await MT.updateMeeting("B-1", { title: "Renamed at the office", renamed: true });
  }, [meeting("A-1", "Planning", T0), meeting("B-1", "Review", T0 + 60_000)]);
  await v.reload();
  await v.click("#libExport");
  const exportDir = run.downloads;
  let exported = null;
  for (let i = 0; i < 40 && !exported; i++) {
    await v.waitForTimeout(250);
    exported = fs.readdirSync(exportDir).find((f) => /^Meeting Transcripts library - \d{4}-\d\d-\d\d - Office PC\.json$/.test(f)) || null;
  }
  assert.ok(exported, "export saved to Downloads, named after the computer: " + fs.readdirSync(exportDir).join(" | "));
  const file = JSON.parse(fs.readFileSync(path.join(exportDir, exported), "utf8"));
  assert.deepEqual(Object.keys(file.meetings).sort(), ["A-1", "B-1"]);
  assert.equal(file.device.name, "Office PC");

  // "Computer B": its own call C, an older copy of B, and A it doesn't have.
  await v.evaluate(async ([B, C]) => {
    await chrome.storage.local.clear();
    await chrome.storage.local.set({ device: { id: "bbbb0002", name: "Home laptop" }, libraryReady: true });
    await MT.saveMeeting(C, [{ speaker: "Bo", text: "Only here.", ts: C.startedAt }]);
    await chrome.storage.local.set({ meetings: { ...(await chrome.storage.local.get("meetings")).meetings,
      "B-1": { ...B, title: "Old title", updatedAt: B.startedAt } }, "t:B-1": [{ speaker: "Ann", text: "old", ts: B.startedAt }] });
  }, [meeting("B-1", "Review", T0 + 60_000), meeting("C-1", "Home call", T0 + 120_000)]);
  await v.reload();
  const importFile = async (paths) => {
    await v.setInputFiles("#importInput", paths);
    await v.waitForSelector("#toast.show");
    const text = await v.textContent("#toastText");
    await v.evaluate(() => hideToast());
    return text;
  };
  const first = await importFile([path.join(exportDir, exported)]);
  const after = await v.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    return { meetings: all.meetings, b: all["t:B-1"] };
  });
  console.log("import:", first);
  assert.equal(first, "Imported 2 calls");
  assert.deepEqual(Object.keys(after.meetings).sort(), ["A-1", "B-1", "C-1"], "nothing removed, A added");
  assert.equal(after.meetings["A-1"].syncedFrom, "Office PC");
  assert.equal(await v.evaluate((m) => MT.title(m), after.meetings["B-1"]), "Renamed at the office", "the newer copy wins");
  assert.equal(after.b[0].text, "Hello B-1");
  assert.equal(after.meetings["C-1"].syncedFrom, undefined);
  const again = await importFile([path.join(exportDir, exported)]);
  assert.equal(again, "Imported 0 calls · 2 already here", "importing twice changes nothing");
  await v.goto(`chrome-extension://${id}/viewer/viewer.html#A-1`);
  await v.waitForFunction(() => document.getElementById("file").textContent.includes("Recorded on Office PC"));

  // A 2.4 sync file (devices/<id>.json) imports the same way.
  const syncFile = path.join(run.downloads, "old-sync.json");
  fs.writeFileSync(syncFile, JSON.stringify({ ...file, device: { id: "cccc0003", name: "Old Mac" }, meetings: { "D-1": meeting("D-1", "From 2.4", T0 + 200_000) },
    transcripts: { "D-1": [{ speaker: "Ann", text: "Synced in 2.4.", ts: T0 + 200_000 }] }, deleted: { "C-1": Date.now() } }));
  await v.goto(`chrome-extension://${id}/viewer/viewer.html`);
  assert.equal(await importFile([syncFile]), "Imported 1 call");
  assert.ok((await v.evaluate(() => MT.listMeetings())).some((m) => m.id === "C-1"), "an old file's deletions don't apply");

  // A computer that had 2.4's folder sync on goes back to writing library.json.
  await v.evaluate(() => chrome.storage.local.set({ sync: { on: true }, deleted: { x: 1 } }));
  const cdp = await run.browser.newBrowserCDPSession();
  const { targetInfos } = await cdp.send("Target.getTargets");
  for (const t of targetInfos.filter((t) => t.type === "service_worker" && t.url.includes(id))) await cdp.send("Target.closeTarget", { targetId: t.targetId });
  await v.waitForTimeout(500);
  await v.evaluate(() => chrome.runtime.sendMessage({ type: "ping" }).catch(() => {}));
  const lib = path.join(run.downloads, "Meeting Transcripts", "library.json");
  for (let i = 0; i < 40 && !fs.existsSync(lib); i++) await v.waitForTimeout(250);
  assert.ok(fs.existsSync(lib), "library.json written again");
  assert.deepEqual(await v.evaluate(() => chrome.storage.local.get(["sync", "deleted"])), {}, "2.4 sync state forgotten");
  console.log("export/import: exported 2 calls, imported them elsewhere (newer copy wins, nothing removed), twice is harmless; 2.4 sync files import; 2.4 sync turned off");
  await run.close();
}

// --- a deleted call stays deleted when the folder is imported; choosing its file brings it back ---
{
  const run = await launch();
  const v = await run.ctx.newPage();
  await v.goto(`chrome-extension://${id}/viewer/viewer.html`);
  const T0 = Date.now() - 3600_000;
  const m = { id: "del-gone-now-" + T0, code: "del-gone-now", eventTitle: "Deleted call", startedAt: T0, endedAt: T0 + 300_000, speakers: ["Ann"] };
  await v.evaluate(async (m) => {
    await chrome.storage.local.set({ libraryReady: true });
    await MT.saveMeeting(m, [{ speaker: "Ann", text: "This call gets deleted.", ts: m.startedAt }]);
  }, m);
  const saved = await v.evaluate((id) => chrome.runtime.sendMessage({ type: "saveNow", id }), m.id);
  assert.ok(saved.ok && fs.existsSync(saved.result.filename), "its Word document saved");
  await v.goto(`chrome-extension://${id}/viewer/viewer.html#` + encodeURIComponent(m.id));
  await v.waitForSelector(".turn p");
  await v.click("#delete");
  await v.waitForSelector("#toast.show");
  await v.evaluate(() => hideToast());
  assert.ok(fs.existsSync(saved.result.filename), "its document is still in the folder");
  const lib = path.join(run.downloads, "Meeting Transcripts", "library.json");
  // The folder: its Word document (and library.json, once written) are there; the call stays deleted.
  await v.evaluate(() => document.getElementById("importFolder").removeAttribute("webkitdirectory"));
  await v.setInputFiles("#importFolder", [saved.result.filename, ...(fs.existsSync(lib) ? [lib] : [])]);
  await v.waitForSelector("#toast.show");
  const folderResult = await v.textContent("#toastText");
  assert.match(folderResult, /Imported 0 calls · .*1 you deleted, skipped/, folderResult);
  assert.equal((await v.evaluate(() => MT.listMeetings())).length, 0, "not brought back");
  await v.evaluate(() => hideToast());
  // Import › File… with its document chosen: back, and no longer remembered as deleted.
  await v.setInputFiles("#importInput", [saved.result.filename]);
  await v.waitForFunction(() => /Imported 1 call/.test(document.getElementById("toastText").textContent));
  assert.equal((await v.evaluate(() => MT.listMeetings())).length, 1, "brought back on purpose");
  assert.deepEqual(await v.evaluate(() => MT.getTrash()), {}, "forgotten as deleted");
  console.log("deleted calls: skipped by a folder import (" + folderResult + "); back when their file is chosen");
  await run.close();
}

console.log("ALL CHECKS PASSED");
