// Google Meet. Captions are one block per speaker turn: a name and a line of text that is
// revised in place (and trimmed at the front once it gets long).

const MT_PLATFORM = (() => {
  const { first, cleanName } = MT_DOM;
  // Meet's class names are obfuscated and change between releases, so every lookup has a
  // structural fallback.
  const REGION_SEL = ['[role="region"][aria-label*="aption" i]', '[role="region"][aria-label*="ubtit" i]',
    'div[jsname="dsyhDe"]', 'div[jsname="tgaKEf"]'];
  const BLOCK_SEL = ".nMcdL, .TBMuR";
  const SPEAKER_SEL = ".NWpY1d, .zs7s8d, .KcIKyf";
  const TEXT_SEL = ".ygicle, .bh44bd, .iTTPOb";
  // Participant names: video tiles, then the People panel.
  const TILE_SEL = "[data-participant-id]";
  const TILE_NAME_SEL = "[data-self-name], .zWGUib, .XEazBc, .dwSJ2e, .notranslate";
  const PEOPLE_SEL = '[role="list"][aria-label*="articipant" i] [role="listitem"][aria-label]';
  // Your own name: the account button on Meet's "Ready to join?" screen is labelled
  // "Google Account: Jane Doe (jane@example.com)".
  const ACCOUNT_SEL = '[aria-label^="Google Account:"]';

  // The call: its code, wherever Meet puts it in the address (MT.meetCode). An address with no
  // code (a format Meet hasn't used before, a named room) is still a call when the call's
  // controls are on screen; it's known by its address then (also its link).
  const callId = () => MT.meetCode(location.pathname) ||
    (location.pathname.length > 1 && captionButtons().length ? location.pathname.replace(/^\/+|\/+$/g, "") : null);

  // Found by its label in English, and in any language by Meet's own id for the captions
  // button (jsname="RrG0hf"), which doesn't depend on the page's language.
  const CAPTION_BTN_SEL = 'button[jsname="RrG0hf"]';
  const captionButtons = () => [...new Set([...document.querySelectorAll(CAPTION_BTN_SEL),
    ...[...document.querySelectorAll("button[aria-label]")].filter((b) => /caption/i.test(b.getAttribute("aria-label")))])];

  function blocks(region) {
    const found = region.querySelectorAll(BLOCK_SEL);
    if (found.length) return [...found];
    let el = region;
    while (el.children.length === 1) el = el.children[0];
    return [...el.children].filter((c) => c.tagName !== "BUTTON" && !c.querySelector("button"));
  }

  function parseBlock(block, lastSpeaker) {
    const textEl = block.querySelector(TEXT_SEL);
    const speakerEl = block.querySelector(SPEAKER_SEL);
    if (textEl) return { speaker: speakerEl ? speakerEl.innerText : lastSpeaker, text: textEl.innerText, inferred: !speakerEl };
    const lines = block.innerText.split("\n").map((l) => l.trim()).filter(Boolean);
    return lines.length < 2 ? null : { speaker: lines[0], text: lines.slice(1).join(" ") };
  }

  // The calendar event's title, or "" for a spontaneous call (Meet then shows just the code).
  function eventTitle() {
    const code = callId();
    const el = document.querySelector("[data-meeting-title]");
    let t = el ? el.getAttribute("data-meeting-title") : "";
    if (!t) t = document.title.replace(/^\s*(Google\s+)?Meet\s*[-–—:|]\s*/i, "").trim();
    return t && t !== code && !/^(google )?meet$/i.test(t) ? t : "";
  }

  // Meet's icons are text in an icon font ("keep_outline", "frame_person"), and they carry
  // the same notranslate class as names, so skip anything hidden from screen readers or
  // drawn in a symbol font.
  const isIcon = (el) => !!el.closest('[aria-hidden="true"]') || /icon|symbol/i.test(el.getAttribute("class") || "") ||
    /symbols|icons/i.test(getComputedStyle(el).fontFamily) || MT.isIconName(el.textContent.trim());

  function participants() {
    const names = [];
    for (const tile of document.querySelectorAll(TILE_SEL)) {
      const el = [...tile.querySelectorAll(TILE_NAME_SEL)].find((e) => !isIcon(e) && e.innerText.trim());
      // Your own tile is often labelled "You"; the recorder adds your real name.
      // innerText, not textContent: the name element can hold a hidden copy of the name.
      if (el && !tile.querySelector("[data-self-name]")) names.push(el.innerText);
    }
    for (const item of document.querySelectorAll(PEOPLE_SEL)) names.push(item.getAttribute("aria-label"));
    return names.map(cleanName);
  }

  function selfName() {
    const el = document.querySelector(ACCOUNT_SEL);
    return el ? el.getAttribute("aria-label").replace(/^Google Account:\s*/i, "").split(/\s*[(\n]/)[0].trim() : "";
  }

  function enableCaptions() {
    const btn = captionButtons().find((b) =>
      /turn on|show/i.test(b.getAttribute("aria-label") || "") || b.getAttribute("aria-pressed") === "false");
    if (btn) btn.click();
  }

  return {
    id: "meet",
    callId,
    // The caption button only exists inside a call; once it is gone the user has left.
    inCall: () => !!first(REGION_SEL) || captionButtons().length > 0,
    captionRegion: (root = document) => first(REGION_SEL, root),
    pip: true, // Meet's picture-in-picture window shows captions too (see the recorder)
    controlSel: CAPTION_BTN_SEL, // in the control bar, whatever the language
    blocks,
    parseBlock,
    eventTitle,
    participants,
    selfName,
    enableCaptions,
    captionHint: "Turn on captions (CC button, or press c).",
    link: (code) => "https://meet.google.com/" + code,
    // A meeting code is unique, so rejoining it soon after continues the same transcript.
    resumeAfterLeave: true,
  };
})();
