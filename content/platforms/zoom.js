// Zoom's web client ("Join from your browser": <host>.zoom.us/wc/…).
//
// Captions appear as an overlay of recent lines; the "View full transcript" panel lists every
// line with the speaker's name. We read the panel when it's open and the overlay otherwise,
// taking the speaker from the line itself or else from the active-speaker tile. Captions only
// exist when the meeting's account allows automated captions.

const MT_PLATFORM = (() => {
  const { first, all, control, clickWhenShown, closeMenus, sleep, cleanName } = MT_DOM;

  const PANEL_SEL = ['.lt-full-transcript__list', '[class*="full-transcript__list"]', '[class*="lt-full-transcript"]',
    '[aria-label*="transcript" i][role="list"]'];
  const OVERLAY_SEL = ['#live-transcription-subtitle', '.live-transcription-subtitle__box',
    '[class*="live-transcription-subtitle"]', '[class*="closed-caption-container"]', '[class*="subtitle-container"]'];
  const ITEM_SEL = '[class*="full-transcript__item"], [class*="transcript__item"], [class*="subtitle__item"], ' +
    '[class*="caption__item"], [class*="caption-item"], [class*="subtitle-item"]';
  const NAME_SEL = '[class*="display-name"], [class*="speaker-name"], [class*="__name"], [class*="user-name"]';
  const TEXT_SEL = '[class*="__message"], [class*="__text"], [class*="__content"], [class*="caption-text"], [class*="subtitle-text"]';
  const ACTIVE_SPEAKER_SEL = ['.speaker-active-container__video-frame .video-avatar__avatar-name',
    '.speaker-bar-container__video-frame--active .video-avatar__avatar-name',
    '[class*="active-speaker"] [class*="avatar-name"]', '[class*="video-avatar--active"] [class*="avatar-name"]'];
  const LEAVE_SEL = ['.footer__leave-btn', 'button[aria-label^="Leave" i]', 'button[aria-label="End" i]',
    '[class*="leave-meeting"] button', '.footer-button__leave-btn'];
  const TOPIC_SEL = ['.meeting-info-container__topic', '[class*="meeting-topic"]', '[class*="meeting-info"] [class*="topic"]'];

  const meetingNumber = () => (location.pathname.match(/\/wc\/(?:join\/)?(\d{9,12})\b/) || [])[1] || null;
  const inCall = () => !!first(LEAVE_SEL);

  function captionRegion() {
    return first(PANEL_SEL) || first(OVERLAY_SEL);
  }

  function blocks(region) {
    const items = region.querySelectorAll(ITEM_SEL);
    if (items.length) return [...items];
    // An overlay without item classes: each direct child (or the region itself) is a line.
    return region.children.length ? [...region.children] : [region];
  }

  const activeSpeaker = () => { const el = first(ACTIVE_SPEAKER_SEL); return el ? cleanName(el.textContent) : ""; };

  function parseBlock(block, lastSpeaker) {
    const nameEl = block.querySelector(NAME_SEL);
    const textEl = block.querySelector(TEXT_SEL);
    let speaker = nameEl ? nameEl.innerText : "";
    let text = textEl ? textEl.innerText : block.innerText;
    if (!textEl && nameEl) text = text.replace(nameEl.innerText, "");
    // "Jane Doe: what she said" in a single line.
    const m = !speaker && text.match(/^([^:\n]{2,40}):\s+([\s\S]+)$/);
    if (m) { speaker = m[1]; text = m[2]; }
    text = text.replace(/^\s*\d{1,2}:\d{2}(:\d{2})?\s*(AM|PM)?\s*/i, ""); // a timestamp in the panel
    speaker = cleanName(speaker);
    return { speaker: speaker || activeSpeaker() || lastSpeaker || "Speaker", text, inferred: !speaker };
  }

  // The meeting topic; personal rooms ("Jane's Zoom Meeting") count as spontaneous calls.
  function eventTitle() {
    const el = first(TOPIC_SEL);
    const t = (el ? el.textContent : document.title.replace(/\s*[-|–]\s*Zoom.*$|^Zoom\s*[-|–]?\s*/i, "")).trim();
    if (!t || /^(zoom|zoom meeting|zoom workplace|meeting)$/i.test(t)) return "";
    return /['’]s (zoom meeting|personal meeting room)$/i.test(t) ? "" : t;
  }

  const participants = () => all(['.participants-item__display-name', '.video-avatar__avatar-name', '[class*="participants-item__name"]'])
    .map((el) => cleanName(el.textContent));

  // Your entry in the Participants panel is marked "(Me)".
  function selfName() {
    const me = all(['.participants-item__name-section', '[class*="participants-item__name"]'])
      .find((el) => /\((me|you)\)/i.test(el.textContent));
    return me ? cleanName(me.textContent) : "";
  }

  // The CC / Captions button, then "Show Captions" if it opens a menu. In a narrower window
  // Zoom moves Captions under More (…): it's looked for there too.
  const CAPTIONS_RE = /^(captions|show captions|closed caption|cc|live transcript|show subtitle|subtitles)$/i;
  const MORE_SEL = ['button[aria-label="More" i]', 'button[aria-label^="More " i]', '[class*="more-button"] button',
    'button[class*="more-button"]'];
  async function enableCaptions() {
    let btn = control(CAPTIONS_RE) ||
      first(['button[aria-label*="caption" i]', 'button[aria-label*="subtitle" i]', 'button[aria-label*="transcript" i]']);
    if (!btn) {
      const more = control(/^more$/i) || first(MORE_SEL);
      if (!more) return;
      more.click();
      for (let waited = 0; waited <= 1200 && !(btn = control(CAPTIONS_RE)); waited += 150) await sleep(150);
      if (!btn) { closeMenus(); return; }
    }
    btn.click();
    await sleep(300);
    await clickWhenShown(/^(show captions|show subtitle|show subtitles|enable captions|turn on captions)$/i, 1200);
    await sleep(200);
    if (document.querySelector('[role="menu"]')) closeMenus();
  }

  return {
    id: "zoom",
    callId: () => meetingNumber() || (inCall() ? "zoom" : null),
    inCall,
    captionRegion,
    blocks,
    parseBlock,
    eventTitle,
    participants,
    selfName,
    enableCaptions,
    captionHint: "Click Captions (CC) › Show Captions. The meeting's host must allow automated captions.",
    link: (code) => (/^\d+$/.test(code) ? "https://zoom.us/j/" + code : ""),
    resumeAfterLeave: true,
  };
})();
