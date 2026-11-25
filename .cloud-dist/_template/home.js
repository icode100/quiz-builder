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
    if (reset.disabled || !window.confirm(window.QuizCloudSync ? "Reset your saved submissions for every paper? Your unfinished progress and drawings will stay." : "Reset all saved attempts? This removes previous submissions for every paper. Your unfinished browser drafts will stay.")) return;
    reset.disabled = true;
    try {
      if (window.QuizCloudSync) await window.QuizCloudSync.resetAttempts();
      else {
        const response = await fetch("/reset-attempts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: true }) });
        if (!response.ok) throw new Error("Could not reset all saved attempts. Refresh this page to see the current status and try again.");
      }
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
  if (window.QuizCloudSync) {
    const number = value => Number(value.toFixed(4)).toLocaleString("en-US", { maximumFractionDigits: 4 });
    const cardChecks = new WeakMap();
    async function refreshCard(card, fetchUnknown = true) {
      const check = (cardChecks.get(card) || 0) + 1;
      cardChecks.set(card, check);
      let saved;
      try {
        saved = window.QuizCloudSync.getCachedAttempt?.(card.dataset.quizId);
        if (saved === undefined) {
          if (!fetchUnknown) return;
          saved = await window.QuizCloudSync.getAttempt(card.dataset.quizId);
        }
      }
      catch { return; }
      if (cardChecks.get(card) !== check) return;
      const attempted = Boolean(saved?.answers && typeof saved.answers === "object" && !Array.isArray(saved.answers) && Object.values(saved.answers).some(value => value !== null));
      card.dataset.attempted = String(attempted);
      const badge = card.querySelector(".paper-status");
      badge.textContent = attempted ? "Attempted before" : "Not attempted";
      badge.classList.toggle("attempted", attempted); badge.classList.toggle("unattempted", !attempted);
      const score = card.querySelector(".paper-score"); score.hidden = !attempted;
      if (attempted) {
        const summary = saved.summary;
        const valid = summary && Number.isFinite(summary.score) && Number.isFinite(summary.maximum) && (summary.percentage === null || Number.isFinite(summary.percentage));
        card.querySelector(".paper-score-value").textContent = !valid ? "Last score unavailable" : summary.percentage === null ? "Percentage unavailable" : `Last score: ${number(summary.percentage)}%`;
        const bar = card.querySelector(".paper-score-bar"); bar.hidden = !valid || summary.percentage === null;
        if (!bar.hidden) { bar.max = 100; bar.value = Math.max(0, Math.min(100, summary.percentage)); bar.setAttribute("aria-label", `Last score: ${number(summary.percentage)}%; ${number(summary.score)} out of ${number(summary.maximum)} marks`); }
        const marks = card.querySelector(".paper-score-marks"); marks.hidden = !valid;
        if (valid) marks.textContent = `${number(summary.score)} / ${number(summary.maximum)} marks`;
      }
      updateFilter();
    }
    const existing = new Set(window.QuizCloudSync.entries().map(([key]) => key));
    cards.forEach(card => refreshCard(card, existing.has(`practice-quiz:${card.dataset.quizId}:attempt`)));
    window.addEventListener("quiz-cloud-record", event => {
      const card = cards.find(item => event.detail?.key === `practice-quiz:${item.dataset.quizId}:attempt`);
      if (card) refreshCard(card);
    });
  }
  updateFilter();
})();
