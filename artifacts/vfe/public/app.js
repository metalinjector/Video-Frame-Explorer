/* ============================================================
   Video Frame Explorer — main application
   Vanilla JS, no build step, works over file://
   ============================================================ */
(function () {
  "use strict";

  const { analyzePalette, frameMarkdown, combinedMarkdown } = window.VFEPalette;

  // -------------------- DOM --------------------
  const $ = (s) => document.querySelector(s);
  const screenUpload = $("#screen-upload");
  const screenApp = $("#screen-app");
  const dropzone = $("#dropzone");
  const fileInput = $("#file-input");
  const video = $("#source-video");
  const controlsEl = $("#controls");
  const contentEl = $("#content");
  const selToolbar = $("#seltoolbar");
  const selCountEl = $("#sel-count");
  const selectAllLabel = $("#select-all-label");
  const btnSelectAll = $("#btn-select-all");
  const btnZip = $("#btn-zip");
  const btnMd = $("#btn-md");
  const btnBack = $("#btn-back");
  const toastEl = $("#toast");
  const busyEl = $("#busy");
  const busyLabel = $("#busy-label");
  const lightbox = $("#lightbox");
  const lightboxImg = $("#lightbox-img");
  const lightboxCaption = $("#lightbox-caption");

  // offscreen canvases
  const previewCanvas = document.createElement("canvas");
  const pctx = previewCanvas.getContext("2d", { willReadFrequently: true });
  const paletteCanvas = document.createElement("canvas");
  const sctx = paletteCanvas.getContext("2d", { willReadFrequently: true });
  const fullCanvas = document.createElement("canvas");
  const fctx = fullCanvas.getContext("2d");

  // -------------------- state --------------------
  const state = {
    duration: 0,
    fileName: "",
    history: [],
    segmentCount: 5,
    freeTime: 0,
  };
  const selected = new Map();      // key -> frame
  const frameCache = new Map();    // key -> frame | Promise<frame>
  let visibleCards = [];           // [{ frame, el, checkbox, selectable }]
  let renderToken = 0;             // cancels stale grid fills

  const SVG = {
    check: '<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>',
    focus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>',
    download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>',
  };

  // -------------------- helpers --------------------
  function fmtTime(t) {
    if (!isFinite(t) || t < 0) t = 0;
    let cent = Math.round((t - Math.floor(t)) * 100);
    let sec = Math.floor(t);
    if (cent === 100) { cent = 0; sec += 1; }
    let min = Math.floor(sec / 60);
    sec = sec % 60;
    return `${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}.${String(cent).padStart(2, "0")}`;
  }
  const selKey = (t) => t.toFixed(2);
  const secLabel = (t) => t.toFixed(2) + "s";
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function toast(msg, type) {
    toastEl.textContent = msg;
    toastEl.className = "toast" + (type ? " toast--" + type : "");
    toastEl.hidden = false;
    requestAnimationFrame(() => toastEl.classList.add("is-show"));
    clearTimeout(toast._t);
    toast._t = setTimeout(() => {
      toastEl.classList.remove("is-show");
      setTimeout(() => (toastEl.hidden = true), 350);
    }, 2600);
  }
  function setBusy(on, label) {
    busyLabel.textContent = label || "Обработка…";
    busyEl.hidden = !on;
  }
  function debounce(fn, ms) {
    let t;
    return function (...a) { clearTimeout(t); t = setTimeout(() => fn.apply(this, a), ms); };
  }
  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  // -------------------- frame extraction --------------------
  let seekChain = Promise.resolve();
  function seekTo(t) {
    seekChain = seekChain.then(() => new Promise((resolve) => {
      const target = clamp(t, 0, Math.max(0, state.duration - 0.001));
      if (Math.abs(video.currentTime - target) < 0.001 && video.readyState >= 2) {
        resolve(); return;
      }
      let done = false;
      const onSeeked = () => {
        if (done) return; done = true;
        video.removeEventListener("seeked", onSeeked);
        resolve();
      };
      video.addEventListener("seeked", onSeeked);
      try { video.currentTime = target; }
      catch (e) { done = true; video.removeEventListener("seeked", onSeeked); resolve(); }
      setTimeout(() => { if (!done) { done = true; video.removeEventListener("seeked", onSeeked); resolve(); } }, 4000);
    }));
    return seekChain;
  }

  function grabFrame(time, label) {
    const key = selKey(time);
    const cached = frameCache.get(key);
    if (cached) return Promise.resolve(cached);

    const p = (async () => {
      await seekTo(time);
      const vw = video.videoWidth || 16, vh = video.videoHeight || 9;

      const maxW = 640;
      const scale = Math.min(1, maxW / vw);
      const pw = Math.max(1, Math.round(vw * scale));
      const ph = Math.max(1, Math.round(vh * scale));
      previewCanvas.width = pw; previewCanvas.height = ph;
      pctx.drawImage(video, 0, 0, pw, ph);
      const blob = await new Promise((r) => previewCanvas.toBlob(r, "image/jpeg", 0.85));
      const previewUrl = URL.createObjectURL(blob);

      const sScale = Math.min(1, 160 / vw);
      const sw = Math.max(1, Math.round(vw * sScale));
      const sh = Math.max(1, Math.round(vh * sScale));
      paletteCanvas.width = sw; paletteCanvas.height = sh;
      sctx.drawImage(video, 0, 0, sw, sh);
      const paletteImageData = sctx.getImageData(0, 0, sw, sh);

      const frame = { time, timecode: fmtTime(time), label: label || "", previewUrl, paletteImageData };
      frameCache.set(key, frame);
      return frame;
    })();

    frameCache.set(key, p);
    p.then((f) => frameCache.set(key, f)).catch(() => frameCache.delete(key));
    return p;
  }

  async function grabPngBytes(time) {
    await seekTo(time);
    fullCanvas.width = video.videoWidth || 16;
    fullCanvas.height = video.videoHeight || 9;
    fctx.drawImage(video, 0, 0);
    const blob = await new Promise((r) => fullCanvas.toBlob(r, "image/png"));
    return new Uint8Array(await blob.arrayBuffer());
  }

  // -------------------- selection --------------------
  function isSelected(frame) { return selected.has(selKey(frame.time)); }

  function toggleSelect(frame) {
    const k = selKey(frame.time);
    if (selected.has(k)) selected.delete(k);
    else selected.set(k, frame);
    syncCardSelection(frame);
    updateToolbar();
  }

  function syncCardSelection(frame) {
    const k = selKey(frame.time);
    const on = selected.has(k);
    visibleCards.forEach((c) => {
      if (c.frame && selKey(c.frame.time) === k) {
        c.el.classList.toggle("is-selected", on);
        if (c.checkbox) c.checkbox.checked = on;
      }
    });
  }

  function updateToolbar() {
    selCountEl.textContent = selected.size;
    btnZip.disabled = selected.size === 0;
    btnMd.disabled = selected.size === 0;
    const sel = visibleCards.filter((c) => c.selectable && c.frame);
    const allSel = sel.length > 0 && sel.every((c) => isSelected(c.frame));
    selectAllLabel.textContent = allSel ? "Снять выделение" : "Выбрать все";
  }

  btnSelectAll.addEventListener("click", () => {
    const sel = visibleCards.filter((c) => c.selectable && c.frame);
    const allSel = sel.length > 0 && sel.every((c) => isSelected(c.frame));
    sel.forEach((c) => {
      const k = selKey(c.frame.time);
      if (allSel) selected.delete(k);
      else selected.set(k, c.frame);
      syncCardSelection(c.frame);
    });
    updateToolbar();
  });

  // -------------------- single-frame actions --------------------
  async function downloadPng(frame) {
    try {
      setBusy(true, "Извлечение кадра…");
      const bytes = await grabPngBytes(frame.time);
      downloadBlob(new Blob([bytes], { type: "image/png" }), `frame_${secLabel(frame.time)}.png`);
      toast("PNG сохранён", "ok");
    } catch (e) { toast("Не удалось извлечь кадр", "err"); }
    finally { setBusy(false); }
  }

  function downloadColors(frame) {
    const palette = analyzePalette(frame.paletteImageData, 20);
    const md = frameMarkdown(frame, palette);
    downloadBlob(new Blob([md], { type: "text/markdown" }), `frame_${secLabel(frame.time)}_colors.md`);
    toast("Палитра сохранена", "ok");
  }

  function openFocus(time) { navTo({ type: "focus", time: time }); }

  // -------------------- group actions --------------------
  btnZip.addEventListener("click", async () => {
    if (selected.size === 0) return;
    const frames = [...selected.values()].sort((a, b) => a.time - b.time);
    const zip = new window.VFEZip();
    setBusy(true, `Подготовка ZIP (0/${frames.length})…`);
    try {
      for (let i = 0; i < frames.length; i++) {
        setBusy(true, `Извлечение кадров (${i + 1}/${frames.length})…`);
        const bytes = await grabPngBytes(frames[i].time);
        const idx = String(i + 1).padStart(3, "0");
        zip.add(`frame_${idx}_${secLabel(frames[i].time)}.png`, bytes);
      }
      setBusy(true, "Сборка архива…");
      const blob = await zip.generate();
      downloadBlob(blob, `frames_${frames.length}.zip`);
      toast(`Архив из ${frames.length} кадров готов`, "ok");
    } catch (e) { toast("Ошибка при создании ZIP", "err"); }
    finally { setBusy(false); }
  });

  btnMd.addEventListener("click", () => {
    if (selected.size === 0) return;
    const frames = [...selected.values()].sort((a, b) => a.time - b.time);
    const items = frames.map((f) => ({ frame: f, palette: analyzePalette(f.paletteImageData, 20) }));
    const md = combinedMarkdown(items);
    downloadBlob(new Blob([md], { type: "text/markdown" }), `frames_palettes_${frames.length}.md`);
    toast(`MD по ${frames.length} кадрам сохранён`, "ok");
  });

  // -------------------- lightbox --------------------
  function openLightbox(frame) {
    lightboxImg.src = frame.previewUrl;
    lightboxCaption.textContent = frame.timecode;
    lightbox.hidden = false;
  }
  $("#lightbox-close").addEventListener("click", () => (lightbox.hidden = true));
  lightbox.addEventListener("click", (e) => { if (e.target === lightbox) lightbox.hidden = true; });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") lightbox.hidden = true; });

  // -------------------- card factory --------------------
  /**
   * opts: { selectable, badge, badgeCenter, label, onMedia, dense }
   * returns entry { el, setFrame(frame), checkbox, frame, selectable }
   */
  function makeCard(opts) {
    opts = opts || {};
    const el = document.createElement("div");
    el.className = "fcard";

    const media = document.createElement("div");
    media.className = "fcard__media is-loading";
    el.appendChild(media);

    let checkbox = null;
    if (opts.selectable) {
      const wrap = document.createElement("label");
      wrap.className = "fcheck";
      wrap.title = "Выбрать кадр";
      checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      const box = document.createElement("span");
      box.className = "fcheck__box";
      box.innerHTML = SVG.check;
      wrap.appendChild(checkbox);
      wrap.appendChild(box);
      media.appendChild(wrap);
    }

    if (opts.badge) {
      const b = document.createElement("div");
      b.className = "fcard__badge" + (opts.badgeCenter ? " fcard__badge--center" : "");
      b.textContent = opts.badge;
      media.appendChild(b);
    }

    const img = document.createElement("img");
    img.alt = "Кадр";
    img.style.opacity = "0";
    img.style.transition = "opacity .35s ease";
    media.appendChild(img);

    const timeTag = document.createElement("div");
    timeTag.className = "fcard__time";
    timeTag.textContent = "—";
    media.appendChild(timeTag);

    const foot = document.createElement("div");
    foot.className = "fcard__foot";
    const lbl = document.createElement("span");
    lbl.className = "fcard__label";
    lbl.textContent = opts.label || "";
    foot.appendChild(lbl);

    const btnFocus = iconBtn("green", SVG.focus, "Сужение — детально изучить момент");
    const btnDl = iconBtn("violet", SVG.download, "Скачать PNG");
    const btnClr = iconBtn("pink", '<span class="iconbtn__txt">clr</span>', "Скачать цветовую палитру");
    foot.appendChild(btnFocus);
    foot.appendChild(btnDl);
    foot.appendChild(btnClr);
    el.appendChild(foot);

    const entry = { el: el, checkbox: checkbox, frame: null, selectable: !!opts.selectable };

    entry.setFrame = function (frame) {
      entry.frame = frame;
      media.classList.remove("is-loading");
      img.src = frame.previewUrl;
      img.onload = () => (img.style.opacity = "1");
      timeTag.textContent = frame.timecode;
      el.classList.toggle("is-selected", isSelected(frame));
      if (checkbox) {
        checkbox.checked = isSelected(frame);
        checkbox.addEventListener("change", () => toggleSelect(frame));
      }
      media.addEventListener("click", (e) => {
        if (e.target.closest(".fcheck")) return;
        if (opts.onMedia) opts.onMedia(frame);
        else openLightbox(frame);
      });
      btnFocus.addEventListener("click", () => openFocus(frame.time));
      btnDl.addEventListener("click", () => downloadPng(frame));
      btnClr.addEventListener("click", () => downloadColors(frame));
    };

    return entry;
  }

  function iconBtn(color, inner, title) {
    const b = document.createElement("button");
    b.className = "iconbtn iconbtn--" + color;
    b.innerHTML = inner;
    b.title = title;
    b.type = "button";
    return b;
  }

  /*
   * FIX: убран мёртвый if/else — обе ветки делали одно и то же.
   * Теперь все записи в visibleCards независимо от selectable.
   */
  async function fillGrid(jobs, token) {
    for (const job of jobs) {
      if (token !== renderToken) return;
      try {
        const frame = await grabFrame(job.time, job.label);
        if (token !== renderToken) return;
        job.entry.setFrame(frame);
        visibleCards.push(job.entry);
        if (job.onFrame) job.onFrame(frame);
        updateToolbar();
      } catch (e) { /* skip frame */ }
    }
  }

  // -------------------- section header --------------------
  function sectionHead(title, chip) {
    const h = document.createElement("div");
    h.className = "section-head";
    const t = document.createElement("h2");
    t.textContent = title;
    h.appendChild(t);
    if (chip) {
      const c = document.createElement("span");
      c.className = "chip";
      c.textContent = chip;
      h.appendChild(c);
    }
    return h;
  }

  // ============================================================
  //  RENDERERS
  // ============================================================
  function beginRender(showToolbar) {
    renderToken++;
    visibleCards = [];
    controlsEl.innerHTML = "";
    contentEl.innerHTML = "";
    selToolbar.hidden = !showToolbar;
    if (showToolbar) updateToolbar();
    return renderToken;
  }

  // ---- 1. Segments ----
  function renderSegments() {
    const token = beginRender(true);

    // controls: segment count slider
    const panel = document.createElement("div");
    panel.className = "panel";
    const field = document.createElement("div");
    field.className = "field";
    field.innerHTML = `
      <div class="field__head">
        <span class="field__label">Количество сегментов</span>
        <span class="field__value" id="seg-val">${state.segmentCount}</span>
      </div>`;
    const slider = document.createElement("input");
    slider.type = "range"; slider.min = "2"; slider.max = "100"; slider.step = "1";
    slider.value = String(state.segmentCount);
    field.appendChild(slider);
    panel.appendChild(field);
    controlsEl.appendChild(panel);

    const valEl = field.querySelector("#seg-val");
    const apply = debounce(() => renderSegments(), 220);
    slider.addEventListener("input", () => {
      state.segmentCount = parseInt(slider.value, 10);
      valEl.textContent = state.segmentCount;
      apply();
    });

    // content
    contentEl.appendChild(sectionHead("Сегменты", `${state.segmentCount} · по 1 кадру из каждого`));
    const grid = document.createElement("div");
    grid.className = "grid";
    contentEl.appendChild(grid);

    const n = state.segmentCount;
    const segLen = state.duration / n;
    const jobs = [];
    for (let i = 0; i < n; i++) {
      const time = clamp(i * segLen + 0.001, 0, state.duration);
      const entry = makeCard({
        selectable: true,
        badge: `#${i + 1}`,
        label: `Сегмент ${i + 1} из ${n}`,
        onMedia: () => navTo({ type: "segmentDetail", seg: i }),
      });
      grid.appendChild(entry.el);
      jobs.push({ time, label: `Сегмент ${i + 1} из ${n}`, entry });
    }
    fillGrid(jobs, token);
  }

  // ---- 2. Segment detail (30 frames) ----
  function renderSegmentDetail(seg) {
    const token = beginRender(true);
    const n = state.segmentCount;
    const segLen = state.duration / n;
    const start = seg * segLen;
    const COUNT = 30;

    contentEl.appendChild(sectionHead(`Сегмент ${seg + 1} из ${n}`, `${COUNT} кадров`));
    const grid = document.createElement("div");
    grid.className = "grid grid--dense";
    contentEl.appendChild(grid);

    const jobs = [];
    for (let j = 0; j < COUNT; j++) {
      const time = clamp(start + (j / (COUNT - 1)) * segLen, 0, state.duration);
      const entry = makeCard({ selectable: true });
      grid.appendChild(entry.el);
      jobs.push({ time, entry });
    }
    fillGrid(jobs, token);
  }

  // ---- 3. Focus mode (11 frames) ----
  function renderFocus(centerTime) {
    const token = beginRender(true);
    centerTime = clamp(centerTime, 0, state.duration);

    contentEl.appendChild(sectionHead("Режим сужения", "±0.5 с · шаг 0.1 с"));

    // center hero
    const center = document.createElement("div");
    center.className = "focus-center";
    const hero = document.createElement("div");
    hero.className = "focus-hero";
    const heroMedia = document.createElement("div");
    heroMedia.className = "focus-hero__media is-loading";
    const heroCheck = document.createElement("label");
    heroCheck.className = "fcheck"; heroCheck.title = "Выбрать кадр";
    const heroCb = document.createElement("input"); heroCb.type = "checkbox";
    const heroBox = document.createElement("span"); heroBox.className = "fcheck__box"; heroBox.innerHTML = SVG.check;
    heroCheck.appendChild(heroCb); heroCheck.appendChild(heroBox);
    const heroBadge = document.createElement("div");
    heroBadge.className = "fcard__badge fcard__badge--center";
    heroBadge.textContent = "ЦЕНТР";
    const heroImg = document.createElement("img");
    heroImg.style.opacity = "0";
    heroImg.style.transition = "opacity .35s ease";
    heroMedia.appendChild(heroCheck); heroMedia.appendChild(heroBadge); heroMedia.appendChild(heroImg);
    hero.appendChild(heroMedia);
    center.appendChild(hero);

    const side = document.createElement("div");
    side.className = "focus-side";
    side.innerHTML = `<div class="focus-side__title">Центральный кадр</div>
      <div class="focus-side__time" id="focus-time">${fmtTime(centerTime)}</div>`;
    const actions = document.createElement("div");
    actions.className = "focus-side__actions";
    const aFocus = iconBtn("green", SVG.focus, "Сузить ещё");
    const aDl = iconBtn("violet", SVG.download, "Скачать PNG");
    const aClr = iconBtn("pink", '<span class="iconbtn__txt">clr</span>', "Скачать палитру");
    actions.appendChild(aFocus); actions.appendChild(aDl); actions.appendChild(aClr);
    side.appendChild(actions);
    center.appendChild(side);
    contentEl.appendChild(center);

    // divider + side grid
    const divider = document.createElement("div");
    divider.className = "focus-divider";
    divider.textContent = "Соседние кадры";
    contentEl.appendChild(divider);
    const grid = document.createElement("div");
    grid.className = "grid grid--dense";
    contentEl.appendChild(grid);

    // center entry (manual: center is selectable + has 3 actions)
    const centerEntry = { el: hero, checkbox: heroCb, frame: null, selectable: true };
    centerEntry.setFrame = function (frame) {
      centerEntry.frame = frame;
      heroMedia.classList.remove("is-loading");
      heroImg.src = frame.previewUrl;
      heroImg.onload = () => (heroImg.style.opacity = "1");
      heroCb.checked = isSelected(frame);
      hero.classList.toggle("is-selected", isSelected(frame));
      heroCb.addEventListener("change", () => toggleSelect(frame));
      heroMedia.addEventListener("click", (e) => { if (!e.target.closest(".fcheck")) openLightbox(frame); });
      aFocus.addEventListener("click", () => openFocus(frame.time));
      aDl.addEventListener("click", () => downloadPng(frame));
      aClr.addEventListener("click", () => downloadColors(frame));
    };

    const jobs = [{ time: centerTime, label: "Центр", entry: centerEntry }];
    for (let k = -5; k <= 5; k++) {
      if (k === 0) continue;
      const time = clamp(centerTime + k * 0.1, 0, state.duration);
      const entry = makeCard({ selectable: true });
      grid.appendChild(entry.el);
      jobs.push({ time, entry });
    }
    // ensure center fills first, then sides in time order
    fillGrid(jobs, token);
  }

  // ---- 4. Free mode ----
  function renderFree() {
    const token = beginRender(false);
    state.freeTime = clamp(state.freeTime, 0, state.duration);

    const panel = document.createElement("div");
    panel.className = "panel";
    const field = document.createElement("div");
    field.className = "field";
    field.innerHTML = `
      <div class="field__head">
        <span class="field__label">Позиция в видео</span>
        <span class="field__value">0 — ${fmtTime(state.duration)}</span>
      </div>`;
    const slider = document.createElement("input");
    slider.type = "range"; slider.min = "0"; slider.max = state.duration.toFixed(2);
    slider.step = "0.1"; slider.value = state.freeTime.toFixed(2);
    field.appendChild(slider);
    const tc = document.createElement("div");
    tc.className = "timecode";
    tc.innerHTML = `<span>${fmtTime(state.freeTime)}</span>`;
    panel.appendChild(field);
    panel.appendChild(tc);
    controlsEl.appendChild(panel);

    contentEl.appendChild(sectionHead("Свободный режим", "клик по кадру → диапазон"));
    const wrap = document.createElement("div");
    wrap.className = "focus-center";
    const hero = document.createElement("div");
    hero.className = "focus-hero";
    const heroMedia = document.createElement("div");
    heroMedia.className = "focus-hero__media is-loading";
    const heroImg = document.createElement("img");
    heroImg.style.opacity = "0";
    heroImg.style.transition = "opacity .35s ease";
    heroMedia.appendChild(heroImg);
    hero.appendChild(heroMedia);
    wrap.appendChild(hero);

    const side = document.createElement("div");
    side.className = "focus-side";
    side.innerHTML = `<div class="focus-side__title">Текущий кадр</div>
      <div class="focus-side__time" id="free-time">${fmtTime(state.freeTime)}</div>`;
    const actions = document.createElement("div");
    actions.className = "focus-side__actions";
    const aFocus = iconBtn("green", SVG.focus, "Сужение");
    const aDl = iconBtn("violet", SVG.download, "Скачать PNG");
    const aClr = iconBtn("pink", '<span class="iconbtn__txt">clr</span>', "Скачать палитру");
    actions.appendChild(aFocus); actions.appendChild(aDl); actions.appendChild(aClr);
    side.appendChild(actions);
    const hint = document.createElement("div");
    hint.className = "panel__sub";
    hint.textContent = "Кликните по кадру, чтобы открыть просмотр диапазона.";
    side.appendChild(hint);
    wrap.appendChild(side);
    contentEl.appendChild(wrap);

    let currentFrame = null;
    async function updateCenter() {
      const myToken = renderToken;
      heroMedia.classList.add("is-loading");
      const frame = await grabFrame(state.freeTime, "Свободный кадр");
      if (myToken !== renderToken) return;
      currentFrame = frame;
      heroMedia.classList.remove("is-loading");
      heroImg.src = frame.previewUrl;
      heroImg.onload = () => (heroImg.style.opacity = "1");
    }
    updateCenter();

    const apply = debounce(updateCenter, 160);
    slider.addEventListener("input", () => {
      state.freeTime = parseFloat(slider.value);
      tc.innerHTML = `<span>${fmtTime(state.freeTime)}</span>`;
      side.querySelector("#free-time").textContent = fmtTime(state.freeTime);
      apply();
    });

    heroMedia.addEventListener("click", () => {
      const start = state.freeTime;
      const end = clamp(start + 2, start + 0.5, state.duration);
      navTo({ type: "rangeDetail", start: start, end: end });
    });
    aFocus.addEventListener("click", () => openFocus(state.freeTime));
    aDl.addEventListener("click", () => { if (currentFrame) downloadPng(currentFrame); });
    aClr.addEventListener("click", () => { if (currentFrame) downloadColors(currentFrame); });
  }

  // ---- 5. Range detail (up to 60 frames) ----
  /*
   * FIXES applied:
   *  1. rangeField() now accepts `maxVal` so slider.max is set BEFORE slider.value —
   *     this prevents the browser from clamping the value to 100 for videos > 100 s.
   *  2. The two fields are wrapped in a panel__row div for correct side-by-side layout.
   *  3. Redundant Math.max() on end value removed (already enforced by clamp/slider logic).
   */
  function renderRangeDetail(rangeStart, rangeEnd) {
    const token = beginRender(true);
    let start = clamp(rangeStart, 0, state.duration);
    let end = clamp(rangeEnd, start + 0.5, state.duration);
    if (end - start < 0.5) end = clamp(start + 0.5, 0, state.duration);

    // controls
    const panel = document.createElement("div");
    panel.className = "panel";

    /*
     * FIX 1: pass state.duration as maxVal so slider.max is correct from
     * the start — the browser otherwise clamps value to the default max of 100.
     */
    const fStart = rangeField("Начало", start, "range--green", state.duration);
    const fEnd   = rangeField("Конец",  end,   "range--pink",  state.duration);

    /* FIX 2: wrap the two fields in a flex row */
    const fieldsRow = document.createElement("div");
    fieldsRow.className = "panel__row";
    fieldsRow.appendChild(fStart.field);
    fieldsRow.appendChild(fEnd.field);
    panel.appendChild(fieldsRow);

    const row = document.createElement("div");
    row.className = "panel__row";
    const updateBtn = document.createElement("button");
    updateBtn.className = "btn btn--violet btn--sm";
    updateBtn.textContent = "Обновить кадры";
    const info = document.createElement("span");
    info.className = "panel__sub";
    row.appendChild(updateBtn);
    row.appendChild(info);
    panel.appendChild(row);
    controlsEl.appendChild(panel);

    function frameCountFor(a, b) { return clamp(Math.floor((b - a) / 0.1) + 1, 2, 60); }

    function refreshInfo() {
      const a = parseFloat(fStart.slider.value);
      const b = parseFloat(fEnd.slider.value);
      info.textContent = `Диапазон ${(b - a).toFixed(1)} с · ${frameCountFor(a, Math.max(b, a + 0.5))} кадров`;
    }
    fStart.slider.addEventListener("input", () => {
      let a = parseFloat(fStart.slider.value);
      let b = parseFloat(fEnd.slider.value);
      if (b - a < 0.5) {
        b = clamp(a + 0.5, 0, state.duration);
        fEnd.slider.value = b.toFixed(2);
        fEnd.val.textContent = fmtTime(b);
      }
      fStart.val.textContent = fmtTime(a);
      refreshInfo();
    });
    fEnd.slider.addEventListener("input", () => {
      let a = parseFloat(fStart.slider.value);
      let b = parseFloat(fEnd.slider.value);
      if (b - a < 0.5) {
        a = clamp(b - 0.5, 0, state.duration);
        fStart.slider.value = a.toFixed(2);
        fStart.val.textContent = fmtTime(a);
      }
      fEnd.val.textContent = fmtTime(b);
      refreshInfo();
    });
    refreshInfo();

    // content
    contentEl.appendChild(sectionHead("Просмотр диапазона", ""));
    const grid = document.createElement("div");
    grid.className = "grid grid--dense";
    contentEl.appendChild(grid);

    function build(a, b) {
      renderToken++; // cancel previous fill within this view
      const myToken = renderToken;
      visibleCards = [];
      grid.innerHTML = "";
      const count = frameCountFor(a, b);
      const step = count > 1 ? (b - a) / (count - 1) : 0;
      const jobs = [];
      for (let i = 0; i < count; i++) {
        const time = clamp(a + i * step, 0, state.duration);
        const entry = makeCard({ selectable: true });
        grid.appendChild(entry.el);
        jobs.push({ time, entry });
      }
      // update head chip
      const headEl = contentEl.querySelector(".section-head");
      let chip = headEl.querySelector(".chip");
      if (!chip) {
        chip = document.createElement("span");
        chip.className = "chip";
        headEl.appendChild(chip);
      }
      chip.textContent = `${count} кадров · ${fmtTime(a)} – ${fmtTime(b)}`;
      fillGrid(jobs, myToken);
    }

    updateBtn.addEventListener("click", () => {
      const a = parseFloat(fStart.slider.value);
      const b = Math.max(parseFloat(fEnd.slider.value), a + 0.5);
      build(a, b);
    });

    build(start, end);
  }

  /*
   * FIX: added `maxVal` parameter — slider.max is set BEFORE slider.value
   * so the browser never clamps value when the video is longer than 100 seconds.
   */
  function rangeField(label, value, cls, maxVal) {
    const field = document.createElement("div");
    field.className = "field";
    const head = document.createElement("div");
    head.className = "field__head";
    head.innerHTML = `<span class="field__label">${label}</span>`;
    const val = document.createElement("span");
    val.className = "field__value";
    val.textContent = fmtTime(value);
    head.appendChild(val);
    field.appendChild(head);
    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "0";
    // FIX: set max BEFORE value to avoid browser clamping
    slider.max = (maxVal != null ? maxVal : 100).toFixed(2);
    slider.step = "0.1";
    slider.value = value.toFixed(2);
    if (cls) slider.classList.add(cls);
    field.appendChild(slider);
    return { field, slider, val };
  }

  // ============================================================
  //  NAVIGATION
  // ============================================================
  function renderState(s) {
    if (s.type === "segments") renderSegments();
    else if (s.type === "segmentDetail") renderSegmentDetail(s.seg);
    else if (s.type === "focus") renderFocus(s.time);
    else if (s.type === "free") renderFree();
    else if (s.type === "rangeDetail") renderRangeDetail(s.start, s.end);
    updateModeButtons(s.type);
    btnBack.hidden = state.history.length <= 1;
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // navTo: push onto history
  function navTo(s) {
    state.history.push(s);
    renderState(s);
  }
  // resetTo: top-level nav (clears history)
  function resetTo(s) {
    state.history = [s];
    renderState(s);
  }
  function goBack() {
    if (state.history.length <= 1) return;
    state.history.pop();
    renderState(state.history[state.history.length - 1]);
  }
  btnBack.addEventListener("click", goBack);

  function updateModeButtons(type) {
    const segActive = (type === "segments" || type === "segmentDetail");
    const freeActive = (type === "free" || type === "rangeDetail");
    $("#nav-segments").classList.toggle("is-active", segActive);
    $("#nav-free").classList.toggle("is-active", freeActive);
  }
  $("#nav-segments").addEventListener("click", () => resetTo({ type: "segments" }));
  $("#nav-free").addEventListener("click", () => resetTo({ type: "free" }));

  // ============================================================
  //  VIDEO LOADING
  // ============================================================
  /*
   * FIX: added explicit parentheses around the OR-condition for clarity
   * and correctness — the intent is to accept files that are EITHER
   * recognised by MIME type OR by file extension.
   */
  function loadVideoFile(file) {
    if (!file || (!file.type.startsWith("video/") && !/\.(mp4|webm|mov|avi|mkv|m4v|ogg)$/i.test(file.name))) {
      toast("Пожалуйста, выберите видеофайл", "err");
      return;
    }
    setBusy(true, "Загрузка видео…");
    const url = URL.createObjectURL(file);
    if (video._url) URL.revokeObjectURL(video._url);
    video._url = url;
    video.src = url;

    const onMeta = () => {
      video.removeEventListener("loadedmetadata", onMeta);
      video.removeEventListener("error", onErr);
      if (!isFinite(video.duration) || video.duration <= 0) {
        // some containers need a nudge to expose duration
        video.currentTime = 1e6;
        const fix = () => {
          video.removeEventListener("seeked", fix);
          video.currentTime = 0;
          finishLoad(file);
        };
        video.addEventListener("seeked", fix);
        return;
      }
      finishLoad(file);
    };
    const onErr = () => {
      video.removeEventListener("loadedmetadata", onMeta);
      video.removeEventListener("error", onErr);
      setBusy(false);
      toast("Этот формат не поддерживается браузером. Попробуйте MP4 или WebM.", "err");
    };
    video.addEventListener("loadedmetadata", onMeta);
    video.addEventListener("error", onErr);
  }

  function finishLoad(file) {
    state.duration = video.duration;
    state.fileName = file.name;
    state.freeTime = 0;
    state.segmentCount = 5;
    selected.clear();
    frameCache.clear();
    seekChain = Promise.resolve();

    $("#info-name").textContent = file.name;
    $("#info-name").title = file.name;
    $("#info-duration").textContent = fmtTime(state.duration);
    $("#info-size").textContent = (file.size / 1048576).toFixed(1) + " МБ";

    screenUpload.classList.remove("screen--active");
    screenApp.classList.add("screen--active");
    setBusy(false);
    resetTo({ type: "segments" });
    toast("Видео загружено", "ok");
  }

  // -------------------- upload wiring --------------------
  dropzone.addEventListener("click", () => fileInput.click());
  dropzone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); }
  });
  fileInput.addEventListener("change", () => {
    if (fileInput.files && fileInput.files[0]) loadVideoFile(fileInput.files[0]);
  });

  ["dragenter", "dragover"].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add("dropzone--drag"); })
  );
  ["dragleave", "drop"].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove("dropzone--drag"); })
  );
  dropzone.addEventListener("drop", (e) => {
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) loadVideoFile(f);
  });
  // prevent the browser from opening a dropped file in a new tab
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => e.preventDefault());

  $("#btn-change-file").addEventListener("click", () => {
    screenApp.classList.remove("screen--active");
    screenUpload.classList.add("screen--active");
    fileInput.value = "";
    window.scrollTo({ top: 0 });
  });
})();
