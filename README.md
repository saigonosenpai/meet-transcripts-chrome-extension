# Meeting Transcripts

***Nobody knows that you're taking notes.***

[![Download meet-transcripts-chrome-extension.zip](https://img.shields.io/badge/Download-meet--transcripts--chrome--extension.zip-2ea44f?style=for-the-badge&logo=googlechrome&logoColor=white)](https://github.com/saigonosenpai/meet-transcripts-chrome-extension/releases/latest/download/meet-transcripts-chrome-extension.zip)
&nbsp; then follow the [install steps](#install) below.

> GitHub's green **Code › Download ZIP** works too. The button above is just smaller (only the
> extension, no source files) and always the latest release.

**Turn every Google Meet, Microsoft Teams and Zoom call into a searchable transcript and a
Word document, automatically.**

Meeting Transcripts is a free Chrome extension that quietly records the live captions of
your calls. You don't have to remember to start it. When the call ends it saves a tidy
`.docx` with who was there, who spoke when, and the possible action items, decisions and
questions, filed in a folder for each day. No account, no sign-in, no audio recording, no
servers: everything stays on your computer.

Works with **Google Meet**, **Microsoft Teams** and **Zoom** calls joined in the browser,
on **Windows and macOS** (and Linux), in Chrome, Edge, Brave, Arc and other Chromium
browsers.

![The transcript library: meetings by day on the left, the full transcript with speakers and timestamps on the right](docs/screenshots/viewer.png)

---

## Install

The extension isn't on the Chrome Web Store, so you add it to Chrome yourself. It takes
about two minutes and works the same on Windows and Mac.

**1. Download** [**meet-transcripts-chrome-extension.zip**](https://github.com/saigonosenpai/meet-transcripts-chrome-extension/releases/latest/download/meet-transcripts-chrome-extension.zip)
(always the latest version). GitHub's green **Code › Download ZIP** button works as well:
it's the full source code, which loads the same way.

**2. Unzip it into a permanent place.** Chrome runs the extension from this folder, so put
it somewhere you won't clean up, and don't delete it later.
- **Windows:** right-click the ZIP › **Extract All…** › click **Browse** and choose
  **Documents** › **Extract**.
- **Mac:** double-click the ZIP, then drag the new `meet-transcripts-chrome-extension` folder into
  **Documents**.

You now have a folder called **`meet-transcripts-chrome-extension`** with the extension's files directly
inside it, including **`manifest.json`**:

```
Documents
└── meet-transcripts-chrome-extension   ← select this folder in step 4
    ├── manifest.json
    ├── background.js
    ├── INSTALL.txt
    ├── content
    ├── popup
    └── …
```

**3. Open `chrome://extensions`** (type it into the address bar; in Edge it's
`edge://extensions`) and turn on **Developer mode** in the top-right corner ①.

**4. Click Load unpacked** ② and select the **`meet-transcripts-chrome-extension`** folder from step 2,
the one that has `manifest.json` directly inside it. Then click **Select Folder**.

![chrome://extensions: the Developer mode switch top right (1), and the Load unpacked button that appears top left (2)](docs/screenshots/install-load-unpacked.png)

**5. Pin it:** click the puzzle-piece icon in Chrome's toolbar, then the pin next to
*Meeting Transcripts*, so its badge shows during calls.

A "Meeting Transcripts" tab opens to welcome you. That's it: join a call and it records.
If you've used the extension before, click **Import › Meeting Transcripts folder…** on that
tab and choose `Downloads › Meeting Transcripts` to bring your history back (see
[library.json](#your-history-is-safe-libraryjson)).

> **"Manifest file is missing or unreadable"?** The folder you selected doesn't contain
> `manifest.json` itself; usually it's one level too high (for example `Downloads`, or a
> folder holding another folder of the same name, which Windows' *Extract All* creates for
> GitHub's Code › Download ZIP). Click **Load unpacked** again and pick the folder that has
> `manifest.json` in it.
>
> Chrome may also show a *"Disable developer mode extensions"* notice when it starts.
> That's normal for extensions added this way; close it with the ✕ (not *Disable*).

If you use git, you can instead clone this repository and select the cloned folder in step 4.

## Contents

- [Install](#install)
- [What it does](#what-it-does)
- [Screenshots](#screenshots)
- [Update to a new version](#update-to-a-new-version)
- [Using it](#using-it)
- [Teams and Zoom](#teams-and-zoom)
- [Where your files go and how they're named](#where-your-files-go-and-how-theyre-named)
- [Your history is safe: library.json](#your-history-is-safe-libraryjson)
- [Using more than one computer](#using-more-than-one-computer)
- [Privacy](#privacy)
- [FAQ](#faq)
- [Troubleshooting](#troubleshooting)
- [Version history](#version-history)
- [For developers](#for-developers)

## What it does

- **Records automatically.** Join a call and it turns captions on and starts recording. A
  small **Recording captions** pill in the corner of the call, and `REC` on the toolbar
  icon, show it's working.
- **Google Meet, Teams and Zoom.** One library for all three, each meeting labelled with
  where it happened. Turn any of them off in the popup.
- **Saves a Word document per call** to `Downloads/Meeting Transcripts/<date>/`, named so
  you can find it again: `2026-10-11 - Weekly sync - Alice, Bob, Sam Lee.docx`. Calls
  without a title are named after the people in them: `2026-10-11 - Call with Alice, Bob.docx`.
- **Knows who said what.** Every line has the speaker and a timestamp. Your own lines
  carry your real name instead of "You". **Rename a speaker** (a phone number,
  "Presentation", a misspelt name) with one click, for that meeting or for every call from
  then on.
- **Shows what's missing.** If captions were off or recording was paused for part of the
  call, the transcript says so ("Captions were off 12:40–19:52"), so a quiet stretch is
  never mistaken for silence.
- **Picks out what matters.** The document and the library list possible **action items**,
  **decisions** and **questions**, plus each person's share of the speaking time.
- **A library for all your calls.** Search across every meeting, filter a transcript, rename
  it, export it as Word, Markdown, text or JSON, or **Copy for AI** to paste into ChatGPT,
  Claude or Gemini for a summary.
- **Survives reinstalls.** A `library.json` in the same folder keeps your history and
  settings. Remove the extension, add it back, click **Import** and it's all there.
- **Take it to another computer.** **Export** saves your whole library as one file;
  **Import** it on your other computer. Still nothing goes online.
- **Private by design.** It reads the captions your call already shows you. Nothing is
  uploaded and nobody else in the call is notified.

## Screenshots

| The toolbar popup | Dark mode |
|---|---|
| ![The popup: recording status, settings, which platforms to record, and the All Transcripts button](docs/screenshots/popup.png) | ![The popup in dark mode](docs/screenshots/popup-dark.png) |

**In the call**, a pill shows it's recording. Click it to pause, resume, or turn captions on;
*Show captions* / *Hide captions* switches the captions on screen, and the × hides the pill
for that call. **Drag it** anywhere out of the way: it stays there in later calls, on any
screen size. Double-click it to put it back in the corner. Only you see it.

<img src="docs/screenshots/indicator.png" width="320" alt="A dark pill with a drag grip, a red dot, &quot;Recording captions&quot;, a Show captions button and a close button">

**Action items, decisions and questions** pulled out of the transcript with one click:

![The Action items filter showing only the sentences that sound like tasks](docs/screenshots/action-items.png)

**Rename a speaker** by clicking their name. Tick *Also in future calls* and the new name is
used from then on:

![The rename box open under a speaker's name, with an "Also in future calls" checkbox](docs/screenshots/rename.png)

**Gaps are marked**, so you know where nothing was recorded:

![A divider in the transcript reading "Captions were off 5:02–10:02 (5 min); nothing was recorded"](docs/screenshots/gap.png)

**Export** to Word, Markdown, plain text or JSON, or copy it:

![The Export menu open under the Export button](docs/screenshots/export.png)

**The saved Word document** (first page). The full transcript follows the highlights:

![Page one of a saved .docx: title, date, platform, participants, speaking time and highlights](docs/screenshots/docx.png)

**Dark mode** follows your system setting:

![The transcript library in dark mode](docs/screenshots/viewer-dark.png)

**After a reinstall** the library opens itself and points you to the one click that brings
your history back:

![The empty library after a reinstall, with the Import button highlighted](docs/screenshots/restore.png)

## Update to a new version

**The short version: replace the files, click reload. Don't click Remove.**

1. Download the new [**meet-transcripts-chrome-extension.zip**](https://github.com/saigonosenpai/meet-transcripts-chrome-extension/releases/latest/download/meet-transcripts-chrome-extension.zip),
   or run `git pull` if you cloned it. To hear about new versions, click **Watch → Custom →
   Releases** at the top of this page.
2. Copy the new files **over your existing folder**, the one you selected in step 4 of
   Install, replacing everything. On Windows, open the ZIP, select all, copy, and paste
   into your folder choosing *Replace the files in the destination*. On Mac, unzip, open
   the new folder, select all and drag into yours, choosing *Replace*.
3. Open `chrome://extensions` and click the **reload arrow (↻)** on the extension.
4. Reload any open call tabs.

Your transcripts, settings and saved files all stay exactly as they were. If a new version
changes how files are named or organized, existing files are moved over automatically.

To check which version you have, look under the extension's name in `chrome://extensions`.

**Updating from 1.x (Meet Transcripts) to 2.0:** the extension is now called *Meeting
Transcripts*, and so is its folder. On its first start, your saved documents and
`library.json` move from `Downloads/Meet Transcripts` to `Downloads/Meeting Transcripts`
by themselves. Afterwards the old folder holds only empty day folders, plus any files the
extension didn't save itself (move those over by hand); delete it once you've had a look.
Old 1.x files left in your extension folder, like `content.js`, are simply ignored.

**What if I removed the extension, or loaded the new version from a different folder?**
Removing an extension makes Chrome delete its stored data. Your `.docx` files and
`library.json` in Downloads are untouched, though. Load the new version, and on the tab
that opens click **Import › Meeting Transcripts folder…** and choose
`Downloads › Meeting Transcripts` (or `Meet Transcripts`, if you were on 1.x). Everything comes back: meetings, transcripts,
names and settings.

## Using it

### During a call

Just join. The extension turns on captions and starts recording; there's nothing to set up.
Don't want a call recorded? **Pause** first (popup or pill): while paused, captions aren't
turned on and nothing is saved. The pill in the corner of
the call and the badge on the toolbar icon tell you what's happening:

| Badge | Pill | Meaning |
|-------|------|---------|
| `REC` (red) | ● Recording captions | Captions are on and being recorded |
| `CC` | ● Captions off · not recording | You're in a call but captions are off. Click the pill to turn them on |
| `II` | ● Paused | Recording is paused. Click the pill to resume |
| `!` (orange) | ● Captions on · nothing recorded | Captions are showing but none have been picked up for a minute, usually because the call page changed. Open the popup and **Copy a report** |

**Alt+Shift+P** pauses and resumes from the keyboard (change it at
`chrome://extensions/shortcuts`). Drag the pill anywhere out of the way; double-click puts it
back. Click the icon to **pause/resume** or open the **live transcript**, which updates as people
talk. Below that, the popup shows your library at a glance: how many calls, how much time
they add up to, and how much space the documents and backup take on disk.

### When it saves

The `.docx` is saved when you leave the call or close the tab, and also after 2 minutes
without new captions, so a crash loses little. If the call carries on, the same file is
updated, so you get one file per call, never duplicates. Saving is silent: no download
pop-up in the middle of your meeting.

**Once the call is over, the document is yours.** Add notes to it in Word if you like: the
extension never rewrites, renames or deletes it on its own after that (Chrome can't tell it
whether you edited the file). If you later rename the call or a speaker, the library shows
*Changed since* and **Update .docx…**, with a choice: **Save as a new copy** (keeps your
document) or **Replace this document** (your edits in Word are lost).

### Settings (in the popup)

| Setting | What it does |
|---|---|
| Hide captions on screen | On by default. Keeps recording but hides the captions, and gives the space they took back to the video. Also on the in-call pill (*Show captions* / *Hide captions*) |
| Show indicator in calls | The *Recording captions* pill in the corner of the call |
| Your name | Used instead of "You" in transcripts. Normally read from your account; set it to override |
| Record calls in | Google Meet, Microsoft Teams, Zoom: turn off any you don't want recorded |
| Save each call as a .docx | Turn automatic saving on or off |
| Show folder | Opens `Meeting Transcripts` in Explorer / Finder |

### The library (All Transcripts)

- Meetings grouped by day, each labelled Meet, Teams or Zoom, with **search across all of
  them**.
- Speaker turns with timestamps (hover a timestamp for the clock time) and each person's
  share of the talking.
- **Click a speaker's name to rename them**, in this meeting or (with *Also in future
  calls*) from now on. For a call that's over, **Update .docx…** brings its document up to
  date (see [When it saves](#when-it-saves)).
- Lines like *"Captions were off 12:40–19:52 (7 min); nothing was recorded"* where the
  recording has a hole: captions off, recording paused, or you'd left and rejoined.
- **Everything / Questions / Action items / Decisions** filters. These are picked out by
  keywords, so skim them in context.
- **Chat messages** (Google Meet): what's typed in the call's chat while its panel is open
  appears in the transcript at the time it was sent, marked *Chat*, and in the Word document.
- **Find** within the transcript.
- **Copy for AI** copies the transcript with a prompt asking for a summary, key points,
  action items and open questions. Paste into any AI chat.
- **Export** as Word, Markdown, plain text or JSON, or copy the transcript.
- **Rename** a meeting by clicking its title. During the call the `.docx` follows; once
  it's over, **Update .docx…** offers a new copy or replacing it.
- **Show in folder** and **Save again** under the title.
- **Delete** with the trash icon (there's an **Undo**). This removes it from the library,
  not the `.docx`. Importing the Meeting Transcripts folder later doesn't bring it back;
  choosing its `.docx` with **Import › File…** does.

## Teams and Zoom

Both work when you join the call **in Chrome**. The desktop apps can't be recorded: a
browser extension only sees browser tabs.

**Microsoft Teams** at `teams.microsoft.com`, `teams.live.com` (personal accounts) or
`teams.cloud.microsoft`. The extension turns on live captions for you (**More (…) ›
Language and speech › Turn on live captions**). The meeting's subject becomes the title;
"Meet now" and one-to-one calls are named after the people in them, like spontaneous Meet
calls.

**Zoom** in the web client: on the meeting invite, click **Join from your browser** (the
address contains `zoom.us/wc/`). The extension clicks **Captions › Show Captions**.
Captions only exist if the meeting's account allows automated captions; if there's no
Captions button, ask the host. Opening **View Full Transcript** in Zoom is optional, but it
gives the most reliable speaker names; without it, names come from the active-speaker
tile. Meetings in someone's personal room ("Sam's Zoom Meeting") are named after the
people in them.

Teams and Zoom change their pages from time to time. If a call isn't being picked up, the
popup offers **Captions not being picked up? Copy a report**. It copies a description of
the page's layout around the captions (never what anyone said) that you can paste into a
[GitHub issue](https://github.com/saigonosenpai/meet-transcripts-chrome-extension/issues),
so it can be fixed in the next version.

## Where your files go and how they're named

```
Downloads/Meeting Transcripts/
  library.json                       ← your history and settings (see below)
  2026-10-11/
    2026-10-11 - Weekly sync - Alice, Bob, Carol, Sam Lee.docx
    2026-10-11 - Call with Alice, Bob.docx
    2026-10-11 - Call with Alice, Bob (2).docx
  2026-10-12/
    2026-10-12 - Design review - Dana, Eli, Sam Lee +3.docx
    2026-10-12 - Call with Dana.docx
```

On Windows that's `C:\Users\<you>\Downloads\Meeting Transcripts\`, on a Mac
`~/Downloads/Meeting Transcripts/`. The files open in Word, Pages, Google Docs and
LibreOffice. Meet, Teams and Zoom calls share the same folders; each document says which
platform it came from.

- **Scheduled meetings** (a calendar event or meeting with a title):
  `Date - Event name - Participants`.
- **Spontaneous calls** (a shared link, "Start an instant meeting", "Meet now", a personal
  Zoom room): `Date - Call with <everyone else who joined>`. The name updates as people
  join. If nobody else joins it's `Solo call`.
- **Date** is the day the call started, `YYYY-MM-DD`, so files sort in order. Each day gets
  its own folder.
- **Participants** are everyone seen in the call plus everyone who spoke; more than four
  become `+N`.
- Two calls that would get the same name on the same day are kept apart as `(2)`, `(3)`.
- Characters Windows and macOS don't allow in file names (`: / \ * ? " < > |`) become
  spaces.

Each document contains the date, duration, platform, participants and meeting link (Meet
and Zoom), speaking time per person, the highlights, and the full transcript with
timestamps and any gaps.

**Want them in Google Drive, OneDrive or Dropbox?** Install that service's desktop app and
have it sync `Downloads/Meeting Transcripts`. In Google Drive for desktop:
**Settings → My Computer → Add folder**. The extension needs no changes for this.

## Your history is safe: library.json

Chrome deletes an extension's stored data when you remove it. To make sure that never
costs you your history, the extension keeps a copy of everything in
**`Downloads/Meeting Transcripts/library.json`**: every meeting, every transcript, the
names you gave meetings and speakers, and your settings. It's rewritten a few seconds after
anything changes.

After a reinstall:

1. The Transcripts tab opens on its own, with **Import** highlighted.
2. Click it, choose **Meeting Transcripts folder…** and pick `Downloads › Meeting Transcripts`.
   Chrome asks you to confirm the upload; it isn't uploaded anywhere, it's only read by the
   extension.
3. Everything is back.

Importing the folder reads `library.json` and every Word document in its day folders: calls
that `library.json` doesn't have, like ones recorded before it existed, come back from their
`.docx` files. So even if `library.json` were lost, your calls come back from the Word
documents. Import never creates duplicates and never removes anything, so doing it twice is
harmless.

An empty library never replaces `library.json`, and a fresh install doesn't write it at all
until you've imported (its new calls wait in `library (since reinstall).json`), so a reinstall
or an update can't wipe your history.

Why a click? Browsers don't let extensions read files on your computer unless you pick
them, so this can't happen silently. Until you import (or choose **Start a new library
instead**), new calls are kept in a separate `library (since reinstall).json`, which is
merged in when you do. Nothing is overwritten.

**Don't delete or move `library.json`.** The `.docx` files are a backup of the transcripts,
but only `library.json` holds your settings and edits.

## Using more than one computer

Each computer keeps its own library. To bring calls from one computer to another:

1. On the first computer, open **All Transcripts** and click **Export** (bottom left). It
   saves your whole library as one file in Downloads, named after the computer, for example
   `Meeting Transcripts library - 2026-10-14 - Windows PC.json`.
2. Move that file to the other computer however you like: email it to yourself, a USB stick,
   a shared drive.
3. On the other computer, open **All Transcripts**, click **Import › File…** and pick the file.

Calls the other computer doesn't have are added, labelled **Recorded on** *the computer they
came from*. A call that was renamed or edited more recently on the first computer is
updated. Import never removes anything, and importing the same file again changes nothing,
so you can repeat this whenever you like, in either direction. Settings (your name,
switches) stay per computer.

The exported file holds every transcript in full: treat it like the calls themselves, and
delete it once it's imported.

## Privacy

- The extension only runs on Google Meet, Teams on the web and Zoom's web client (see the
  table below), and only records while you're in a call there.
- It reads the captions the call displays in **your** browser. It doesn't record audio or
  video.
- Nothing leaves your computer: no servers, no analytics, no accounts. Files go to your
  Downloads folder and data stays in Chrome's local storage.
- Turning captions on is only visible to you. Other people in the call aren't notified,
  and the in-call pill is only in your own browser window.
- **Be considerate:** what others say in a meeting is theirs too. In some places everyone
  in a conversation has to agree before it's recorded, and that can include a transcript.
  Let people know you keep one, and follow your organization's rules and local recording
  laws. The popup says this once, when you first use it.
- **Copy a report** (for troubleshooting) holds the layout of the call page: sizes and
  structure, never what was said or anyone's name.

Permissions it asks for, and why:

| Permission | Used for |
|---|---|
| Read and change data on meet.google.com | Reading the captions and participant names, and turning captions on |
| Read and change data on teams.microsoft.com, teams.live.com, teams.cloud.microsoft | The same, for Teams on the web |
| Read and change data on zoom.us/wc (Zoom's web client) | The same, for Zoom in the browser. Only the meeting pages, not the rest of zoom.us |
| Downloads | Saving the `.docx` files and `library.json` to your Downloads folder |
| Storage | Keeping your transcripts and settings in Chrome |

## FAQ

**Does it turn on captions for everyone in the call?**
No. Captions in Meet, Teams and Zoom are per person. Only you see them, and nobody is told.

**What if I'm invited to a meeting but don't join?**
Nothing is recorded. The extension only captures what your own browser shows while you're
in the call.

**Does it work with the Teams or Zoom desktop app, or on my phone?**
No. Join the call in Chrome (or another Chromium browser) on a computer. In Teams, open the
meeting at teams.microsoft.com; in Zoom, choose **Join from your browser**.

**Does it work in other languages?**
It records whatever the call captions. Set the caption language in the call's settings to
match the conversation. Accuracy is the platform's speech recognition; expect the usual
errors with names and jargon. Renaming a speaker fixes the names.

**What if Chrome or the call is in another language (not English)?**
Recording works in any language. In **Google Meet** everything works too: captions are
turned on and hidden automatically. In **Teams and Zoom**, turning captions on
automatically and enlarging the video look for English button names, so with those in
another language, turn captions on yourself (Teams: **More › Language and speech**; Zoom:
**Captions**); recording then works as usual.

**I left and rejoined the same meeting. Do I get two transcripts?**
In Meet and Zoom, no: rejoining within 10 minutes continues the same transcript and file,
with a "Not in the call" line for the time you were away. In Teams, a call you left
properly is finished; joining again starts a new transcript.

**Can I move, rename or edit the .docx files?**
Yes. Once a call is over its document is yours: the extension never rewrites, renames or
deletes it on its own. If you move it, **Show in folder** can't find it any more; **Update
.docx…** writes a fresh copy back to the folder.

**Can I use it on two computers?**
Yes: **Export** on one and **Import** on the other. See
[Using more than one computer](#using-more-than-one-computer).

## Troubleshooting

**"Manifest file is missing or unreadable" when loading it.** You selected a folder that
doesn't directly contain `manifest.json`, usually the one above it. Select the
`meet-transcripts-chrome-extension` folder that has `manifest.json` inside (see [Install](#install), step 4).
With GitHub's Code › Download ZIP on Windows, that's the inner
`meet-transcripts-chrome-extension-main` folder, inside the one of the same name.

**The badge says `CC` and nothing is recorded.** Captions are off. Click the pill in the
call, or turn captions on yourself: **c** or the CC button in Meet, **More › Language and
speech › Turn on live captions** in Teams, **Captions › Show Captions** in Zoom.

**Zoom has no Captions button.** The meeting's account has automated captions turned off.
The host or account admin can turn them on in the Zoom web portal's meeting settings
(*Automated captions*).

**Teams or Zoom shows captions but nothing is recorded.** Their page has probably changed.
Open the popup in that tab and click **Captions not being picked up? Copy a report**, then
paste it into a [GitHub issue](https://github.com/saigonosenpai/meet-transcripts-chrome-extension/issues).
The report describes the page's layout only, never the captions.

**Files aren't being saved, or a Save dialog appears every time.** Chrome's *Ask where to
save each file before downloading* setting is on. The popup shows a warning with a button
to the setting (`chrome://settings/downloads`). Turn it off, or keep it and save
manually from the library.

**Nothing at all is recorded after a Meet update.** Google occasionally changes Meet's page.
Check for a newer version of the extension, or send a report as above.

**My library is empty after updating.** You probably removed the extension or loaded the
new version from a different folder. Click **Import › Meeting Transcripts folder…** and pick
`Downloads › Meeting Transcripts` (or `Meet Transcripts` from 1.x). That brings back every
call from `library.json` and from the Word documents, even if `library.json` is empty.

**"This extension may have been corrupted" or it disappeared.** The folder you loaded it from
was moved or deleted. Put it back (or download it again), then **Load unpacked** again and
restore from the folder.

**My name shows as "You", or someone's name is wrong.** Set **Your name** in the popup, or
click a name in the library to rename that speaker, with *Also in future calls* if it
keeps happening.

## Version history

What changed in each version is in [CHANGELOG.md](CHANGELOG.md) and on the
[Releases](https://github.com/saigonosenpai/meet-transcripts-chrome-extension/releases) page.

## For developers

No build step and no dependencies: plain Manifest V3 JavaScript. The manifest has a fixed
`key`, so the extension ID (`kddloncdbcaidcdjcjpehapfbgnmicne`) and its stored data stay
the same wherever the folder lives. The repository itself is the extension: load the cloned
folder with **Load unpacked**. (Chrome ignores the tests and docs alongside it.)

```
manifest.json              the extension: these files and folders are what the release zip holds
background.js              toolbar badge; saves each call's .docx and library.json
content/
  recorder.js              captions → transcript, gaps, the in-call pill, saving
  dom.js                   small DOM helpers for the platform adapters
  platforms/               what's specific to each platform: where the captions are,
    meet.js                who's speaking, the meeting title, how to turn captions on,
    teams.js               and whether you're still in the call
    zoom.js
lib/
  shared.js                storage layout, grouping, file naming, the document layout
  docx.js                  tiny dependency-free .docx writer
  docximport.js            reads saved .docx files and library.json back in, for Restore
popup/                     the toolbar popup
viewer/                    the transcript library and reader
icons/
tests/
  e2e.mjs                  end-to-end test in a real Chromium
  fixtures/                pages that imitate Google Meet, Teams and Zoom
docs/screenshots/          images used in this README; docs/INSTALL.txt goes in the zip
.github/workflows/         automatic releases
CHANGELOG.md               what changed in each version (becomes the release notes)
```

Supporting another platform means one more file in `content/platforms/` (the interface is
the object returned at the bottom of `meet.js`), its pages in `manifest.json`, and a mock
page and test.

`tests/e2e.mjs` launches Chromium with the extension and serves the mock pages in
`tests/fixtures/` at the real platforms' URLs. Meet's imitates its caption DOM (in-place
revisions, trimming of long captions, participant tiles, leaving the call); Teams' turns
captions on through its menus and re-draws its caption list; Zoom's has the overlay and the
full-transcript panel. The test checks the stored transcripts, `.docx` names and day folders
in a real Downloads directory, renames of meetings and speakers, gaps, delete and undo,
turning a platform off, the "ask where to save" warning, a full wipe-and-restore from
`library.json`, and moving the files of a 1.x install:

```bash
npm i -D playwright                  # or use a global install
node tests/e2e.mjs . /tmp            # screenshots and a copy of the saved .docx land in /tmp
```

### Releasing

Releases are automatic. `.github/workflows/release.yml` runs on every push to `main`: if the
`version` in `manifest.json` has no release yet, it zips the extension (without tests and
screenshots), runs the end-to-end test on exactly what's in the zip, and publishes release `v<version>` with that
version's section of `CHANGELOG.md` as the notes. To ship an update:

1. Bump `version` in `manifest.json` (e.g. `2.0.0` → `2.1.0`).
2. Add a `## 2.1.0` section at the top of `CHANGELOG.md`.
3. Push to `main`.

Pushes that don't change the version publish nothing. If the test fails, no release is made.

Issues and pull requests are welcome.

## License

[MIT](LICENSE)
