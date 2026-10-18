(() => {
  "use strict";
  if (document.getElementById("shared-calculator-toggle")) return;

  const toggle = document.createElement("button");
  toggle.id = "shared-calculator-toggle";
  toggle.className = "shared-calculator-toggle";
  toggle.type = "button";
  toggle.textContent = "Calculator";
  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-controls", "shared-calculator-panel");

  const panel = document.createElement("section");
  panel.id = "shared-calculator-panel";
  panel.className = "shared-calculator-panel";
  panel.setAttribute("aria-labelledby", "shared-calculator-heading");
  panel.hidden = true;
  panel.innerHTML = `
    <header class="shared-calculator-header" title="Drag to move the calculator">
      <h2 id="shared-calculator-heading" class="shared-calculator-heading" tabindex="0" aria-label="Scientific calculator. Use arrow keys to move this panel.">Scientific calculator</h2>
      <a class="shared-calculator-new-tab" href="/_calculator/" target="_blank" rel="noopener" aria-label="Open calculator in a new tab" title="Open in a new tab">↗</a>
      <button class="shared-calculator-close" type="button" aria-label="Close calculator" title="Close calculator (Escape)">×</button>
    </header>`;
  document.body.append(toggle, panel);

  let frame = null;
  let loaded = false;
  let drag = null;
  const header = panel.querySelector(".shared-calculator-header");
  const heading = panel.querySelector(".shared-calculator-heading");
  const post = message => {
    if (loaded) frame.contentWindow.postMessage(message, window.location.origin);
  };
  const syncTheme = () => post({ type: "quiz-calculator-theme", theme: document.documentElement.dataset.theme === "dark" ? "dark" : "light" });
  function close() {
    panel.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
    toggle.focus({ preventScroll: true });
  }
  function open() {
    panel.hidden = false;
    toggle.setAttribute("aria-expanded", "true");
    if (panel.style.left) {
      const rect = panel.getBoundingClientRect();
      move(rect.left, rect.top);
    }
    if (!frame) {
      frame = document.createElement("iframe");
      frame.className = "shared-calculator-frame";
      frame.title = "Scientific calculator";
      frame.addEventListener("load", () => {
        loaded = true;
        syncTheme();
        if (!panel.hidden) post({ type: "quiz-calculator-focus" });
      });
      frame.src = "/_calculator/";
      panel.append(frame);
    }
    syncTheme();
    if (loaded) post({ type: "quiz-calculator-focus" });
    else heading.focus({ preventScroll: true });
  }
  toggle.addEventListener("click", () => panel.hidden ? open() : close());
  panel.querySelector(".shared-calculator-close").addEventListener("click", close);
  panel.addEventListener("keydown", event => {
    if (event.key === "Escape") { event.preventDefault(); close(); }
  });
  window.addEventListener("message", event => {
    if (frame && event.origin === window.location.origin && event.source === frame.contentWindow && event.data?.type === "quiz-calculator-close") close();
  });
  new MutationObserver(syncTheme).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  // Only the header moves the panel, so calculator input and the quiz keep their normal behavior.
  function move(left, top) {
    const rect = panel.getBoundingClientRect();
    panel.style.left = `${Math.max(8, Math.min(left, window.innerWidth - rect.width - 8))}px`;
    panel.style.top = `${Math.max(8, Math.min(top, window.innerHeight - rect.height - 8))}px`;
    panel.style.right = "auto";
    panel.style.bottom = "auto";
  }
  header.addEventListener("pointerdown", event => {
    if (event.button !== 0 || event.target.closest("a, button")) return;
    const rect = panel.getBoundingClientRect();
    drag = { pointerId: event.pointerId, x: event.clientX - rect.left, y: event.clientY - rect.top };
    header.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  header.addEventListener("pointermove", event => {
    if (drag?.pointerId === event.pointerId) move(event.clientX - drag.x, event.clientY - drag.y);
  });
  const stopDragging = () => { drag = null; };
  header.addEventListener("pointerup", stopDragging);
  header.addEventListener("pointercancel", stopDragging);
  header.addEventListener("lostpointercapture", stopDragging);
  heading.addEventListener("keydown", event => {
    const step = event.shiftKey ? 40 : 10;
    const offsets = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const offset = offsets[event.key];
    if (!offset) return;
    event.preventDefault();
    const rect = panel.getBoundingClientRect();
    move(rect.left + offset[0], rect.top + offset[1]);
  });
  window.addEventListener("resize", () => {
    if (!panel.hidden && panel.style.left) {
      const rect = panel.getBoundingClientRect();
      move(rect.left, rect.top);
    }
  });
})();
