// Reads the .docx files this extension saved back into meetings, so a library that was
// lost (e.g. the extension was removed, which clears its storage) can be rebuilt.
//
// The files hold: a title, a "Date / Platform / Participants / Meeting link" paragraph, and a
// "Transcript" section of "Speaker [m:ss]" + text paragraphs (see MT.docBlocks).
// Files re-saved in Word are compressed and split into more runs; both are handled.

const DOCX_IMPORT = (() => {
  // --- unzip just word/document.xml ---------------------------------------------------------

  async function inflate(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function documentXml(buffer) {
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    // Find the central directory through the end-of-central-directory record.
    let end = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
      if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
    }
    if (end < 0) throw new Error("not a zip file");
    let pos = view.getUint32(end + 16, true);
    const count = view.getUint16(end + 10, true);
    for (let n = 0; n < count; n++) {
      const method = view.getUint16(pos + 10, true);
      const size = view.getUint32(pos + 20, true);
      const nameLen = view.getUint16(pos + 28, true);
      const extraLen = view.getUint16(pos + 30, true);
      const commentLen = view.getUint16(pos + 32, true);
      const local = view.getUint32(pos + 42, true);
      const name = new TextDecoder().decode(bytes.subarray(pos + 46, pos + 46 + nameLen));
      if (name === "word/document.xml") {
        const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
        const data = bytes.subarray(start, start + size);
        const raw = method === 0 ? data : method === 8 ? await inflate(data) : null;
        if (!raw) throw new Error("unsupported compression");
        return new TextDecoder().decode(raw);
      }
      pos += 46 + nameLen + extraLen + commentLen;
    }
    throw new Error("no document in the file");
  }

  // --- paragraphs ------------------------------------------------------------------------

  const unescape = (s) => s.replace(/&(lt|gt|quot|apos|amp|#(\d+)|#x([0-9a-f]+));/gi, (m, name, dec, hex) =>
    dec ? String.fromCodePoint(+dec) : hex ? String.fromCodePoint(parseInt(hex, 16))
      : { lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" }[name.toLowerCase()]);

  function paragraphs(xml) {
    const out = [];
    for (const [body] of xml.matchAll(/<w:p[\s>][\s\S]*?<\/w:p>|<w:p\/>/g)) {
      const style = (body.match(/<w:pStyle w:val="([^"]+)"/) || [])[1] || "Normal";
      let text = "";
      for (const piece of body.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:t\/>|<w:(br|cr)\b[^>]*\/>|<w:tab\/>/g)) {
        if (piece[1] !== undefined) text += unescape(piece[1]);
        else if (piece[2]) text += "\n";
        else if (piece[0] === "<w:tab/>") text += "\t";
      }
      out.push({ style, text });
    }
    return out;
  }

  // --- a meeting from the paragraphs -----------------------------------------------------

  const clockMs = (s) => s.split(":").reduce((total, part) => total * 60 + Number(part), 0) * 1000;

  function durationMs(text) {
    if (/^<1 min$/.test(text)) return 30_000;
    const h = (text.match(/(\d+)\s*h/) || [])[1] || 0;
    const m = (text.match(/(\d+)\s*min/) || [])[1] || 0;
    return (h * 60 + Number(m)) * 60_000;
  }

  /** Parses one saved file. `fileName` supplies the date (YYYY-MM-DD) the document leaves out. */
  async function parse(buffer, fileName) {
    const paras = paragraphs(await documentXml(buffer));
    const title = paras.find((p) => p.style === "Title")?.text.trim();
    const info = paras.find((p) => /^Date: /m.test(p.text))?.text || "";
    const start = paras.findIndex((p) => /^Heading/.test(p.style) && p.text.trim() === "Transcript");
    if (!title || start < 0) throw new Error("not a Meeting Transcripts document");

    const day = (fileName.match(/(\d{4})-(\d{2})-(\d{2})/) || []).slice(1).map(Number);
    const dateLine = (info.match(/^Date: (.*)$/m) || [])[1] || "";
    const time = dateLine.match(/(\d{1,2}):(\d{2})\s*([AP]M)?/i);
    let hours = time ? Number(time[1]) % 12 + (/pm/i.test(time[3] || "") ? 12 : 0) : 12;
    if (time && !time[3]) hours = Number(time[1]); // a 24-hour clock
    if (day.length !== 3) throw new Error("the file name has no date");
    const startedAt = new Date(day[0], day[1] - 1, day[2], hours, time ? Number(time[2]) : 0).getTime();
    const duration = durationMs((dateLine.match(/\(([^)]*)\)\s*$/) || [])[1] || "");

    const participants = ((info.match(/^Participants: (.*)$/m) || [])[1] || "")
      .split(",").map((s) => s.trim()).filter((s) => s && s !== "—");
    // "Platform:" arrived with Teams and Zoom support; older files are all Google Meet.
    const platformName = ((info.match(/^Platform: (.*)$/m) || [])[1] || "").trim();
    const platform = /teams/i.test(platformName) ? "teams" : /zoom/i.test(platformName) ? "zoom" : "meet";
    const linkText = ((info.match(/^Meeting link: (.*)$/m) || [])[1] || "").trim();
    const code = (linkText.match(/meet\.google\.com\/([a-z]{3,4}-[a-z]{4}-[a-z]{3,4})/) ||
      linkText.match(/zoom\.us\/j\/(\d+)/) || [])[1] || (platform === "meet" ? "imported" : platform);

    const entries = [];
    for (const p of paras.slice(start + 1)) {
      const m = p.text.match(/^(.+?) \[(\d+(?::\d{2}){1,2})\]\n([\s\S]+)$/);
      if (!m) continue; // the closing note, or anything that isn't a turn
      entries.push({ speaker: m[1].trim(), text: m[3].replace(/\s+/g, " ").trim(), ts: startedAt + clockMs(m[2]) });
    }
    if (!entries.length) throw new Error("no transcript in the document");

    // A spontaneous call's title is made of the others' names; whoever is left over is you.
    // (The earliest version titled them by meeting code, "Meet abc-defg-hij".)
    const spontaneous = /^(Call with |Solo call$|Meet [a-z]{3,4}-[a-z]{4}-[a-z]{3,4}$)/.test(title);
    const named = /^Call with /.test(title) ? title.replace(/^Call with /, "").replace(/ \+\d+$/, "").split(", ") : [];
    const leftOver = participants.filter((n) => !named.includes(n));
    const meta = {
      id: `${code}-${startedAt}`,
      platform,
      code,
      link: linkText ? "https://" + linkText.replace(/^https?:\/\//, "") : "",
      eventTitle: spontaneous ? "" : title,
      self: spontaneous && leftOver.length === 1 ? leftOver[0] : "",
      startedAt,
      endedAt: Math.max(startedAt + duration, entries[entries.length - 1].ts),
      participants,
      importedFrom: fileName,
    };
    return { meta, entries };
  }

  /** Reads a library.json this extension saved; null for anything else. */
  function parseLibrary(text) {
    let data;
    try { data = JSON.parse(text); } catch { return null; }
    if (!data || data.app !== "meet-transcripts" || data.kind !== "library" || typeof data.meetings !== "object") return null;
    const keep = { hideCaptions: "boolean", myName: "string", autoSave: "boolean",
      showIndicator: "boolean", platforms: "object", nameMap: "object" };
    const settings = Object.fromEntries(Object.entries(data.settings || {})
      .filter(([k, v]) => typeof v === keep[k] && v !== null && !Array.isArray(v)));
    const meetings = Object.values(data.meetings).filter((m) =>
      m && typeof m.id === "string" && Number.isFinite(m.startedAt) && Array.isArray((data.transcripts || {})[m.id]));
    // From an export (or a 2.4 sync file): which computer it came from.
    const device = data.device && typeof data.device.id === "string" ? { id: data.device.id, name: String(data.device.name || "") } : null;
    const trash = data.trash && typeof data.trash === "object" ? data.trash : {};
    return { settings, meetings, transcripts: data.transcripts, files: data.files || {}, device, trash };
  }

  return { parse, parseLibrary };
})();
