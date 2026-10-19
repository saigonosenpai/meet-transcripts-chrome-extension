# Changelog

Each version here becomes a release on GitHub, with the extension zip attached, as soon as
it's pushed to `main` with the matching `version` in `manifest.json`.

## 2.6.5

- **The transcripts library fits any window size.** In a narrower window, the toolbar
  (*Copy for AI*, *Export*, delete) wraps onto a second line instead of being cut off; on a
  phone-sized window the filters share one row, the search gets its own, and long meeting
  titles no longer push the page wider than the window. The *Export* and *Import* menus and
  the rename box always open fully on screen.

## 2.6.4

- **Fixed: hiding captions didn't enlarge the video when cameras were on.** Meet draws each
  camera's video wider than its tile and crops it; only the part that shows is measured now.
- **A row of cameras that already fills the width is centered** in the space the captions
  leave, instead of sitting at the top with an empty band below (the video can't grow
  without being stretched).

## 2.6.3

- **Move the in-call pill.** Drag the *Recording captions* pill anywhere it's not in the
  way. It stays there in later calls and on any screen size, always fully on screen.
  Double-click it to put it back in the corner.
- **Hidden captions: the enlarged video stays within its own area.** It never covers a
  side panel (chat, people) or takes its clicks.
- **Fixed: showing captions again could put them over the video.** If Meet laid the call out
  again while captions were hidden (someone joining, for example), it left no room for them,
  so once shown they covered the bottom of the tiles. The tiles now shrink to fit above the
  captions until Meet makes room itself.
- Releases no longer include the old `meeting-transcripts.zip`.

## 2.6.2

- **The download is now called `meet-transcripts-chrome-extension.zip`**, so the
  extension's folder can't be mixed up with the *Meeting Transcripts* folder where your
  calls are saved. Each release also has it with the version in its name, and the old
  `meeting-transcripts.zip` link keeps working.

## 2.6.1

- **Popup:** the notes under each section are a little smaller.
- **Releases** also carry the zip named with its version, such as
  `meeting-transcripts-2.6.1.zip`.

## 2.6.0

- **Hide captions on screen now hides the caption strip too.** Captions still have to be
  on (they're what gets recorded), but with this switch on they're moved out of the way
  completely: the empty strip they left at the bottom of the call is gone and the video
  is enlarged into the space, on any screen size. Turn the switch off and the captions
  come back where they were.
- **Hide captions on screen is on by default**, and updating to 2.6.0 switches it on once
  for everyone, since it now gives the video the space back. Turn it off in the popup or
  from the call.
- **Show or hide captions from the call.** The in-call pill has a *Show captions* /
  *Hide captions* button, the same switch as in the popup.
- **The popup shows the installed version** in its top-right corner, and the tagline gets a 😉.
- **Copy a report** now also describes the layout around the captions (sizes and
  structure, never what was said), to fix this quickly if a call page lays out
  differently.

## 2.5.2

- **Fixed: `library.json` could be replaced by an empty library.** After the extension was
  removed and added back (which empties Chrome's copy), updating it marked that empty
  library as ready, and the next change wrote it over the full `library.json`. Now an empty
  library is never written, and a fresh install only writes `library.json` once you've
  imported (or chosen to start a new library). If it happened to you: your calls are still in
  the Word documents. **Import › Meeting Transcripts folder…** brings them back.
- **Import takes a whole folder again.** **Import › Meeting Transcripts folder…** reads
  `library.json` and every Word document in the day folders; **Import › File…** takes an
  exported library or single files.

## 2.5.1

- *Nobody knows that you're taking notes.* The tagline, in the popup and the README.

## 2.5.0

- **Export and Import instead of Sync.** Syncing through a folder needed a cloud storage app
  on every computer. Now, to bring calls to another computer: **Export** in All
  Transcripts saves your whole library as one file; **Import** it on the other computer.
  Calls it doesn't have are added (labelled *Recorded on* that computer), a call edited
  more recently on the other computer is updated, and nothing is ever removed, so
  importing again is harmless. Nothing goes online.
- **Import** is also how you bring your history back after a reinstall: pick `library.json`
  (and Word documents, if you like) from `Downloads › Meeting Transcripts`.
- A computer that had 2.4's sync on goes back to keeping `library.json`; a 2.4 sync file can
  still be imported.

## 2.4.1

- **One button, Sync, instead of two.** *Restore from folder…* and *Sync across devices…*
  are now one: **Sync** in All Transcripts connects your `Meeting Transcripts` folder. It
  brings back everything already in it (`library.json`, your other computers' sync files,
  and Word documents of calls it doesn't have) and then keeps the library in step with
  your other computers.
- **Fixed: a newly connected computer showed nothing** while your other computer hadn't
  connected yet. Connecting now also reads that computer's `library.json`.
- Browsers that don't let extensions keep a folder (Brave turns it off) get a one-time
  restore from the folder instead.

## 2.4.0

- **Sync across devices.** Use the extension on several computers and each one's library
  shows the calls from all of them: transcripts, renamed meetings and speakers, and
  deletions. Your cloud app (Google Drive, OneDrive, Dropbox or iCloud Drive) moves the
  files; the extension still never connects to anything. Set up in **All Transcripts ›
  Sync across devices…**; the README has the steps for each cloud app. Calls from another
  computer are labelled *Recorded on* that computer.
- **Restore from folder…** also reads the synced computers' files.

## 2.2.3

- **Simpler to install.** The download is now always called `meeting-transcripts.zip`,
  and unzipping it gives the folder to select in *Load unpacked* directly, with
  `manifest.json` inside, instead of a folder within a folder (which led to *"Manifest
  file is missing or unreadable"*). The zip includes a short `INSTALL.txt`, and the
  README starts with step-by-step install instructions and a screenshot. The extension
  itself is unchanged.

## 2.2.2

- **Word documents are about 4 times smaller.** They're now compressed, as Word itself
  does; they open the same in Word, Google Docs and LibreOffice. Your existing documents
  are re-saved compressed once, automatically, after the update.
- **Fixed: doubled names in file names.** Meet can hold a hidden second copy of a name
  in a video tile, which gave files like *Marketo Catchup - Isuru IlangarathneIsuru
  Ilangarathne, …*. Only the visible name is read now, and names already recorded this
  way are cleaned up; the same automatic re-save renames those files, and the icon-name
  files from 2.2.1 too.

## 2.2.1

- **Fixed: icon names in file names.** In some Meet calls, the names of the pin and
  framing icons on video tiles (`keep_outline`, `frame_person`, `keep_off`) were taken
  for participants, giving files like *Weekly WIP - keep_outline, frame_person, …*. They're
  now ignored. For a call that already got such a name, open it in All Transcripts and
  click **Save again**: the file is saved under the right name and the old one removed.

## 2.2.0

- **A livelier popup.** The status card is now in colour and changes with what's happening:
  blue when you're not in a call, red while recording, orange when it needs you (paused,
  or captions are off), grey when recording is turned off for that site. The library
  tiles get their own colours and icons too.

## 2.1.0

- **Your library at a glance** in the popup: how many calls you've recorded, their total
  length, and the space your Word documents and `library.json` take on disk, with a
  Meet / Teams / Zoom breakdown and when the backup was last saved. Click *calls* to open
  the library, or *on disk* to open the folder.

## 2.0.1

- Captions are always turned on when you join a call: everything depends on them, so the
  *Turn on captions automatically* switch is gone. To keep a call out of your transcripts,
  **Pause** (in the popup or the in-call pill); while paused, captions aren't turned on.

## 2.0.0

### Now records Microsoft Teams and Zoom too, and is called Meeting Transcripts

- **Teams and Zoom in the browser.** Calls in Teams on the web (teams.microsoft.com,
  teams.live.com, teams.cloud.microsoft) and in Zoom's web client ("Join from your browser")
  are recorded like Google Meet calls: captions turned on for you, saved as a Word document
  per call, in the same library. Each meeting is labelled Meet, Teams or Zoom, and the
  document says which. Turn any platform off in the popup under *Record calls in*. The
  desktop apps can't be recorded by a browser extension.
- **Rename a speaker.** Click a name in the library to fix it (a phone number,
  "Presentation", a misspelling), in that meeting or, with *Also in future calls*, from
  then on. The Word document is updated too, as it now is when you rename a meeting.
- **Gaps are marked.** When captions were off, recording was paused or you'd left and
  rejoined, the transcript says so: "Captions were off 12:40–19:52 (7 min); nothing was
  recorded".
- **An indicator in the call.** A small *Recording captions* pill in the corner of the call;
  click it to pause, resume or turn captions on. Only you see it, and it can be turned off
  in the popup.
- **Copy a report** from the popup when a call's captions aren't being picked up: it
  describes the page's layout (never the captions) so a Teams or Zoom page change can be
  fixed quickly.
- Captions are picked up sooner after they appear, and a caption list the page re-draws is
  no longer recorded twice.

**Your files move.** The folder is now `Downloads/Meeting Transcripts`. On the first start,
saved documents and `library.json` move there from `Downloads/Meet Transcripts` by
themselves; delete the old folder afterwards. **Restore from folder…** accepts either.

## 1.4.0

### Your history now survives reinstalls

Meet Transcripts now keeps a `library.json` in `Downloads/Meet Transcripts`: every meeting,
transcript and setting, updated after each change. If you remove the extension, reinstall it,
or move to a new computer, click **Restore from folder…** on the tab that opens and pick the
`Meet Transcripts` folder. Everything comes back.

- `library.json` saved alongside your Word documents.
- **Restore from folder…** in the library rebuilds your history from `library.json`, and from
  any saved `.docx` files (including ones from older versions).
- After a fresh install the library opens itself and points you to Restore.

Updating from an earlier version? Click **Restore from folder…** once afterwards to bring in
anything that was saved only as `.docx`.

## 1.3.0

- Redesigned popup and library: Apple-style look, dark mode, segmented filters, export menu,
  undo for delete.

## 1.2.0

- Each call is saved as a `.docx` in Downloads (no Google sign-in), the same on Windows and Mac.
- Spontaneous calls are named after who joined (`Call with …`).
- A folder per day.

## 1.1.0

- Saved each call to Google Drive (replaced by local `.docx` files in 1.2.0).

## 1.0.0

- First release: records Meet captions into a searchable library.
