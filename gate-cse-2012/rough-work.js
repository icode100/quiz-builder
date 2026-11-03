(() => {
  "use strict";

  function create({ quizId, questions }) {
    const byId = id => document.getElementById(id), engine = window.RoughWorkEngine;
    const canvas = byId("rough-work-canvas"), panel = byId("rough-work-panel"), surface = byId("rough-work-surface");
    if (!canvas || !panel || !surface) return null;
    const status = byId("rough-work-status"), tools = ["pen", "highlighter", "eraser"];
    const inkCanvas = document.createElement("canvas");
    inkCanvas.width = canvas.width;
    inkCanvas.height = canvas.height;
    let context, inkContext;
    try { context = canvas.getContext("2d"); inkContext = inkCanvas.getContext("2d", { alpha: true }); } catch { /* Other quiz controls remain usable. */ }
    if (!engine || !engine.drawPaper || !engine.inkColor || !context || !inkContext) {
      status.textContent = "Drawing is unavailable in this browser. You can still use your screen annotation tool.";
      status.classList.toggle("error", true);
      panel.querySelectorAll(".rough-work-tools button, .rough-work-tools select").forEach(control => { control.disabled = true; });
      return { show() {}, hide() {} };
    }
    const paperStyles = engine.paperStyles, defaultPaper = "dotted";
    const ids = new Set(questions.map(question => question.id)), pages = new Map();
    const widths = { pen: 4, highlighter: 16, eraser: 16 };
    const colors = { pen: "#17233b", highlighter: "#f59e0b", eraser: "#17233b" };
    let currentId = null, tool = "pen", active = null, opened = false, frame = null;
    const storageKey = id => `practice-quiz:${quizId}:rough:${encodeURIComponent(id)}`;
    const page = () => pages.get(currentId);
    const theme = () => document.documentElement.dataset.theme === "dark" ? "dark" : "light";

    function fitPaper() {
      const current = page();
      if (!opened || !current) return false;
      const width = surface.clientWidth, height = surface.clientHeight;
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return false;
      const pageHeight = Math.max(current.pageHeight, Math.min(engine.limits.paperHeight, Math.ceil(height * engine.paper.width / width)));
      let changed = false;
      if (pageHeight > current.pageHeight) {
        const ratio = current.pageHeight / pageHeight, visited = new Set();
        const rebase = strokes => strokes.forEach(stroke => {
          if (visited.has(stroke)) return;
          visited.add(stroke);
          stroke.points.forEach(point => { point[1] *= ratio; });
        });
        rebase(current.strokes);
        for (const action of [...current.undo, ...current.redo]) rebase(action.kind === "add" ? [action.stroke] : action.strokes);
        if (active) rebase([active.stroke]);
        current.pageHeight = pageHeight;
        changed = true;
      }
      // Keep the logical page roomy without allocating an unbounded bitmap.
      const backingWidth = Math.min(engine.paper.width, Math.max(1, Math.floor(Math.sqrt(engine.limits.canvasPixels * engine.paper.width / current.pageHeight))));
      const backingHeight = Math.floor(backingWidth * current.pageHeight / engine.paper.width);
      if (canvas.width !== backingWidth || canvas.height !== backingHeight) {
        for (const layer of [canvas, inkCanvas]) {
          // Shrink first so changing between tall and short pages stays bounded.
          if (backingWidth > layer.width) { layer.height = backingHeight; layer.width = backingWidth; }
          else { layer.width = backingWidth; layer.height = backingHeight; }
        }
        changed = true;
      }
      const displayHeight = `${current.pageHeight * width / engine.paper.width}px`;
      if (canvas.style.height !== displayHeight) { canvas.style.height = displayHeight; changed = true; }
      return changed;
    }

    function updateCursor() {
      if (!opened) return;
      const width = canvas.getBoundingClientRect().width;
      if (!Number.isFinite(width) || width <= 0) return;
      // Fine shares Medium's pointer size while retaining its own ink width.
      const pointerWidth = widths[tool] === 2 ? 4 : widths[tool];
      const radius = pointerWidth * width / engine.paper.width / 2;
      const outline = theme() === "dark" ? "#111827" : "white";
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><circle cx="16" cy="16" r="${radius + 1}" fill="${outline}"/><circle cx="16" cy="16" r="${radius}" fill="${engine.inkColor(colors[tool], theme())}"/></svg>`;
      canvas.style.cursor = `url("data:image/svg+xml,${encodeURIComponent(svg)}") 16 16, default`;
    }

    function controls() {
      const current = page();
      const focused = document.activeElement;
      tools.forEach(name => byId(`rough-tool-${name}`).setAttribute("aria-pressed", String(name === tool)));
      byId("rough-work-color").value = colors[tool];
      byId("rough-work-color").disabled = tool === "eraser";
      byId("rough-work-color").querySelector('option[value="#17233b"]').textContent = theme() === "dark" ? "White" : "Black";
      byId("rough-work-width").value = String(widths[tool]);
      byId("rough-work-paper").value = current?.paperStyle || defaultPaper;
      canvas.dataset.paperStyle = current?.paperStyle || defaultPaper;
      byId("rough-undo").disabled = !current?.undo.length;
      byId("rough-redo").disabled = !current?.redo.length;
      byId("rough-clear").disabled = !current?.strokes.length;
      if (opened && focused?.disabled && ["rough-undo", "rough-redo", "rough-clear"].includes(focused.id)) canvas.focus({ preventScroll: true });
      status.textContent = current?.notice || current?.warning || (current?.saved ? "Saved in this browser" : "Ready · Saved automatically in this browser");
      status.classList.toggle("error", Boolean(current?.notice || current?.warning));
      updateCursor();
    }
    function read(id) {
      const restored = { strokes: [], paperStyle: defaultPaper, pageHeight: engine.paper.height, undo: [], redo: [], dirty: false, saved: false, warning: "", notice: "", loadFailed: false };
      try {
        const text = localStorage.getItem(storageKey(id));
        if (text !== null) {
          if (text.length > 3 * 1024 * 1024) throw new Error("Drawing is too large.");
          const saved = JSON.parse(text);
          if (!saved || saved.version !== 1 || saved.quizId !== quizId || saved.questionId !== id ||
              typeof saved.updatedAt !== "string" || !Number.isFinite(Date.parse(saved.updatedAt))) throw new Error("Invalid rough-work page.");
          const paperStyle = Object.hasOwn(saved, "paperStyle") ? saved.paperStyle : "blank";
          if (!paperStyles.includes(paperStyle)) throw new Error("Invalid rough-work paper style.");
          const pageHeight = Object.hasOwn(saved, "pageHeight") ? saved.pageHeight : engine.paper.height;
          if (!Number.isInteger(pageHeight) || pageHeight < engine.paper.height || pageHeight > engine.limits.paperHeight) throw new Error("Invalid rough-work page height.");
          restored.strokes = engine.validateStrokes(saved.strokes);
          restored.paperStyle = paperStyle;
          restored.pageHeight = pageHeight;
          restored.saved = true;
          restored.undo = restored.strokes.slice(-50).map(stroke => ({ kind: "add", stroke }));
        }
      } catch {
        restored.loadFailed = true;
        restored.warning = "Could not load saved rough work. Keep this tab open; reload to try again.";
      }
      return restored;
    }
    function persist(current = page()) {
      if (!current?.dirty || current.loadFailed) return;
      try {
        const strokes = engine.validateStrokes(current.strokes);
        localStorage.setItem(storageKey(currentId), JSON.stringify({ version: 1, quizId, questionId: currentId, updatedAt: new Date().toISOString(), paperStyle: current.paperStyle, pageHeight: current.pageHeight, strokes }));
        current.dirty = false;
        current.saved = true;
        current.warning = "";
      } catch {
        current.warning = "Could not save rough work. Keep this tab open to retain your notes.";
      }
    }
    function draw() {
      frame = null;
      if (!opened || !page()) return;
      const strokes = active ? [...page().strokes, active.stroke] : page().strokes;
      engine.draw(inkContext, strokes, canvas.width, canvas.height, theme());
      engine.drawPaper(context, page().paperStyle, canvas.width, canvas.height, page().pageHeight, theme());
      context.save();
      try {
        context.setTransform?.(1, 0, 0, 1, 0, 0);
        context.globalCompositeOperation = "source-over";
        context.globalAlpha = 1;
        context.drawImage(inkCanvas, 0, 0);
      } finally { context.restore(); }
    }
    function scheduleDraw() {
      if (frame !== null) return;
      if (window.requestAnimationFrame) frame = window.requestAnimationFrame(draw);
      else draw();
    }
    function remember(action) {
      const current = page();
      current.undo.push(action);
      if (current.undo.length > 50) current.undo.shift();
      current.redo = [];
      current.dirty = true;
      current.notice = "";
      persist();
      controls();
    }
    function point(event) {
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      return [event.clientX - rect.left, event.clientY - rect.top].map((value, index) =>
        Math.round(Math.max(0, Math.min(1, value / (index ? rect.height : rect.width))) * 10000) / 10000);
    }
    function finish() {
      if (!active) return;
      const drawing = active;
      active = null;
      try { canvas.releasePointerCapture?.(drawing.pointerId); } catch { /* Capture may already be released. */ }
      page().strokes.push(drawing.stroke);
      remember({ kind: "add", stroke: drawing.stroke });
      draw();
    }
    function flush() { finish(); persist(); controls(); }
    function undo() {
      finish();
      const current = page(), action = current?.undo.pop();
      if (!action) return;
      if (action.kind === "add") current.strokes.pop();
      else current.strokes = action.strokes.slice();
      current.redo.push(action);
      current.dirty = true;
      current.notice = "";
      persist(); controls(); draw();
    }
    function redo() {
      finish();
      const current = page(), action = current?.redo.pop();
      if (!action) return;
      if (action.kind === "add") current.strokes.push(action.stroke);
      else current.strokes = [];
      current.undo.push(action);
      current.dirty = true;
      current.notice = "";
      persist(); controls(); draw();
    }
    tools.forEach(name => byId(`rough-tool-${name}`).addEventListener("click", () => {
      finish(); tool = name; controls();
    }));
    byId("rough-work-color").addEventListener("change", event => {
      if (engine.colors.includes(event.target.value)) colors[tool] = event.target.value;
      controls();
    });
    byId("rough-work-width").addEventListener("change", event => {
      const width = Number(event.target.value);
      if (engine.widths.includes(width)) widths[tool] = width;
      controls();
    });
    byId("rough-work-paper").addEventListener("change", event => {
      const paperStyle = event.target.value;
      finish();
      const current = page();
      if (current && paperStyles.includes(paperStyle) && paperStyle !== current.paperStyle) {
        current.paperStyle = paperStyle;
        current.dirty = true;
        current.notice = "";
        persist();
      }
      controls();
      draw();
    });
    byId("rough-undo").addEventListener("click", undo);
    byId("rough-redo").addEventListener("click", redo);
    byId("rough-clear").addEventListener("click", () => {
      finish();
      const current = page();
      if (!current?.strokes.length) return;
      const strokes = current.strokes;
      current.strokes = [];
      remember({ kind: "clear", strokes });
      draw();
    });
    canvas.addEventListener("pointerdown", event => {
      if (!opened || active || event.button !== 0 || !page()) return;
      const current = page(), first = point(event);
      const count = current.strokes.reduce((sum, stroke) => sum + stroke.points.length, 0);
      if (!first) return;
      if (current.strokes.length >= engine.limits.strokes || count >= engine.limits.totalPoints) {
        current.notice = "This page is full. Undo some marks or clear the page to keep drawing.";
        controls(); return;
      }
      event.preventDefault();
      canvas.focus({ preventScroll: true });
      active = { pointerId: event.pointerId, count, stroke: { tool, color: colors[tool], width: widths[tool], points: [first] } };
      try { canvas.setPointerCapture?.(event.pointerId); } catch { /* Drawing still works inside the page. */ }
      scheduleDraw();
    });
    function move(event) {
      if (!active || event.pointerId !== active.pointerId) return;
      const next = point(event), points = active.stroke.points, last = points[points.length - 1];
      if (!next || Math.hypot((next[0] - last[0]) * canvas.width, (next[1] - last[1]) * canvas.height) < 1) return;
      if (points.length >= engine.limits.pointsPerStroke || active.count + points.length >= engine.limits.totalPoints) {
        finish();
        page().notice = "Stroke limit reached. Lift the pen before continuing, or clear the page.";
        controls(); return;
      }
      points.push(next);
      scheduleDraw();
    }
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", event => {
      if (active?.pointerId !== event.pointerId) return;
      move(event); finish();
    });
    for (const name of ["pointercancel", "lostpointercapture"]) canvas.addEventListener(name, event => {
      if (active?.pointerId === event.pointerId) finish();
    });
    function resizePaper() {
      if (fitPaper()) scheduleDraw();
      updateCursor();
    }
    canvas.addEventListener("pointerenter", resizePaper);
    window.addEventListener("resize", resizePaper);
    if (window.ResizeObserver) {
      const observer = new window.ResizeObserver(resizePaper);
      observer.observe(surface);
      observer.observe(canvas);
    }
    panel.addEventListener("keydown", event => {
      if (!opened || !(event.ctrlKey || event.metaKey) || event.altKey || ["input", "select", "textarea"].includes(event.target.tagName?.toLowerCase())) return;
      const key = event.key.toLowerCase();
      if (key === "z" || key === "y") {
        event.preventDefault();
        if (key === "y" || event.shiftKey) redo(); else undo();
      }
    });
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", flush);
    window.addEventListener("blur", () => { if (active) finish(); });
    document.addEventListener("visibilitychange", () => { if (document.hidden) flush(); });
    function refreshTheme() {
      controls();
      if (opened) scheduleDraw();
    }
    if (window.MutationObserver) {
      new window.MutationObserver(refreshTheme).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    } else {
      const refreshAfterTheme = () => {
        if (window.requestAnimationFrame) window.requestAnimationFrame(refreshTheme);
        else Promise.resolve().then(refreshTheme);
      };
      byId("theme-toggle")?.addEventListener("click", refreshAfterTheme);
      window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener("change", refreshAfterTheme);
    }
    controls();
    return {
      show(id, label = id) {
        if (!ids.has(id)) return false;
        if (opened && currentId === id) return true;
        if (currentId !== id) {
          flush(); currentId = id;
          if (!pages.has(id)) pages.set(id, read(id));
        }
        opened = true;
        byId("rough-page-label").textContent = `Question ${label}`;
        canvas.setAttribute("aria-label", `Drawing page for ${label}`);
        fitPaper();
        controls(); draw();
        return true;
      },
      hide() { flush(); opened = false; }
    };
  }
  window.RoughWorkNotebook = { create };
})();
