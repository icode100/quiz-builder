/* Question overlays are independent of responses, rough work and submissions. */
(() => {
  "use strict";
  const stateStorage = () => window.QuizCloudSync?.storage || localStorage;

  function create({ quizId, questions }) {
    const byId = id => document.getElementById(id), engine = window.RoughWorkEngine;
    const toggle = byId("screen-annotation-toggle"), toolbar = byId("screen-annotation-toolbar");
    if (!toggle || !toolbar) return null;
    const status = byId("annotation-status"), pages = new Map(), known = new Map(), hydration = new Map();
    const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
    for (const question of questions) {
      const names = new Set();
      if (question.text?.trim()) names.add("text");
      const count = (question.image ? 1 : 0) + (question.images || []).length;
      for (let index = 0; index < count; index++) names.add(`image-${index}`);
      known.set(question.id, names);
    }
    const theme = () => document.documentElement.dataset.theme === "dark" ? "dark" : "light";
    const key = id => `practice-quiz:${quizId}:annotation:${encodeURIComponent(id)}`;
    const widths = { pen: 4, highlighter: 16, eraser: 16 };
    const colors = { pen: "#4169e1", highlighter: "#f59e0b", eraser: "#4169e1" };
    const records = new WeakMap();
    let surfaces = [], currentId = null, currentLabel = "", active = null, editing = false, tool = "pen", frame = null;
    let unavailable = !engine?.draw || !engine?.validateStrokes || !engine?.inkColor;
    let toolbarPosition = null, dragging = null;
    const observer = window.ResizeObserver ? new window.ResizeObserver(() => schedule()) : null;
    const loadingState = id => hydration.get(id)?.cloud === window.QuizCloudSync ? hydration.get(id) : null;
    const editable = id => !window.QuizCloudSync?.ensureKeys || Boolean(loadingState(id)?.ready);

    function reloadPage(id) {
      const previous = pages.get(id);
      try { if (previous && !previous.loadFailed && previous.sourceText === stateStorage().getItem(key(id))) return previous; } catch { /* read() reports a protected failure. */ }
      pages.delete(id);
      const restored = read(id);
      if (restored.loadFailed && previous) {
        previous.warning = restored.warning;
        previous.loadFailed = true;
        pages.set(id, previous);
        return previous;
      }
      return restored;
    }
    function ensurePage(id, retry = false) {
      const cloud = window.QuizCloudSync;
      if (!id || !known.has(id) || typeof cloud?.ensureKeys !== "function") return;
      read(id);
      const previous = loadingState(id);
      if (active?.record.id === id || previous?.loading || previous?.ready && !previous.error || previous?.error && !retry) return previous?.promise;
      if (cloud.isHydrated?.(key(id))) {
        const restored = reloadPage(id);
        hydration.set(id, { cloud, ready: !restored.loadFailed, loading: false, error: restored.loadFailed ? restored.warning : "" });
        return;
      }
      const cached = pages.get(id);
      const load = { cloud, ready: Boolean(cached?.saved && !cached.loadFailed), loading: true, error: "", remoteApplied: false, promise: null };
      hydration.set(id, load);
      let request;
      try { request = cloud.ensureKeys([key(id)]); } catch (error) { request = Promise.reject(error); }
      load.promise = Promise.resolve(request).then(() => {
        if (window.QuizCloudSync !== cloud || hydration.get(id) !== load) return;
        const restored = load.remoteApplied ? pages.get(id) : reloadPage(id);
        load.loading = false; load.ready = Boolean(restored && !restored.loadFailed);
        load.error = load.ready ? "" : restored?.warning || "Could not load account annotations. Close and reopen Screen annotation to retry.";
        controls(); schedule();
      }).catch(() => {
        if (window.QuizCloudSync !== cloud || hydration.get(id) !== load) return;
        const cached = pages.get(id);
        load.loading = false; load.ready = Boolean(cached?.saved && !cached.loadFailed);
        load.error = load.ready ? "Could not refresh account annotations. Using saved marks; edits will queue for sync." : "Could not load account annotations. Close and reopen Screen annotation to retry. Saved marks are unchanged.";
        if (currentId === id) controls();
      });
      return load.promise;
    }

    function checkedParts(value, id) {
      if (!object(value) || Object.keys(value).some(name => !known.get(id)?.has(name))) throw new Error("Invalid annotation parts.");
      const parts = Object.create(null);
      let count = 0, points = 0;
      for (const [name, strokes] of Object.entries(value)) {
        parts[name] = engine.validateStrokes(strokes, engine.annotationWidths);
        count += parts[name].length;
        for (const stroke of parts[name]) points += stroke.points.length;
      }
      if (count > engine.limits.strokes || points > engine.limits.totalPoints) throw new Error("Annotation limit exceeded.");
      return parts;
    }
    function read(id) {
      if (pages.has(id)) return pages.get(id);
      const result = { parts: Object.create(null), undo: [], redo: [], dirty: false, saved: false, loadFailed: false, warning: "", notice: "", sourceText: null };
      try {
        const raw = stateStorage().getItem(key(id));
        result.sourceText = raw;
        if (raw !== null) {
          if (raw.length > 3 * 1024 * 1024) throw new Error("Annotation too large.");
          const saved = JSON.parse(raw), fields = ["version", "quizId", "questionId", "updatedAt", "parts"];
          if (!object(saved) || Object.keys(saved).length !== fields.length || fields.some(name => !Object.hasOwn(saved, name)) ||
              saved.version !== 1 || saved.quizId !== quizId || saved.questionId !== id || typeof saved.updatedAt !== "string" ||
              !Number.isFinite(Date.parse(saved.updatedAt))) throw new Error("Invalid annotation identity.");
          result.parts = checkedParts(saved.parts, id);
          result.saved = true;
        }
      } catch {
        result.loadFailed = true;
        result.warning = window.QuizCloudSync ? "Could not load account annotations. Keep this tab open; reload to try again." : "Could not load saved annotations. Keep this tab open; reload to try again.";
      }
      pages.set(id, result);
      return result;
    }
    function persist(id) {
      const page = pages.get(id);
      if (!page?.dirty || page.loadFailed || !editable(id)) return;
      try {
        const parts = checkedParts(page.parts, id);
        const raw = JSON.stringify({ version: 1, quizId, questionId: id, updatedAt: new Date().toISOString(), parts });
        if (raw.length > 3 * 1024 * 1024) throw new Error("Annotation too large.");
        stateStorage().setItem(key(id), raw);
        page.sourceText = raw;
        page.dirty = false; page.saved = true; page.warning = "";
      } catch { page.warning = window.QuizCloudSync ? "Could not queue annotations for account sync. Keep this tab open to retain your marks." : "Could not save annotations. Keep this tab open to retain your marks."; }
    }
    function controls() {
      const page = pages.get(currentId), focused = document.activeElement;
      const load = loadingState(currentId), blocked = !editable(currentId);
      toggle.hidden = false;
      toggle.disabled = unavailable;
      toggle.setAttribute("aria-pressed", String(editing));
      toggle.setAttribute("aria-expanded", String(editing));
      toggle.title = unavailable ? "Screen annotation is unavailable in this browser" : editing ? "Finish screen annotation" : "Annotate this question";
      toolbar.hidden = !editing;
      document.documentElement.classList.toggle("screen-annotation-active", editing);
      byId("annotation-question-label").textContent = currentLabel ? `Question ${currentLabel}` : "Question annotation";
      for (const name of ["pen", "highlighter", "eraser"]) { byId(`annotation-tool-${name}`).setAttribute("aria-pressed", String(name === tool)); byId(`annotation-tool-${name}`).disabled = unavailable || blocked; }
      byId("annotation-color").value = colors[tool];
      byId("annotation-color").disabled = unavailable || blocked || tool === "eraser";
      const neutral = byId("annotation-color").querySelector('option[value="#17233b"]');
      if (neutral) neutral.textContent = theme() === "dark" ? "White" : "Black";
      byId("annotation-width").value = String(widths[tool]);
      byId("annotation-width").disabled = unavailable || blocked;
      byId("annotation-undo").disabled = blocked || !page?.undo.length;
      byId("annotation-redo").disabled = blocked || !page?.redo.length;
      byId("annotation-clear").disabled = blocked || !page || !Object.values(page.parts).some(strokes => strokes.length);
      if (editing && focused?.disabled && ["annotation-undo", "annotation-redo", "annotation-clear"].includes(focused.id)) byId("annotation-tool-pen").focus({ preventScroll: true });
      const autosaveMessage = window.QuizCloudSync ? "Autosave on · Account sync status above" : page?.saved ? "Saved in this browser" : "Draw on the question. Done returns to answering. Marks save automatically.";
      status.textContent = unavailable ? "Screen annotation is unavailable in this browser." : load?.loading ? "Loading question annotations…" : load?.error || page?.notice || page?.warning || autosaveMessage;
      status.classList.toggle("error", Boolean(unavailable || load?.error || page?.notice || page?.warning));
      for (const record of surfaces) {
        record.canvas.tabIndex = editing && editable(record.id) ? 0 : -1;
        record.canvas.setAttribute("aria-busy", String(Boolean(loadingState(record.id)?.loading)));
        record.canvas.setAttribute("aria-disabled", String(!editable(record.id)));
        record.canvas.setAttribute("aria-label", `Annotate question ${record.id}`);
        updateCursor(record);
      }
    }
    function updateCursor(record) {
      if (!engine || !editing) return;
      if (!editable(record.id)) { record.canvas.style.cursor = loadingState(record.id)?.loading ? "progress" : "not-allowed"; return; }
      const width = record.host.getBoundingClientRect().width;
      if (!(width > 0)) return;
      const radius = (widths[tool] <= 2 ? 4 : widths[tool]) * width / engine.paper.width / 2;
      const outline = theme() === "dark" ? "#111827" : "white";
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><circle cx="16" cy="16" r="${radius + 1}" fill="${outline}"/><circle cx="16" cy="16" r="${radius}" fill="${engine.inkColor(colors[tool], theme())}"/></svg>`;
      record.canvas.style.cursor = `url("data:image/svg+xml,${encodeURIComponent(svg)}") 16 16, default`;
    }
    function draw() {
      frame = null;
      if (unavailable) return;
      for (const record of surfaces) {
        const rect = record.host.getBoundingClientRect();
        const visible = !record.host.closest("[hidden]") && Number.isFinite(rect.width) && Number.isFinite(rect.height) && rect.width > 0 && rect.height > 0 &&
          rect.bottom >= -400 && rect.top <= (window.innerHeight || 1000) + 400;
        if (!visible) {
          if (record.canvas.width !== 1 || record.canvas.height !== 1) { record.canvas.width = 1; record.canvas.height = 1; }
          continue;
        }
        ensurePage(record.id);
        const scale = Math.min(2, window.devicePixelRatio || 1, Math.sqrt(engine.limits.canvasPixels / (rect.width * rect.height)));
        const width = Math.max(1, Math.min(engine.limits.canvasPixels, Math.floor(rect.width * scale)));
        const height = Math.max(1, Math.min(Math.floor(engine.limits.canvasPixels / width), Math.floor(rect.height * scale)));
        if (record.canvas.width !== width || record.canvas.height !== height) {
          if (width > record.canvas.width) { record.canvas.height = height; record.canvas.width = width; }
          else { record.canvas.width = width; record.canvas.height = height; }
        }
        const page = read(record.id), strokes = page.parts[record.part] || [];
        engine.draw(record.context, active?.record === record ? [...strokes, active.stroke] : strokes, width, height, theme(), engine.annotationWidths);
        updateCursor(record);
      }
      controls();
    }
    function schedule() {
      if (frame !== null || unavailable) return;
      if (window.requestAnimationFrame) frame = window.requestAnimationFrame(draw);
      else draw();
    }
    function remember(id, action) {
      const page = read(id);
      page.undo.push(action);
      if (page.undo.length > 50) page.undo.shift();
      page.redo = []; page.dirty = true; page.notice = "";
      persist(id); controls(); schedule();
    }
    function point(record, event) {
      const rect = record.host.getBoundingClientRect();
      if (!(rect.width > 0 && rect.height > 0)) return null;
      return [event.clientX - rect.left, event.clientY - rect.top].map((value, index) =>
        Math.round(Math.max(0, Math.min(1, value / (index ? rect.height : rect.width))) * 10000) / 10000);
    }
    function finish() {
      if (!active) return;
      const drawing = active;
      active = null;
      try { drawing.record.canvas.releasePointerCapture?.(drawing.pointerId); } catch { /* Capture may already be released. */ }
      const { id, part } = drawing.record, page = read(id);
      (page.parts[part] ||= []).push(drawing.stroke);
      remember(id, { kind: "add", part, stroke: drawing.stroke });
      window.QuizCloudSync?.endEdit(key(id));
    }
    function flush() {
      finish();
      for (const [id, page] of pages) if (page.dirty) persist(id);
      controls();
    }
    function setCurrent(id, label = id) {
      if (!known.has(id)) return false;
      const changed = currentId !== id;
      if (changed) finish();
      currentId = id; currentLabel = label;
      if (changed || !loadingState(id)) ensurePage(id, changed);
      controls(); schedule();
      return true;
    }
    function setEditing(value, focus = true) {
      finish();
      editing = Boolean(value && !unavailable);
      if (!editing) endDrag();
      if (editing && currentId) { read(currentId); ensurePage(currentId, true); }
      controls(); schedule();
      if (editing && toolbarPosition) placeToolbar(toolbarPosition.left, toolbarPosition.top);
      if (focus) (editing ? byId("annotation-tool-pen") : toggle).focus({ preventScroll: true });
    }
    function placeToolbar(left, top) {
      const rect = toolbar.getBoundingClientRect();
      const width = document.documentElement.clientWidth || window.innerWidth || 1000;
      const height = document.documentElement.clientHeight || window.innerHeight || 800;
      toolbarPosition = {
        left: Math.max(8, Math.min(Math.max(8, width - rect.width - 8), left)),
        top: Math.max(8, Math.min(Math.max(8, height - rect.height - 8), top))
      };
      toolbar.style.left = `${toolbarPosition.left}px`;
      toolbar.style.top = `${toolbarPosition.top}px`;
      toolbar.style.right = "auto";
      toolbar.style.bottom = "auto";
    }
    function undo() {
      if (!editable(currentId)) return;
      finish();
      const page = pages.get(currentId), action = page?.undo.pop();
      if (!action) return;
      if (action.kind === "add") page.parts[action.part].pop();
      else page.parts = action.parts;
      page.redo.push(action); page.dirty = true; page.notice = "";
      persist(currentId); controls(); schedule();
    }
    function redo() {
      if (!editable(currentId)) return;
      finish();
      const page = pages.get(currentId), action = page?.redo.pop();
      if (!action) return;
      if (action.kind === "add") (page.parts[action.part] ||= []).push(action.stroke);
      else page.parts = Object.create(null);
      page.undo.push(action); page.dirty = true; page.notice = "";
      persist(currentId); controls(); schedule();
    }
    function attach(host, id, part) {
      const canvas = document.createElement("canvas");
      canvas.className = "question-annotation-canvas";
      canvas.width = 1; canvas.height = 1;
      let context;
      try { context = canvas.getContext("2d", { alpha: true }); } catch { /* Quiz stays usable. */ }
      if (!context) { unavailable = true; setEditing(false, false); return null; }
      const record = { host, id, part, canvas, context };
      canvas.addEventListener("click", event => {
        if (editing) { event.preventDefault(); event.stopPropagation(); }
      });
      canvas.addEventListener("pointerdown", event => {
        if (!editing || active || event.button !== 0) return;
        setCurrent(id);
        if (!editable(id)) { event.preventDefault(); return; }
        const page = read(id), first = point(record, event);
        const all = Object.values(page.parts).flat(), count = all.reduce((sum, stroke) => sum + stroke.points.length, 0);
        if (!first) return;
        event.preventDefault();
        if (all.length >= engine.limits.strokes || count >= engine.limits.totalPoints) {
          page.notice = "This question's annotations are full. Undo or clear marks to keep drawing.";
          controls(); return;
        }
        canvas.focus({ preventScroll: true });
        window.QuizCloudSync?.beginEdit(key(id));
        active = { pointerId: event.pointerId, record, count, stroke: { tool, color: colors[tool], width: widths[tool], points: [first] } };
        try { canvas.setPointerCapture?.(event.pointerId); } catch { /* Drawing remains possible inside the image. */ }
        schedule();
      });
      function move(event) {
        if (!active || active.record !== record || active.pointerId !== event.pointerId) return;
        const next = point(record, event), points = active.stroke.points, last = points[points.length - 1];
        const rect = host.getBoundingClientRect();
        if (!next || Math.hypot((next[0] - last[0]) * rect.width, (next[1] - last[1]) * rect.height) < 1) return;
        if (points.length >= engine.limits.pointsPerStroke || active.count + points.length >= engine.limits.totalPoints) {
          finish(); read(id).notice = "Stroke limit reached. Lift the pen before continuing."; controls(); return;
        }
        points.push(next); schedule();
      }
      canvas.addEventListener("pointermove", move);
      canvas.addEventListener("pointerup", event => { if (active?.record === record && active.pointerId === event.pointerId) { move(event); finish(); } });
      for (const name of ["pointercancel", "lostpointercapture"]) canvas.addEventListener(name, event => { if (active?.record === record && active.pointerId === event.pointerId) finish(); });
      canvas.addEventListener("pointerenter", schedule);
      host.querySelector("img")?.addEventListener("load", schedule);
      host.append(canvas);
      records.set(host, record);
      return record;
    }
    function refresh() {
      finish(); observer?.disconnect(); surfaces = [];
      for (const region of document.querySelectorAll("[data-annotation-question]")) {
        const id = region.dataset.annotationQuestion;
        if (!known.has(id)) continue;
        for (const host of region.querySelectorAll("[data-annotation-part]")) {
          const part = host.dataset.annotationPart;
          if (!known.get(id).has(part)) continue;
          const record = records.get(host) || (!unavailable && attach(host, id, part));
          if (!record) continue;
          surfaces.push(record); observer?.observe(host);
        }
      }
      controls(); schedule();
    }
    toggle.addEventListener("click", () => setEditing(!editing));
    byId("annotation-done").addEventListener("click", () => setEditing(false));
    for (const name of ["pen", "highlighter", "eraser"]) byId(`annotation-tool-${name}`).addEventListener("click", () => { finish(); tool = name; controls(); });
    byId("annotation-color").addEventListener("change", event => { finish(); if (engine?.colors.includes(event.target.value)) colors[tool] = event.target.value; controls(); });
    byId("annotation-width").addEventListener("change", event => { finish(); const width = Number(event.target.value); if ((engine?.annotationWidths || engine?.widths)?.includes(width)) widths[tool] = width; controls(); });
    byId("annotation-undo").addEventListener("click", undo);
    byId("annotation-redo").addEventListener("click", redo);
    byId("annotation-clear").addEventListener("click", () => {
      if (!editable(currentId)) return;
      finish();
      const page = pages.get(currentId);
      if (!page || !Object.values(page.parts).some(strokes => strokes.length)) return;
      const parts = page.parts; page.parts = Object.create(null);
      remember(currentId, { kind: "clear", parts });
    });
    const heading = byId("annotation-title");
    heading?.addEventListener("pointerdown", event => {
      if (!editing || dragging || event.button !== 0) return;
      const rect = toolbar.getBoundingClientRect();
      event.preventDefault();
      heading.focus({ preventScroll: true });
      dragging = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
      try { heading.setPointerCapture?.(event.pointerId); } catch { /* Dragging still works over the heading. */ }
    });
    heading?.addEventListener("pointermove", event => {
      if (dragging?.pointerId !== event.pointerId) return;
      event.preventDefault();
      placeToolbar(dragging.left + event.clientX - dragging.x, dragging.top + event.clientY - dragging.y);
    });
    function endDrag(event) {
      if (!dragging || (event && dragging.pointerId !== event.pointerId)) return;
      const pointerId = dragging.pointerId;
      dragging = null;
      try { heading.releasePointerCapture?.(pointerId); } catch { /* Capture may already be released. */ }
    }
    for (const name of ["pointerup", "pointercancel", "lostpointercapture"]) heading?.addEventListener(name, endDrag);
    heading?.addEventListener("keydown", event => {
      if (!editing || event.ctrlKey || event.metaKey || event.altKey || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
      const rect = toolbar.getBoundingClientRect(), step = event.shiftKey ? 30 : 10;
      event.preventDefault();
      placeToolbar(rect.left + (event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0),
        rect.top + (event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0));
    });
    document.addEventListener("keydown", event => {
      if (!editing || !event.target.closest?.("#screen-annotation-toolbar, .question-annotation-canvas")) return;
      if (event.key === "Escape") { event.preventDefault(); setEditing(false); return; }
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.target.closest("input, select, textarea, [contenteditable]")) return;
      const key = event.key.toLowerCase();
      if (key === "z" || key === "y") { event.preventDefault(); if (key === "y" || event.shiftKey) redo(); else undo(); }
    });
    window.addEventListener("resize", () => {
      if (editing && toolbarPosition) placeToolbar(toolbarPosition.left, toolbarPosition.top);
      schedule();
    });
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", flush);
    window.addEventListener("blur", () => { if (active) finish(); endDrag(); });
    document.addEventListener("visibilitychange", () => { if (document.hidden) flush(); });
    if (window.MutationObserver) new window.MutationObserver(() => { controls(); schedule(); }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    else {
      const later = () => { if (window.requestAnimationFrame) window.requestAnimationFrame(() => { controls(); schedule(); }); else Promise.resolve().then(() => { controls(); schedule(); }); };
      byId("theme-toggle")?.addEventListener("click", later);
      window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener("change", later);
    }
    window.addEventListener("quiz-cloud-record", event => {
      const changed = event.detail?.key;
      for (const id of known.keys()) if (changed === key(id)) {
        if (active?.record.id === id) return;
        const load = loadingState(id), restored = reloadPage(id);
        if (load?.loading) load.remoteApplied = true;
        else if (load && !restored.loadFailed) { load.ready = true; load.error = ""; }
        controls(); schedule(); break;
      }
    });
    window.addEventListener("online", () => { if (currentId) { ensurePage(currentId, true); controls(); schedule(); } });
    controls();
    return { refresh, setCurrent, flush, isDrawing: () => Boolean(active) };
  }
  window.QuestionAnnotation = { create };
})();
