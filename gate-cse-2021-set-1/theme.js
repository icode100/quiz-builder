(() => {
  "use strict";
  const root = document.documentElement;
  const storageKey = "practice-quiz:theme";
  const preference = window.matchMedia("(prefers-color-scheme: dark)");
  let selectedTheme = null;
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved === "dark" || saved === "light") selectedTheme = saved;
  } catch { /* Theme switching still works when browser storage is unavailable. */ }

  function applyTheme(theme) {
    root.dataset.theme = theme;
    const button = document.getElementById("theme-toggle");
    if (button) {
      button.textContent = theme === "dark" ? "Light mode" : "Dark mode";
      button.setAttribute("aria-pressed", String(theme === "dark"));
      button.setAttribute("aria-label", `Switch to ${theme === "dark" ? "light" : "dark"} mode`);
    }
  }

  applyTheme(selectedTheme || (preference.matches ? "dark" : "light"));
  document.addEventListener("DOMContentLoaded", () => {
    applyTheme(root.dataset.theme);
    document.getElementById("theme-toggle")?.addEventListener("click", () => {
      selectedTheme = root.dataset.theme === "dark" ? "light" : "dark";
      applyTheme(selectedTheme);
      try { localStorage.setItem(storageKey, selectedTheme); } catch { /* Optional preference storage. */ }
    });
  });
  preference.addEventListener("change", () => {
    if (!selectedTheme) applyTheme(preference.matches ? "dark" : "light");
  });
})();
