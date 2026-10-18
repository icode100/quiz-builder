(() => {
  "use strict";

  const byId = (id) => document.getElementById(id);
  const data = window.QUIZ_DATA;
  const answers = Object.create(null);
  const reviewFlags = new Set();
  const reportReviewFlags = new Set();
  let results = [], submittedAt = "", updatedAt = "", signature = "", storageKey = "";
  let storageAvailable = false;
  let serverBusy = false, reviewState = null, hasSavedAttempt = false, reviewCheck = 0;
  const timerPresets = [180, 150, 120, 90, 60, 30];
  let timerMinutes = 180, timerRemainingMs = 180 * 60000, timerEndsAt = null, timerInterval = null;
  let currentQuestionIndex = 0, currentQuestionFrame = false, currentQuestionInteraction = null;

  function setCurrentQuestion(index) {
    if (!Number.isInteger(index) || index < 0 || index >= data.questions.length) return;
    currentQuestionIndex = index;
    data.questions.forEach((question, number) => {
      byId(`nav-question-${number}`)?.setAttribute("aria-current", number === index ? "location" : "false");
    });
  }
  function questionTarget(index) {
    return byId(`${submittedAt ? "result" : "question"}-card-${index}`);
  }
  function noteCurrentQuestion(index) {
    setCurrentQuestion(index);
    currentQuestionInteraction = { index, scrollY: window.scrollY ?? 0 };
  }
  function jumpToQuestion(index) {
    setCurrentQuestion(index);
    const target = questionTarget(index);
    target?.scrollIntoView({ block: "start" });
    target?.focus({ preventScroll: true });
    noteCurrentQuestion(index);
  }
  function updateCurrentQuestionFromViewport() {
    const height = window.innerHeight;
    if (!Number.isFinite(height) || height <= 0) return;
    const first = questionTarget(0);
    if (!first?.getBoundingClientRect) return;
    const timer = byId("quiz-timer"), timerRect = !timer.hidden && timer.getBoundingClientRect?.();
    const scrollMargin = parseFloat(window.getComputedStyle?.(first).scrollMarginTop) || 0;
    const line = Math.min(height - 1, Math.max(16, scrollMargin + 1, timerRect && timerRect.top < height && timerRect.bottom > 0 ? timerRect.bottom + 16 : 0));
    if (currentQuestionInteraction) {
      const target = questionTarget(currentQuestionInteraction.index), rect = target?.getBoundingClientRect?.();
      if (currentQuestionInteraction.scrollY === (window.scrollY ?? 0) && rect && rect.bottom > line && rect.top < height) {
        setCurrentQuestion(currentQuestionInteraction.index);
        return;
      }
      currentQuestionInteraction = null;
    }
    let index = -1, distance = Infinity;
    data.questions.forEach((question, number) => {
      const rect = questionTarget(number)?.getBoundingClientRect?.();
      if (!rect || rect.bottom <= line || rect.top >= height) return;
      const nextDistance = Math.max(0, rect.top - line);
      if (nextDistance < distance) { index = number; distance = nextDistance; }
    });
    if (index >= 0) setCurrentQuestion(index);
  }
  function scheduleCurrentQuestion() {
    if (currentQuestionFrame) return;
    currentQuestionFrame = true;
    const update = () => { currentQuestionFrame = false; updateCurrentQuestionFromViewport(); };
    if (window.requestAnimationFrame) window.requestAnimationFrame(update);
    else update();
  }
  function setupCurrentQuestion() {
    const trackInteraction = (event) => {
      const card = event.target.closest?.(".question-card, .result-card");
      const match = card?.id.match(/^(question|result)-card-(\d+)$/);
      if (match && match[1] === (submittedAt ? "result" : "question")) noteCurrentQuestion(Number(match[2]));
    };
    document.addEventListener("focusin", trackInteraction);
    document.addEventListener("pointerdown", trackInteraction);
    document.addEventListener("load", scheduleCurrentQuestion, true);
    window.addEventListener("scroll", scheduleCurrentQuestion, { passive: true });
    window.addEventListener("resize", scheduleCurrentQuestion);
    window.addEventListener("pageshow", scheduleCurrentQuestion);
  }

  function timerSnapshot() {
    return { durationMinutes: timerMinutes, remainingMs: timerEndsAt === null ? timerRemainingMs : Math.max(0, Math.min(timerMinutes * 60000, timerEndsAt - Date.now())), endsAt: timerEndsAt };
  }
  function restoreTimer(saved) {
    if (!saved || typeof saved !== "object" || Array.isArray(saved) || !timerPresets.includes(saved.durationMinutes) ||
        !Number.isSafeInteger(saved.remainingMs) || saved.remainingMs < 0 || saved.remainingMs > saved.durationMinutes * 60000 ||
        !(saved.endsAt === null || (Number.isSafeInteger(saved.endsAt) && saved.endsAt > 0 && saved.endsAt - Date.now() <= saved.durationMinutes * 60000))) return;
    timerMinutes = saved.durationMinutes;
    timerRemainingMs = saved.remainingMs;
    timerEndsAt = saved.endsAt;
  }
  function renderTimer() {
    const remaining = timerSnapshot().remainingMs;
    if (timerEndsAt !== null && remaining === 0) {
      timerRemainingMs = 0;
      timerEndsAt = null;
      if (timerInterval !== null) { clearInterval(timerInterval); timerInterval = null; }
    }
    const seconds = Math.ceil(remaining / 1000);
    byId("timer-display").textContent = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(value => String(value).padStart(2, "0")).join(":");
    byId("timer-duration").value = String(timerMinutes);
    byId("timer-start").disabled = timerEndsAt !== null || remaining === 0;
    byId("timer-pause").disabled = timerEndsAt === null;
    const message = remaining === 0 ? "Time is up. Submit when ready." : timerEndsAt !== null ? "Running" : remaining === timerMinutes * 60000 ? "Ready" : "Paused";
    if (byId("timer-status").textContent !== message) byId("timer-status").textContent = message;
    byId("quiz-timer").classList.toggle("timer-expired", remaining === 0);
  }
  function startTimer() {
    if (submittedAt || timerEndsAt !== null || timerRemainingMs <= 0) return;
    timerEndsAt = Date.now() + timerRemainingMs;
    timerInterval = setInterval(renderTimer, 250);
    renderTimer();
    save();
  }
  function pauseTimer() {
    if (submittedAt || timerEndsAt === null) return;
    timerRemainingMs = timerSnapshot().remainingMs;
    timerEndsAt = null;
    if (timerInterval !== null) { clearInterval(timerInterval); timerInterval = null; }
    renderTimer();
    save();
  }
  function resetTimer(persist = true) {
    if (timerInterval !== null) { clearInterval(timerInterval); timerInterval = null; }
    timerEndsAt = null;
    timerRemainingMs = timerMinutes * 60000;
    renderTimer();
    if (persist) save();
  }
  function setupTimer() {
    byId("quiz-timer").hidden = false;
    byId("timer-duration").addEventListener("change", () => {
      const selected = Number(byId("timer-duration").value);
      if (submittedAt || !timerPresets.includes(selected)) { renderTimer(); return; }
      timerMinutes = selected;
      resetTimer();
    });
    byId("timer-start").addEventListener("click", startTimer);
    byId("timer-pause").addEventListener("click", pauseTimer);
    byId("timer-reset").addEventListener("click", () => { if (!submittedAt) resetTimer(); });
    renderTimer();
    if (timerEndsAt !== null) timerInterval = setInterval(renderTimer, 250);
  }

  function element(tag, className = "", text) {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function status(message, error = false) {
    byId("status-message").textContent = message;
    byId("status-message").classList.toggle("error", error);
    byId("status-message").hidden = !message;
  }
  const questionType = (question) => question.type || "mcq";
  const questionLabel = (question) => question.displayLabel || question.id;
  const number = (value) => Number(value.toFixed(4)).toLocaleString(undefined, { maximumFractionDigits: 4 });
  const marks = (question) => ({ correct: question.marks ?? data.scoring?.correct ?? 1, incorrect: question.incorrectMarks ?? data.scoring?.incorrect ?? 0 });
  const imagesOf = (item) => [...(item.image ? [{ src: item.image, alt: item.imageAlt, page: item.sourcePage }] : []), ...(item.images || [])];

  function numericValue(raw) {
    if (typeof raw !== "string" || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw.trim())) return null;
    return Number.isFinite(Number(raw.trim())) ? Number(raw.trim()) : null;
  }
  function correctAnswerText(question) {
    if (question.marksToAll) return "MTA — marks to all";
    if (questionType(question) === "nat") return question.correctRanges.map(({ min, max }) => min === max ? String(min) : `${min} to ${max} (inclusive)`).join(" OR ");
    if (questionType(question) === "msq") return question.correctAnswers.join(" + ");
    return (question.acceptedAnswers || [question.correctAnswer]).join(" OR ");
  }
  function validate() {
    if (!data || typeof data.id !== "string" || !data.id.trim() || typeof data.title !== "string" || !Array.isArray(data.questions)) throw new Error("The quiz data is incomplete.");
    const ids = new Set();
    for (const question of data.questions) {
      if (!question || typeof question.id !== "string" || !question.id.trim() || ids.has(question.id)) throw new Error("Question IDs must be unique.");
      ids.add(question.id);
      if (typeof question.text !== "string" || (!question.text.trim() && !imagesOf(question).length)) throw new Error(`${question.id} is missing its original content.`);
      if (imagesOf(question).some((image) => !image || typeof image.src !== "string" || !image.src.trim())) throw new Error(`${question.id} has an invalid image.`);
      const type = questionType(question);
      if (!["mcq", "msq", "nat"].includes(type)) throw new Error(`${question.id} has an unsupported question type.`);
      if (type === "nat") {
        if (!question.marksToAll && (!Array.isArray(question.correctRanges) || !question.correctRanges.length || question.correctRanges.some((range) => !range || !Number.isFinite(range.min) || !Number.isFinite(range.max) || range.min > range.max))) throw new Error(`${question.id} needs verified numerical ranges.`);
      } else {
        if (!Array.isArray(question.options) || question.options.length < 2) throw new Error(`${question.id} needs answer options.`);
        const optionIds = new Set();
        for (const option of question.options) {
          if (!option || typeof option.id !== "string" || !option.id.trim() || optionIds.has(option.id) || typeof option.text !== "string" || (!option.text.trim() && !imagesOf(option).length)) throw new Error(`${question.id} has an invalid option.`);
          optionIds.add(option.id);
        }
        const key = type === "msq" ? question.correctAnswers : (question.acceptedAnswers || [question.correctAnswer]);
        if (!question.marksToAll && (!Array.isArray(key) || !key.length || new Set(key).size !== key.length || key.some((id) => !optionIds.has(id)))) throw new Error(`${question.id} needs a verified answer.`);
      }
      if (!Number.isFinite(marks(question).correct) || marks(question).correct <= 0 || !Number.isFinite(marks(question).incorrect) || marks(question).incorrect > 0) throw new Error(`${question.id} has invalid marking rules.`);
      if (question.requiresCorrect !== undefined) {
        const prerequisite = data.questions.find((item) => item.id === question.requiresCorrect);
        if (typeof question.requiresCorrect !== "string" || question.requiresCorrect === question.id || !ids.has(question.requiresCorrect) || type !== "mcq" || question.marksToAll || marks(question).incorrect !== 0 || !prerequisite || questionType(prerequisite) !== "mcq" || prerequisite.marksToAll || prerequisite.requiresCorrect !== undefined) throw new Error(`${question.id} has invalid linked-answer rules.`);
      }
    }
  }
  function validateAnswers(savedAnswers, submitted = false) {
    if (!savedAnswers || typeof savedAnswers !== "object" || Array.isArray(savedAnswers)) throw new Error("Invalid responses.");
    const restored = Object.create(null);
    for (const [id, answer] of Object.entries(savedAnswers)) {
      const question = data.questions.find((item) => item.id === id);
      if (!question) throw new Error("The cached draft contains an unknown question.");
      if (answer === null) continue;
      const type = questionType(question);
      if (type === "mcq" && !question.options.some((option) => option.id === answer)) throw new Error("Invalid cached option.");
      if (type === "msq" && (!Array.isArray(answer) || !answer.length ||
          new Set(answer).size !== answer.length || answer.some((value) => !question.options.some((option) => option.id === value)))) throw new Error("Invalid cached selection.");
      if (type === "nat" && (typeof answer !== "string" || !answer.trim() || (submitted && numericValue(answer) === null))) throw new Error("Invalid numerical response.");
      restored[id] = answer;
    }
    return restored;
  }
  function validateReviewFlags(flags = []) {
    if (!Array.isArray(flags) || new Set(flags).size !== flags.length || flags.some(id => typeof id !== "string" || !data.questions.some(question => question.id === id))) throw new Error("Invalid review flags.");
    return flags;
  }
  function restoreDraft(saved) {
    if (!saved || saved.signature !== signature || saved.submittedAt) throw new Error("This cached draft is invalid or already submitted.");
    const restored = validateAnswers(saved.answers);
    const flags = validateReviewFlags(saved.reviewFlags);
    if (saved.updatedAt && (typeof saved.updatedAt !== "string" || !Number.isFinite(Date.parse(saved.updatedAt)))) throw new Error("Invalid draft timestamp.");
    Object.keys(answers).forEach((id) => delete answers[id]);
    Object.assign(answers, restored);
    reviewFlags.clear();
    flags.forEach(id => reviewFlags.add(id));
    updatedAt = saved.updatedAt || "";
    restoreTimer(saved.timer);
  }
  function save() {
    updatedAt = new Date(Math.max(Date.now(), (Date.parse(updatedAt) || 0) + 1)).toISOString();
    try {
      localStorage.setItem(storageKey, JSON.stringify({ signature, answers, reviewFlags: [...reviewFlags], timer: timerSnapshot(), updatedAt }));
      if (!storageAvailable) status("Progress is cached in this browser until Submit.");
      storageAvailable = true;
      return true;
    } catch {
      storageAvailable = false;
      status("Could not cache your progress. Keep this tab open to retain your answers.", true);
      return false;
    }
  }
  function clearDraft() {
    try {
      localStorage.removeItem(storageKey);
      status("Submitted and saved to attempt.json. The browser draft cache has been cleared.");
      return true;
    } catch {
      status("Your result was saved, but the browser draft cache could not be cleared.", true);
      return false;
    }
  }
  function setupStorage() {
    storageKey = `practice-quiz:${data.id}`;
    signature = JSON.stringify({ questions: data.questions, scoring: data.scoring ?? null });
    try {
      const text = localStorage.getItem(storageKey);
      if (text) {
        try { restoreDraft(JSON.parse(text)); }
        catch { localStorage.removeItem(storageKey); }
      }
      localStorage.setItem(`${storageKey}:probe`, "1");
      localStorage.removeItem(`${storageKey}:probe`);
      storageAvailable = true;
      status("Progress is cached in this browser until Submit.");
    } catch {
      status("Browser cache is unavailable. Keep this tab open to retain your answers.", true);
    }
  }
  function grade() {
    const outcomes = new Map();
    return data.questions.map((question) => {
      const selected = answers[question.id], type = questionType(question);
      let outcome = "unanswered", reason = "";
      if (question.marksToAll) outcome = "awarded";
      else if (selected !== undefined) {
        const correct = type === "nat" ? numericValue(selected) !== null && question.correctRanges.some(({ min, max }) => numericValue(selected) >= min && numericValue(selected) <= max)
          : type === "msq" ? selected.length === question.correctAnswers.length && selected.every((id) => question.correctAnswers.includes(id))
          : (question.acceptedAnswers || [question.correctAnswer]).includes(selected);
        outcome = correct ? "correct" : "incorrect";
        if (question.requiresCorrect && outcomes.get(question.requiresCorrect) !== "correct") {
          outcome = "blocked";
          const prerequisite = data.questions.find((item) => item.id === question.requiresCorrect);
          reason = `Not evaluated because question ${questionLabel(prerequisite)} was incorrect or unanswered.`;
        }
      }
      outcomes.set(question.id, outcome);
      return { question, selected, outcome, earned: outcome === "unanswered" || outcome === "blocked" ? 0 : outcome === "awarded" ? marks(question).correct : marks(question)[outcome], ...(reason ? { reason } : {}) };
    });
  }
  function summarize(currentResults) {
    const counts = { correct: 0, incorrect: 0, unanswered: 0, awarded: 0 };
    let score = 0, maximum = 0, awardedMarks = 0;
    currentResults.forEach((result) => {
      counts[result.outcome] = (counts[result.outcome] || 0) + 1;
      score += result.earned;
      maximum += marks(result.question).correct;
      if (result.outcome === "awarded") awardedMarks += result.earned;
    });
    return { counts, score, maximum, awardedMarks };
  }
  function setControls() {
    byId("quiz-session").disabled = serverBusy;
    byId("quiz-form").querySelectorAll("input, button").forEach((control) => { control.disabled = serverBusy; });
    const review = byId("review-attempt"), hint = hasSavedAttempt ? "" : "This paper has not been attempted before.";
    review.disabled = serverBusy || !hasSavedAttempt;
    review.title = hint;
    byId("review-attempt-wrap").title = hint;
    byId("retry-quiz").disabled = serverBusy || !submittedAt;
    byId("retry-quiz").textContent = reviewState ? "Back to quiz" : "Attempt again";
  }

  function attemptUrl() {
    const url = new URL(window.location.href);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error("Start the quiz server and open the quiz at http://127.0.0.1:8765.");
    return new URL("attempt.json", url).href;
  }
  function setSavedAttempt(saved) {
    reviewCheck++;
    const responses = saved?.answers;
    hasSavedAttempt = Boolean(saved && typeof saved === "object" && !Array.isArray(saved) && responses && typeof responses === "object" && !Array.isArray(responses) && Object.values(responses).some(answer => answer !== null));
    setControls();
  }
  async function checkLastAttempt() {
    const check = ++reviewCheck;
    let saved = null;
    try {
      const response = await fetch(attemptUrl(), { cache: "no-store" });
      if (response.ok) saved = await response.json();
    } catch { /* Missing or unreadable attempts leave review disabled. */ }
    if (check === reviewCheck) setSavedAttempt(saved);
  }
  function attemptSnapshot() {
    const scored = grade(), { counts, score, maximum, awardedMarks } = summarize(scored);
    return {
      version: 1, quizId: data.id, quizTitle: data.title, quizSignature: signature,
      updatedAt, submittedAt,
      answers: Object.fromEntries(data.questions.map((q) => [q.id, answers[q.id] ?? null])),
      reviewFlags: [...reportReviewFlags],
      summary: { score, maximum, ...counts, awardedMarks },
      results: scored.map((result) => ({ questionId: result.question.id, answer: result.selected ?? null,
        correctAnswer: correctAnswerText(result.question), outcome: result.outcome,
        marksEarned: result.earned, maxMarks: marks(result.question).correct, ...(result.reason ? { reason: result.reason } : {}) }))
    };
  }
  function validateSubmission(saved) {
    if (!saved?.submittedAt) throw new Error("No submitted attempt has been saved yet.");
    if (saved.version !== 1 || saved.quizId !== data.id || saved.quizSignature !== signature) throw new Error("The saved attempt belongs to a different paper or answer key.");
    const restored = validateAnswers(saved.answers, true);
    const flags = validateReviewFlags(saved.reviewFlags);
    for (const key of ["submittedAt", "updatedAt"]) {
      if (typeof saved[key] !== "string" || !Number.isFinite(Date.parse(saved[key]))) throw new Error("Invalid saved timestamp.");
    }
    return { answers: restored, reviewFlags: flags, submittedAt: saved.submittedAt, updatedAt: saved.updatedAt };
  }
  function restoreState(state) {
    Object.keys(answers).forEach((id) => delete answers[id]);
    Object.assign(answers, state.answers);
    reviewFlags.clear();
    (state.reviewFlags || []).forEach(id => reviewFlags.add(id));
    reportReviewFlags.clear();
    (state.reportReviewFlags || state.reviewFlags || []).forEach(id => reportReviewFlags.add(id));
    submittedAt = state.submittedAt;
    updatedAt = state.updatedAt;
  }
  async function reviewLastAttempt() {
    if (serverBusy || !hasSavedAttempt) return;
    serverBusy = true;
    setControls();
    try {
      const response = await fetch(attemptUrl(), { cache: "no-store" });
      if (!response.ok) {
        setSavedAttempt(null);
        throw new Error(response.status === 404 ? "No submitted attempt has been saved yet." : "The saved attempt could not be read.");
      }
      let record;
      try { record = await response.json(); }
      catch { setSavedAttempt(null); throw new Error("The saved attempt could not be read."); }
      setSavedAttempt(record);
      if (!hasSavedAttempt) throw new Error("This paper has not been attempted before.");
      const saved = validateSubmission(record);
      if (!reviewState) reviewState = { answers: JSON.parse(JSON.stringify(answers)), reviewFlags: [...reviewFlags], reportReviewFlags: [...reportReviewFlags], submittedAt, updatedAt, currentQuestionIndex };
      restoreState(saved);
      renderReport();
      status("Reviewing your last submitted attempt. Your current draft is unchanged.");
    } catch (error) { status(error.message, true); }
    finally { serverBusy = false; setControls(); }
  }
  async function submitAttempt(event) {
    event.preventDefault();
    if (serverBusy || reviewState) return;
    const timerChanged = timerEndsAt !== null || timerRemainingMs !== timerMinutes * 60000;
    resetTimer(false);
    const invalid = byId("questions").querySelector('.numeric-answer[aria-invalid="true"]');
    if (invalid) { if (timerChanged) save(); status("Check the highlighted number, or clear it to skip the question.", true); invalid.focus(); invalid.scrollIntoView({ block: "center" }); return; }
    submittedAt = new Date().toISOString();
    save();
    reportReviewFlags.clear();
    reviewFlags.forEach(id => reportReviewFlags.add(id));
    renderReport();
    serverBusy = true;
    setControls();
    try {
      const attempt = attemptSnapshot();
      const response = await fetch(attemptUrl(), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(attempt) });
      if (!response.ok) throw new Error("The server could not save the result.");
      setSavedAttempt(attempt);
      reviewFlags.clear();
      updateProgress();
      clearDraft();
    } catch (error) {
      status(`Your report is ready, but attempt.json was not saved. ${error.message} Your draft is kept; restart the server and reload to submit again.`, true);
    } finally { serverBusy = false; setControls(); }
  }

  function addImages(parent, item, alt) {
    imagesOf(item).forEach((part) => {
      const figure = element("figure", "source-figure"), link = element("a", "image-link"), image = element("img", "question-image");
      link.href = part.src;
      link.target = "_blank";
      link.rel = "noopener";
      link.setAttribute("aria-label", `Open original image for ${alt}`);
      image.src = part.src;
      image.alt = part.alt || alt;
      image.loading = "lazy";
      link.append(image);
      figure.append(link, element("figcaption", "source-caption", `Click image to open at full resolution${part.page ? ` · Source page ${part.page}` : ""}`));
      parent.append(figure);
    });
  }
  function updateProgress() {
    byId("progress").textContent = `${Object.keys(answers).length} of ${data.questions.length} answered`;
    const reporting = Boolean(submittedAt);
    const outcomeLabels = { correct: "Correct", incorrect: "Incorrect", unanswered: "Unanswered", awarded: "Marks to all", blocked: "Not evaluated" };
    const outcomeIcons = { correct: "✓", incorrect: "×", unanswered: "·", awarded: "+", blocked: "–" };
    let attempted = 0, invalidCount = 0;
    data.questions.forEach((question, index) => {
      const button = byId(`nav-question-${index}`);
      if (!button) return;
      const answered = Object.hasOwn(answers, question.id), invalid = answered && questionType(question) === "nat" && numericValue(answers[question.id]) === null;
      const flagged = reviewFlags.has(question.id), marked = (reporting ? reportReviewFlags : reviewFlags).has(question.id), markButton = byId(`mark-review-${index}`);
      const outcome = reporting ? results[index]?.outcome : null;
      if (markButton) {
        markButton.textContent = flagged ? "Unmark review" : "Mark for review";
        markButton.classList.toggle("marked-review", flagged);
        markButton.setAttribute("aria-pressed", String(flagged));
        markButton.setAttribute("aria-label", `${markButton.textContent} for ${questionLabel(question)}`);
      }
      attempted += Number(answered);
      invalidCount += Number(invalid);
      button.classList.toggle("answered", answered);
      button.classList.toggle("unanswered", !answered);
      button.classList.toggle("needs-check", !reporting && invalid);
      button.classList.toggle("marked-review", marked);
      button.classList.toggle("report-question", reporting);
      Object.keys(outcomeLabels).forEach(value => button.classList.toggle(`result-${value}`, outcome === value));
      button.querySelector(".nav-state-icon").textContent = reporting ? (marked ? "★" : outcomeIcons[outcome] || "·") : invalid ? "!" : marked ? "★" : answered ? "✓" : "·";
      button.title = `${questionLabel(question)}: ${reporting ? outcomeLabels[outcome] || "Unanswered" : answered ? "Attempted" : "Not attempted"}${!reporting && invalid ? " — check number" : ""}${marked ? ", Marked for review" : ""}`;
      button.setAttribute("aria-label", button.title);
    });
    byId("nav-progress").textContent = `${attempted} attempted · ${data.questions.length - attempted} not attempted`;
    byId("nav-check-legend").hidden = reporting || invalidCount === 0;
    byId("nav-review-legend").hidden = false;
    const reviewDot = byId("nav-review-legend").querySelector(".nav-dot");
    if (reviewDot) {
      reviewDot.classList.toggle("report-review", reporting);
      reviewDot.textContent = reporting ? "★" : "";
    }
    for (const id of ["nav-attempted-legend", "nav-unattempted-legend"]) byId(id).hidden = reporting;
    Object.keys(outcomeLabels).forEach(outcome => {
      byId(`nav-${outcome}-legend`).hidden = !reporting || (["awarded", "blocked"].includes(outcome) && !results.some(result => result.outcome === outcome));
    });
  }
  function renderNavigator() {
    const groups = new Map();
    data.questions.forEach((question, index) => {
      const section = question.section || "Questions";
      if (!groups.has(section)) {
        const group = element("section", "nav-section"), grid = element("div", "nav-grid");
        group.append(element("h3", "nav-section-title", section), grid);
        groups.set(section, { group, grid });
      }
      const button = element("button", "nav-question"), icon = element("span", "nav-state-icon");
      button.type = "button";
      button.id = `nav-question-${index}`;
      icon.setAttribute("aria-hidden", "true");
      button.append(element("span", "nav-number", String(question.number ?? questionLabel(question))), icon);
      button.addEventListener("click", () => jumpToQuestion(index));
      groups.get(section).grid.append(button);
    });
    byId("nav-groups").replaceChildren(...Array.from(groups.values(), ({ group }) => group));
    byId("question-nav").hidden = !data.questions.length;
    document.querySelector(".quiz-shell").classList.toggle("has-navigator", data.questions.length > 0);
    if (!byId("nav-current-legend")) {
      const legend = element("span"), dot = element("span", "nav-dot current-question");
      legend.id = "nav-current-legend";
      dot.setAttribute("aria-hidden", "true");
      legend.append(dot, element("span", "", "Current question"));
      document.querySelector(".nav-legend")?.append(legend);
    }
    setCurrentQuestion(currentQuestionIndex);
  }
  function numericError(input, error, raw) {
    const invalid = Boolean(raw.trim()) && numericValue(raw) === null;
    input.setAttribute("aria-invalid", String(invalid));
    error.hidden = !invalid;
  }
  function renderQuestions() {
    const fragment = document.createDocumentFragment();
    data.questions.forEach((question, index) => {
      const card = element("fieldset", "question-card"), content = element("div", "question-content"), response = element("div", "response-controls");
      card.id = `question-card-${index}`;
      card.tabIndex = -1;
      card.append(element("legend", "question-heading", `Question ${questionLabel(question)}`));
      const type = questionType(question), kind = type === "nat" ? "Numerical answer" : type === "msq" ? "Select all correct options (exact set; no partial credit)" : "Choose one option";
      content.append(element("p", "question-meta", `${kind} · ${marks(question).correct} ${marks(question).correct === 1 ? "mark" : "marks"}`));
      if (question.requiresCorrect) {
        const prerequisite = data.questions.find((item) => item.id === question.requiresCorrect);
        content.append(element("p", "response-help", `Evaluated only if question ${questionLabel(prerequisite)} is correct. No negative marking for this question.`));
      }
      if (question.text.trim()) content.append(element("p", "question-text", question.text));
      addImages(content, question, `Question ${questionLabel(question)} and its original options`);
      if (type === "nat") {
        const input = element("input", "numeric-answer"), label = element("label", "numeric-label", "Your numerical answer");
        input.type = "text";
        input.inputMode = "decimal";
        input.autocomplete = "off";
        input.spellcheck = false;
        input.id = `answer-${index}`;
        input.name = question.id;
        input.value = answers[question.id] ?? "";
        label.htmlFor = input.id;
        const help = element("p", "response-help", "Use a decimal point if needed, for example 12 or -0.25. Leave blank to skip.");
        const error = element("p", "numeric-error", "Enter a decimal number without commas, fractions, letters or scientific notation.");
        error.id = `error-${index}`;
        error.setAttribute("role", "alert");
        input.setAttribute("aria-describedby", error.id);
        numericError(input, error, input.value);
        input.addEventListener("input", () => {
          if (serverBusy) return;
          if (input.value.trim()) answers[question.id] = input.value;
          else delete answers[question.id];
          numericError(input, error, input.value);
          updateProgress();
          save();
        });
        response.append(label, input, help, error);
      } else {
        const options = element("div", "options");
        question.options.forEach((option, optionIndex) => {
          const label = element("label", "option"), input = element("input"), text = element("span", "option-text", option.text);
          input.type = type === "msq" ? "checkbox" : "radio";
          input.name = `question-${index}`;
          input.id = `answer-${index}-${optionIndex}`;
          input.value = option.id;
          input.checked = type === "msq" ? (answers[question.id] || []).includes(option.id) : answers[question.id] === option.id;
          label.classList.toggle("selected", input.checked);
          addImages(text, option, `Option ${option.id} for ${questionLabel(question)}`);
          label.append(input, element("span", "option-letter", `${option.id}.`), text);
          input.addEventListener("change", () => {
            if (serverBusy) return;
              const selected = type === "msq" ? Array.from(options.querySelectorAll("input")).filter((item) => item.checked).map((item) => item.value) : option.id;
            if (selected.length) answers[question.id] = selected;
            else delete answers[question.id];
            options.querySelectorAll("label").forEach((item) => item.classList.toggle("selected", item.querySelector("input").checked));
            updateProgress();
            save();
          });
          options.append(label);
        });
        response.append(options);
      }
      const clear = element("button", "button button-secondary clear-response", "Clear response");
      clear.type = "button";
      clear.setAttribute("aria-label", `Clear response for ${questionLabel(question)}`);
      clear.addEventListener("click", () => {
        if (serverBusy) return;
        delete answers[question.id];
        save();
        renderQuestions();
        byId(`question-card-${index}`).focus();
        noteCurrentQuestion(index);
      });
      const actions = element("div", "question-actions"), mark = element("button", "button button-secondary mark-review");
      mark.type = "button";
      mark.id = `mark-review-${index}`;
      mark.addEventListener("click", () => {
        if (serverBusy || submittedAt || reviewState) return;
        if (reviewFlags.has(question.id)) reviewFlags.delete(question.id);
        else reviewFlags.add(question.id);
        updateProgress();
        save();
      });
      actions.append(clear, mark);
      response.append(actions);
      content.append(response);
      card.append(content);
      fragment.append(card);
    });
    byId("questions").replaceChildren(fragment);
    renderNavigator();
    updateProgress();
    setControls();
  }
  function plainAnswer(question, answer, official = false) {
    if (official && (question.marksToAll || questionType(question) !== "mcq" || question.acceptedAnswers)) return correctAnswerText(question);
    if (answer === undefined || answer === null) return "Not answered";
    if (questionType(question) === "nat") return answer;
    if (questionType(question) === "msq") return answer.join(" + ");
    const option = question.options.find((item) => item.id === answer);
    return `${option.id}. ${option.text}`;
  }
  function answerLine(label, question, answer, official = false) {
    const line = element("div", "answer-line");
    line.append(element("strong", "", `${label}: `), element("span", "", plainAnswer(question, answer, official)));
    if (questionType(question) === "mcq" && answer && !question.marksToAll && !(official && question.acceptedAnswers)) addImages(line, question.options.find((option) => option.id === answer), `Option ${answer}`);
    return line;
  }
  function renderReport(moveFocus = true) {
    currentQuestionInteraction = null;
    if (moveFocus) setCurrentQuestion(0);
    results = grade();
    const { counts, score, maximum, awardedMarks } = summarize(results);
    byId("report-title").textContent = `${data.title} — result`;
    byId("report-source").textContent = data.source || "";
    byId("report-source").hidden = !data.source;
    byId("score-value").textContent = `${number(score)} / ${number(maximum)}`;
    byId("score-detail").textContent = `${counts.correct} of ${results.length - counts.awarded} scorable questions correct${counts.awarded ? ` · ${number(awardedMarks)} marks awarded to all` : ""} · Submitted ${new Date(submittedAt).toLocaleString()}`;
    const summary = [["Correct", counts.correct], ["Incorrect", counts.incorrect], ["Unanswered", counts.unanswered]];
    if (counts.awarded) summary.push(["Marks to all", counts.awarded]);
    if (counts.blocked) summary.push(["Not evaluated", counts.blocked]);
    byId("report-summary").replaceChildren(...summary.map(([label, count]) => element("div", "summary-item", `${label}: ${count}`)));
    const fragment = document.createDocumentFragment();
    results.forEach(({ question, selected, outcome, earned, reason }, index) => {
      const card = element("article", `result-card ${outcome === "blocked" ? "unanswered" : outcome}`), heading = element("div", "result-heading");
      card.id = `result-card-${index}`;
      card.tabIndex = -1;
      const label = { correct: "Correct", incorrect: "Incorrect", unanswered: "Unanswered", awarded: "Marks to all", blocked: "Not evaluated" }[outcome];
      heading.append(element("h3", "", `Question ${questionLabel(question)}`), element("span", "result-status", `${label} · ${number(earned)} / ${number(marks(question).correct)} marks`));
      card.append(heading);
      if (question.text.trim()) card.append(element("p", "question-text", question.text));
      addImages(card, question, `Question ${questionLabel(question)} and its original options`);
      card.append(answerLine("Your answer", question, selected), answerLine("Correct answer", question, question.correctAnswer, true));
      if (reason) card.append(element("p", "explanation", reason));
      if (question.explanation) card.append(element("p", "explanation", question.explanation));
      fragment.append(card);
    });
    byId("report-list").replaceChildren(fragment);
    byId("quiz-form").hidden = true;
    byId("report").hidden = false;
    byId("quiz-timer").hidden = true;
    updateProgress();
    setControls();
    if (moveFocus) { byId("report-title").focus(); byId("report").scrollIntoView({ block: "start" }); }
    scheduleCurrentQuestion();
  }
  function showAttempt() {
    renderQuestions();
    byId("report").hidden = true;
    byId("quiz-form").hidden = false;
    byId("quiz-timer").hidden = false;
    renderTimer();
    if (submittedAt) renderReport(false);
    else scheduleCurrentQuestion();
  }
  function clearAttempt(moveFocus = true) {
    if (serverBusy) return false;
    Object.keys(answers).forEach((id) => delete answers[id]);
    reviewFlags.clear();
    reportReviewFlags.clear();
    submittedAt = "";
    currentQuestionIndex = 0;
    currentQuestionInteraction = null;
    results = [];
    save();
    showAttempt();
    if (moveFocus) { byId("questions").querySelector("input")?.focus(); byId("quiz-form").scrollIntoView({ block: "start" }); }
    return true;
  }
  function restartAttempt() {
    if (serverBusy || !submittedAt) return false;
    if (reviewState) {
      const current = reviewState;
      reviewState = null;
      restoreState(current);
      currentQuestionIndex = current.currentQuestionIndex ?? 0;
      showAttempt();
      jumpToQuestion(currentQuestionIndex);
      status("Returned to your current quiz.");
      return true;
    }
    clearAttempt();
    if (storageAvailable) status("New attempt started. Progress is cached until Submit.");
    return true;
  }
  function downloadText(contents, filename, type) {
    const url = URL.createObjectURL(new Blob([contents], { type: `${type};charset=utf-8` })), link = element("a");
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function downloadReport() {
    const { counts, score, maximum, awardedMarks } = summarize(results);
    const lines = [data.title, data.source || "", `Submitted: ${new Date(submittedAt).toLocaleString()}`, `Score: ${number(score)} / ${number(maximum)}`, `Correct: ${counts.correct} | Incorrect: ${counts.incorrect} | Unanswered: ${counts.unanswered} | Marks to all: ${counts.awarded} (${number(awardedMarks)} marks)${counts.blocked ? ` | Not evaluated: ${counts.blocked}` : ""}`, ""];
    results.forEach(({ question, outcome, selected, earned, reason }) => {
      lines.push(`Question ${questionLabel(question)}: ${outcome.toUpperCase()} (${number(earned)} / ${number(marks(question).correct)} marks)`, question.text);
      imagesOf(question).forEach((part) => lines.push(`Original question image: ${part.src}${part.page ? ` (PDF page ${part.page})` : ""}`));
      lines.push(`Your answer: ${plainAnswer(question, selected)}`, `Correct answer: ${plainAnswer(question, question.correctAnswer, true)}`);
      if (reason) lines.push(reason);
      question.options?.forEach((option) => imagesOf(option).forEach((part) => lines.push(`Option ${option.id} image: ${part.src}`)));
      if (question.explanation) lines.push(`Explanation: ${question.explanation}`);
      lines.push("");
    });
    downloadText(lines.join("\r\n"), `${data.id.replace(/[^a-z0-9_-]/gi, "-")}-report.txt`, "text/plain");
  }

  try {
    validate();
    document.title = data.title;
    byId("quiz-title").textContent = data.title;
    for (const [id, value] of [["quiz-source", data.source], ["quiz-instructions", data.instructions]]) { byId(id).textContent = value || ""; byId(id).hidden = !value; }
    if (!data.questions.length) { byId("empty-state").hidden = false; byId("review-attempt").hidden = true; byId("review-attempt-wrap").hidden = true; return; }
    const maximum = data.questions.reduce((sum, question) => sum + marks(question).correct, 0);
    byId("quiz-meta").append(element("span", "meta-item", `${data.questions.length} questions · ${number(maximum)} marks`));
    byId("quiz-meta").hidden = false;
    setupStorage();
    setupTimer();
    setupCurrentQuestion();
    byId("quiz-form").addEventListener("submit", submitAttempt);
    byId("review-attempt").addEventListener("click", reviewLastAttempt);
    byId("clear-answers").addEventListener("click", () => clearAttempt());
    byId("retry-quiz").addEventListener("click", restartAttempt);
    byId("download-report").addEventListener("click", downloadReport);
    byId("print-report").addEventListener("click", () => window.print());
    window.addEventListener("beforeunload", (event) => { if (serverBusy) { event.preventDefault(); event.returnValue = ""; } });
    window.addEventListener("pageshow", (event) => { if (event.persisted) { renderTimer(); checkLastAttempt(); } });
    showAttempt();
    checkLastAttempt();
    if (new URL(window.location.href).protocol === "file:") status("Start the quiz server and open http://127.0.0.1:8765 for persistent drafts and automatic result saving.", true);
  } catch (error) {
    byId("quiz-form").hidden = true;
    byId("report").hidden = true;
    byId("question-nav").hidden = true;
    byId("quiz-timer").hidden = true;
    document.querySelector(".quiz-shell").classList.remove("has-navigator");
    status(`Unable to open this quiz. ${error.message}`, true);
  }
})();
