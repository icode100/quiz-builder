(() => {
  "use strict";
  const byId = id => document.getElementById(id);
  const list = byId("home-papers");
  if (!list) return;
  const cards = Array.from(list.children), filter = byId("unsolved-only"), reset = byId("reset-attempts");
  function updateFilter() {
    let visible = 0;
    cards.forEach(card => { card.hidden = filter.checked && card.dataset.attempted === "true"; visible += Number(!card.hidden); });
    byId("paper-count").textContent = `Showing ${visible} of ${cards.length} papers`;
    byId("no-papers").hidden = visible > 0;
  }
  function status(message, error = false) {
    const notice = byId("home-status");
    notice.textContent = message;
    notice.classList.toggle("error", error);
    notice.hidden = !message;
  }
  filter.addEventListener("change", updateFilter);
  window.addEventListener("pageshow", event => { if (event.persisted) window.location.reload(); });
  reset.disabled = cards.length === 0;
  reset.addEventListener("click", async () => {
    if (reset.disabled || !window.confirm("Reset all saved attempts? This removes previous submissions for every paper. Your unfinished browser drafts will stay.")) return;
    reset.disabled = true;
    try {
      const response = await fetch("/reset-attempts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: true }) });
      if (!response.ok) throw new Error("Could not reset all saved attempts. Refresh this page to see the current status and try again.");
      cards.forEach(card => {
        card.dataset.attempted = "false";
        const badge = card.querySelector(".paper-status");
        badge.textContent = "Not attempted";
        badge.classList.remove("attempted");
        badge.classList.toggle("unattempted", true);
        card.querySelector(".paper-score").hidden = true;
      });
      updateFilter();
      status("Saved attempts reset. All papers are unsolved again.");
    } catch (error) { status(error.message, true); }
    finally { reset.disabled = cards.length === 0; }
  });
  updateFilter();
})();
