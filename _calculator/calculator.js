(() => {
  "use strict";

  const expression = document.getElementById("expression");
  const result = document.getElementById("result");
  const status = document.getElementById("calculation-status");
  const memoryIndicator = document.getElementById("memory-indicator");
  const moreButton = document.getElementById("more-functions");
  const functionButtons = Array.from(document.querySelectorAll("[data-more-label]"));
  let angleMode = "DEG";
  let ans = 0;
  let memory = 0;
  let more = false;
  let justEvaluated = false;
  let selectionStart = 0;
  let selectionEnd = 0;

  function rememberSelection() {
    selectionStart = expression.selectionStart ?? expression.value.length;
    selectionEnd = expression.selectionEnd ?? selectionStart;
  }

  function showStatus(message, isError = false) {
    status.textContent = message;
    status.classList.toggle("error", isError);
    expression.setAttribute("aria-invalid", String(isError));
  }

  function ready() {
    showStatus(`Ready · ${angleMode === "DEG" ? "degrees" : "radians"}`);
  }

  function display(value) {
    return Object.is(value, -0) ? "0" : String(value);
  }

  function insert(text, isFunction = false) {
    let start = selectionStart;
    let end = selectionEnd;
    if (justEvaluated && start === end) {
      if (/^[+*/^!%-]/.test(text) && !isFunction) {
        expression.value = "ans";
        start = end = 3;
      } else {
        expression.value = "";
        start = end = 0;
      }
    }
    const selected = expression.value.slice(start, end);
    let replacement = text;
    let cursorOffset = text.length;
    if (isFunction) {
      replacement = `${text}(${selected})`;
      cursorOffset = selected ? replacement.length : text.length + 1;
    } else if (text === ")" && !selected && expression.value[start] === ")") {
      expression.focus({ preventScroll: true });
      expression.setSelectionRange(start + 1, start + 1);
      rememberSelection();
      return;
    }
    if (expression.value.length - (end - start) + replacement.length > expression.maxLength) {
      showStatus("Expression is too long. Clear some text and try again.", true);
      return;
    }
    expression.setRangeText(replacement, start, end, "end");
    expression.focus({ preventScroll: true });
    expression.setSelectionRange(start + cursorOffset, start + cursorOffset);
    rememberSelection();
    justEvaluated = false;
    ready();
  }

  function currentValue() {
    if (justEvaluated || !expression.value.trim()) return ans;
    const value = window.QuizCalculatorEngine.evaluate(expression.value, { angleMode, ans, memory });
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error("The result must be a finite real number.");
    }
    return value;
  }

  function calculate() {
    if (!expression.value.trim()) {
      showStatus("Enter an expression first.", true);
      expression.focus({ preventScroll: true });
      return;
    }
    try {
      ans = currentValue();
      result.textContent = display(ans);
      result.title = display(ans);
      showStatus(`Result: ${display(ans)} · ${angleMode === "DEG" ? "degrees" : "radians"}`);
      justEvaluated = true;
    } catch (error) {
      showStatus(error instanceof Error ? error.message : "Check the expression and try again.", true);
      justEvaluated = false;
      expression.focus({ preventScroll: true });
    }
  }

  function updateMemory() {
    memoryIndicator.textContent = `M: ${display(memory)}`;
    memoryIndicator.title = `Memory: ${display(memory)}`;
    memoryIndicator.setAttribute("aria-label", `Memory: ${display(memory)}`);
  }

  function changeMemory(direction) {
    try {
      const next = memory + direction * currentValue();
      if (!Number.isFinite(next)) throw new Error("Memory result is outside the supported range.");
      memory = next;
      updateMemory();
      showStatus(`Memory: ${display(memory)}`);
    } catch (error) {
      showStatus(error instanceof Error ? error.message : "Check the expression before changing memory.", true);
    }
  }

  function deleteAtCursor() {
    let start = selectionStart;
    const end = selectionEnd;
    if (start === end) start = Math.max(0, start - 1);
    expression.setRangeText("", start, end, "end");
    expression.focus({ preventScroll: true });
    rememberSelection();
    justEvaluated = false;
    ready();
  }

  function negate() {
    const hasSelection = selectionStart !== selectionEnd;
    const start = hasSelection ? selectionStart : 0;
    const end = hasSelection ? selectionEnd : expression.value.length;
    const selected = justEvaluated && !hasSelection ? "ans" : expression.value.slice(start, end);
    if (!selected) {
      insert("-");
      return;
    }
    const replacement = `-(${selected})`;
    if (expression.value.length - (end - start) + replacement.length > expression.maxLength) {
      showStatus("Expression is too long. Clear some text and try again.", true);
      return;
    }
    expression.setRangeText(replacement, start, end, "end");
    expression.focus({ preventScroll: true });
    rememberSelection();
    justEvaluated = false;
    ready();
  }

  function reciprocal() {
    const hasSelection = selectionStart !== selectionEnd;
    const start = hasSelection ? selectionStart : 0;
    const end = hasSelection ? selectionEnd : expression.value.length;
    const selected = justEvaluated && !hasSelection ? "ans" : (expression.value.slice(start, end) || "ans");
    const replacement = `1/(${selected})`;
    if (expression.value.length - (end - start) + replacement.length > expression.maxLength) {
      showStatus("Expression is too long. Clear some text and try again.", true);
      return;
    }
    expression.setRangeText(replacement, start, end, "end");
    expression.focus({ preventScroll: true });
    rememberSelection();
    justEvaluated = false;
    ready();
  }

  function toggleMore() {
    more = !more;
    for (const button of functionButtons) {
      if (!button.dataset.basicLabel) {
        button.dataset.basicLabel = button.textContent;
        button.dataset.basicAria = button.getAttribute("aria-label") || button.textContent;
        button.dataset.basicTitle = button.getAttribute("title") || "";
      }
      button.textContent = more ? button.dataset.moreLabel : button.dataset.basicLabel;
      button.setAttribute("aria-label", more ? (button.dataset.moreFunction || button.dataset.moreLabel) : button.dataset.basicAria);
      button.title = more ? (button.dataset.moreFunction || button.dataset.moreLabel) : button.dataset.basicTitle;
    }
    moreButton.textContent = more ? "Basic" : "More";
    moreButton.setAttribute("aria-pressed", String(more));
    moreButton.title = more ? "Show basic scientific functions" : "Show more scientific functions";
  }

  const actions = {
    evaluate: calculate,
    delete: deleteAtCursor,
    clear() {
      expression.value = "";
      result.textContent = "0";
      result.removeAttribute("title");
      justEvaluated = false;
      expression.focus({ preventScroll: true });
      rememberSelection();
      ready();
    },
    sign: negate,
    reciprocal,
    more: toggleMore,
    "memory-clear"() {
      memory = 0;
      updateMemory();
      showStatus("Memory cleared.");
    },
    "memory-recall"() { insert(memory < 0 ? `(${display(memory)})` : display(memory)); },
    "memory-add"() { changeMemory(1); },
    "memory-subtract"() { changeMemory(-1); }
  };

  document.addEventListener("pointerdown", (event) => {
    if (event.target.closest("button") && document.activeElement === expression) {
      rememberSelection();
    }
  });

  document.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    if (button.dataset.angle) {
      angleMode = button.dataset.angle;
      for (const choice of document.querySelectorAll("[data-angle]")) {
        choice.setAttribute("aria-pressed", String(choice.dataset.angle === angleMode));
      }
      justEvaluated = false;
      ready();
      return;
    }
    if (button.dataset.action) {
      actions[button.dataset.action]?.();
      return;
    }
    if (more && button.dataset.moreAction) {
      actions[button.dataset.moreAction]?.();
      return;
    }
    const functionName = more && button.dataset.moreFunction ? button.dataset.moreFunction : button.dataset.function;
    const text = more && button.dataset.moreInsert !== undefined ? button.dataset.moreInsert : button.dataset.insert;
    if (more && button.dataset.moreInsert !== undefined) insert(text);
    else if (functionName) insert(functionName, true);
    else if (text !== undefined) insert(text);
  });

  expression.addEventListener("input", () => {
    justEvaluated = false;
    rememberSelection();
    ready();
  });
  for (const event of ["select", "click", "keyup", "blur"]) {
    expression.addEventListener(event, rememberSelection);
  }
  expression.addEventListener("keydown", (event) => {
    if ((event.key === "Enter" || event.key === "=") && !event.isComposing) {
      event.preventDefault();
      calculate();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && window.parent !== window) {
      event.preventDefault();
      window.parent.postMessage({ type: "quiz-calculator-close" }, window.location.origin);
    }
  });
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent || event.origin !== window.location.origin) return;
    if (event.data?.type === "quiz-calculator-theme" && ["light", "dark"].includes(event.data.theme)) {
      document.documentElement.dataset.theme = event.data.theme;
    } else if (event.data?.type === "quiz-calculator-focus") {
      expression.focus({ preventScroll: true });
    }
  });
})();
