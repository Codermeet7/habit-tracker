/* dashboard.js
   Powers dashboard.html:
     - loads habits            GET    /api/habits
     - adds a habit            POST   /api/habits
     - deletes a habit         DELETE /api/habits/:id
     - marks today done        POST   /api/habits/:id/checkin
     - loads check-in history  GET    /api/habits/:id/checkins

   Flexible about API shapes — plain arrays and wrapped objects both work:
     GET  /api/habits              -> [ {id, name, category} ] or {habits: [...]}
     GET  /api/habits/:id/checkins -> [ "2026-09-11" ] or {checkins: [...]}
   This file must load AFTER heatmap.js (it uses window.Heatmap).
*/
"use strict";

// Namespace the shared helpers instead of importing them by name: heatmap.js
// already declares those names at the top level, so destructuring them here
// with `const` would throw "already been declared" in strict mode.
const Heatmap = window.Heatmap;

/* Accent colors cycled across cards so adjacent habits are easy to tell apart. */
const PALETTE = [
  { name: "teal",   color: "#3e7a5c", background: "#eef4e8" },
  { name: "violet", color: "#8d77a6", background: "#f1edf7" },
  { name: "gold",   color: "#ac8944", background: "#faf2df" },
  { name: "blue",   color: "#638caa", background: "#ebf2f6" },
];

const state = {
  habits: [],                 // { id, name, category, colorIndex, hydrated, streaks? }
  checkedToday: new Set(),    // habit ids (as strings) already logged for today
  deleteTarget: null,         // id waiting for delete confirmation
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHTML = (value) => String(value).replace(/[&<>"']/g, (ch) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[ch]);
const strip = (value) => String(value).trim();
const idStr = (id) => String(id);
const pathId = (id) => encodeURIComponent(idStr(id));

async function requestJSON(url, options = {}) {
  const response = await Promise.race([
    fetch(url, {
    method: options.method || "GET",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("request-timeout")), 10000)),
  ]);

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  // Mid-session 401/403 = the cookie expired or was cleared. Go sign in again.
  if ((response.status === 401 || response.status === 403)
      && document.body.dataset.page === "dashboard") {
    window.location.replace("index.html");
    throw new Error("session-expired");
  }

  if (!response.ok) {
    const firstError = Array.isArray(data?.error) ? data.error[0] : data?.error;
    const message = typeof firstError === "string"
      ? firstError
      : firstError?.msg || `Server error: ${response.status}`;
    throw new Error(message);
  }
  return data;
}

/* Accept either a bare array or a { habits: [...] } style wrapper. */
function unwrapHabits(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.habits)) return payload.habits;
  if (payload && Array.isArray(payload.items)) return payload.items;
  return [];
}

/* --- Toast notifications -------------------------------------------------- */
let toastTimer = null;
function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; toastTimer = null; }, 2400);
}

function showDashboardError(message) {
  $("#dashboard-error-text").textContent = message;
  $("#dashboard-error").hidden = false;
}

function hideDashboardError() {
  $("#dashboard-error").hidden = true;
}

/* --- Loading / empty-state ------------------------------------------------ */
function setLoading(loading) {
  $("#habits-loading").hidden = !loading;
  $("#habits-grid").hidden = loading;
  $("#add-habit-button").disabled = loading;
  $("#empty-add-button").disabled = loading;
}

function renderEmptyState() {
  $("#habits-loading").hidden = true;
  $("#habits-grid").hidden = true;
  $("#empty-state").hidden = false;
  $("#habit-total").textContent = "0";
  $("#habit-count").textContent = "0";
  $("#best-streak").textContent = "—";
  $("#today-progress").textContent = "—";
  $("#progress-percent").textContent = "—";
}

/* --- Summary stats (top cards + header counts + progress ring) ------------ */
function updateStats() {
  const completed = state.checkedToday.size;
  const total = state.habits.length;

  $("#today-progress").innerHTML = `${completed}<small>of ${total} done</small>`;
  $("#today-caption").textContent =
    total === 0 ? "Add your first habit to begin"
    : completed === 0 ? "A fresh start — do one little thing"
    : completed === total ? "All habits done. Nice work."
    : "Keep gently building momentum";
  $("#habit-total").textContent = String(total);
  $("#habit-count").textContent = String(total);

  const percent = total === 0 ? 0 : Math.round((completed / total) * 100);
  const ring = $("#progress-ring");
  ring.style.setProperty("--progress", `${percent}%`);
  ring.setAttribute("aria-valuenow", String(percent));
  $("#progress-percent").textContent = `${percent}%`;

  let best = 0;
  state.habits.forEach((habit) => {
    if (habit.streaks) best = Math.max(best, habit.streaks.current);
  });
  $("#best-streak").textContent = String(best);
}

/* --- Habit cards ---------------------------------------------------------- */
function buildCardElement(habit) {
  const palette = PALETTE[habit.colorIndex % PALETTE.length];
  const id = idStr(habit.id);
  const category = strip(habit.category || "");

  const wrapper = document.createElement("div");
  wrapper.innerHTML = `
  <article class="habit-card" data-habit-id="${id}">
    <div class="habit-card-header">
      <span class="habit-icon" aria-hidden="true"></span>
      <div class="habit-title-group">
        <h3>${escapeHTML(habit.name)}</h3>
        ${category ? `<span class="category-tag">${escapeHTML(category)}</span>` : ""}
      </div>
      <button class="icon-button delete-habit" type="button"
        data-delete="${id}" aria-label="Delete habit ${escapeHTML(habit.name)}">
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 9h12M15 6v12M21 6v12"/></svg>
      </button>
    </div>
    <div class="streak-row">
      <div class="streak-item">
        <span class="streak-label"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M15 4c-3 5 3 5 4-1 7 2 7 3 4-2 3-4 1-1 4 1 3 5 4 4 3 2 5-4 5 3-1-5 2 7 4-2 5 1 8"/></svg>Current streak</span>
        <span class="streak-number">—</span>
      </div>
      <div class="streak-item">
        <span class="streak-label">Best streak</span>
        <span class="streak-number">—</span>
      </div>
    </div>
    <div class="heatmap-section">
      <div class="heatmap-heading"><strong>Last 13 weeks</strong><span>Hover a square for its date</span></div>
      <div class="heatmap-scroll">
        <div class="heatmap-calendar">
          <div class="heatmap-months" aria-hidden="true"></div>
          <div class="heatmap-day-labels" aria-hidden="true"></div>
          <div class="heatmap-grid" role="img" aria-label="Check-in history for the last 13 weeks"></div>
        </div>
      </div>
      <div class="heatmap-legend">
        <div class="legend-items">
          <span class="legend-square" data-level="0"></span>No data
          <span class="legend-square" data-level="1"></span>Light
          <span class="legend-square" data-level="2"></span>Regular
          <span class="legend-square" data-level="3"></span>Consistent
        </div>
      </div>
    </div>
    <button class="button checkin-button" type="button" data-checkin="${id}">
      <span data-checkin-label>Mark done today</span>
    </button>
    <p class="card-error" hidden></p>
  </article>`;
  const card = wrapper.firstElementChild;

  // Give the icon the palette color (teal | violet | gold | blue).
  const icon = $(".habit-icon", card);
  icon.style.color = palette.color;
  icon.style.background = palette.background;
  return card;
}

function updateCheckinButton(card, habit) {
  const done = state.checkedToday.has(idStr(habit.id));
  const button = $(".checkin-button", card);
  button.classList.toggle("is-done", done);
  button.disabled = done;
  const label = $("[data-checkin-label]", button);
  if (label) label.textContent = done ? "Done today ✓" : "Mark done today";
}

function renderCardError(card, message) {
  const error = $(".card-error", card);
  error.textContent = message;
  error.hidden = false;
  setTimeout(() => { error.hidden = true; }, 3500);
}

/* Fetch a habit's check-in history, then fill in streaks + heatmap.
   Returns a promise so the render queue can chain to the next habit. */
function hydrateHabit(card, habit, retry = false) {
  const grid = $(".heatmap-grid", card);
  grid.setAttribute("aria-label", `Loading check-in history for ${habit.name}…`);

  return requestJSON(`/api/habits/${pathId(habit.id)}/checkins`)
    .then((payload) => {
      const checkinKeys = Heatmap.normalizeCheckinDates(payload);
      habit.checkinKeys = checkinKeys; // Keep for live updates after a check-in.

      // Streaks from the full history (even if GET /api/habits
      // doesn't include them).
      habit.streaks = Heatmap.calculateStreaks(checkinKeys);
      const [currentStreak, bestStreak] = $$(".streak-number", card);
      currentStreak.textContent = `${habit.streaks.current} days`;
      bestStreak.textContent = `${habit.streaks.longest} days`;

      grid.setAttribute("aria-label", "Check-in history for the last 13 weeks");
      Heatmap.renderHeatmap(card, { checkins: checkinKeys });
      updateCheckinButton(card, habit);
      updateStats();
      habit.hydrated = true;
    })
    .catch((err) => {
      if (err.message === "session-expired") return;
      // Small retry: the server may have blinked the first time.
      if (!retry) {
        setTimeout(() => hydrateHabit(card, habit, true), 500);
        return;
      }
      renderCardError(card, "Couldn’t load history right now.");
      const fallback = document.createElement("div");
      fallback.className = "history-error";
      fallback.textContent = "History unavailable at the moment.";
      $(".heatmap-scroll", card).replaceChildren(fallback);
    });
}

function renderHabitList() {
  const grid = $("#habits-grid");
  grid.replaceChildren(...state.habits.map(buildCardElement));

  // Hydrate hearts sequentially (one in-flight check-in fetch at a time).
  // Parallel fetches can stall when several hit the network at once on a
  // freshly loaded page, so a small queue is far more reliable.
  const queue = [...state.habits];
  const next = () => {
    const habit = queue.shift();
    if (!habit) return;
    const card = $$(".habit-card", grid).find((el) => el.dataset.habitId === idStr(habit.id));
    if (card) {
      hydrateHabit(card, habit).finally(next);
    } else {
      next();
    }
  };
  next();
}

/* --- Check-in for today ---------------------------------------------------- */
function checkin(habit) {
  const card = $$(".habit-card", $("#habits-grid"))
    .find((el) => el.dataset.habitId === idStr(habit.id));
  if (!card) return;

  const button = $(".checkin-button", card);
  state.checkedToday.add(idStr(habit.id)); // Optimistic: update the UI now.
  button.disabled = true;
  button.classList.add("is-done");
  $("[data-checkin-label]", button).textContent = "Saving…";

  requestJSON(`/api/habits/${pathId(habit.id)}/checkin`, { method: "POST" })
    .then(() => {
      $("[data-checkin-label]", button).textContent = "Done today ✓";
      // Live-update this habit: color today's cell and refresh the streaks.
      if (habit.checkinKeys) {
        habit.checkinKeys.push(Heatmap.localDateKey(new Date()));
        habit.streaks = Heatmap.calculateStreaks(habit.checkinKeys);
        const [currentStreak, bestStreak] = $$(".streak-number", card);
        currentStreak.textContent = `${habit.streaks.current} days`;
        bestStreak.textContent = `${habit.streaks.longest} days`;
        Heatmap.renderHeatmap(card, { checkins: habit.checkinKeys });
      }
      updateStats();
      showToast("Nice — logged for today.");
    })
    .catch((err) => {
      if (err.message === "session-expired") return;
      state.checkedToday.delete(idStr(habit.id)); // Roll the button back.
      updateCheckinButton(card, habit);
      updateStats();
      renderCardError(card, err.message || "Couldn’t save your check-in just now.");
    });
}

/* --- Add habit ------------------------------------------------------------- */
function openAddDialog() {
  const dialog = $("#habit-dialog");
  $("#habit-form-error").hidden = true;
  $("#habit-name").value = "";
  $("#habit-category").value = "";
  dialog.showModal();
  setTimeout(() => $("#habit-name").focus(), 30); // After the native dialog opens.
}

function submitHabit(form) {
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  $("[data-button-label]", button).textContent = "Adding…";
  $(".spinner", button).hidden = false;

  const body = {
    name: strip($("#habit-name").value),
    category: strip($("#habit-category").value),
  };

  requestJSON("/api/habits", { method: "POST", body })
    .then((payload) => {
      const created = unwrapHabits(payload)[0] || payload;
      state.habits.push({
        id: created.id,
        name: created.name ?? body.name,
        category: created.category ?? body.category,
        colorIndex: state.habits.length % PALETTE.length,
        hydrated: false,
      });
      $("#habit-dialog").close();
      renderHabitList();
      updateStats();
      showToast("Habit added — great start!");
    })
    .catch((err) => {
      if (err.message === "session-expired") return;
      $("#habit-form-error").textContent = err.message || "We couldn’t add that habit right now.";
      $("#habit-form-error").hidden = false;
      button.disabled = false;
      $("[data-button-label]", button).textContent = "Add habit";
      $(".spinner", button).hidden = true;
    });
}

/* --- Delete habit ---------------------------------------------------------- */
function confirmDelete() {
  const id = state.deleteTarget;
  if (id == null) return;
  $("#confirm-delete").disabled = true;
  $("[data-button-label]", $("#confirm-delete")).textContent = "Deleting…";
  $("#delete-error").hidden = true;

  requestJSON(`/api/habits/${pathId(id)}`, { method: "DELETE" })
    .then(() => {
      state.habits = state.habits.filter((habit) => idStr(habit.id) !== idStr(id));
      state.checkedToday.delete(idStr(id));
      $("#delete-dialog").close();
      state.deleteTarget = null;
      if (state.habits.length === 0) {
        renderEmptyState();
        $("#empty-add-button").disabled = false;
      } else {
        renderHabitList();
        updateStats();
      }
      showToast("Habit removed.");
    })
    .catch((err) => {
      if (err.message === "session-expired") return;
      $("#delete-error").textContent = err.message || "We couldn’t remove it right now.";
      $("#delete-error").hidden = false;
      $("#confirm-delete").disabled = false;
      $("[data-button-label]", $("#confirm-delete")).textContent = "Delete habit";
    });
}

/* --- Loading habits (initial + retry) -------------------------------------- */
async function loadHabits() {
  hideDashboardError();
  setLoading(true);
  try {
    const payload = await requestJSON("/api/habits");
    state.habits = unwrapHabits(payload).map((item, index) => ({
      ...item,
      colorIndex: index % PALETTE.length,
      hydrated: false,
    }));
    setLoading(false);
    $("#empty-add-button").disabled = false;
    if (state.habits.length === 0) {
      renderEmptyState();
      return;
    }
    $("#empty-state").hidden = true; // Only show the empty state when there's nothing to track.
    renderHabitList();
    updateStats();
  } catch (err) {
    if (err.message === "session-expired") return;
    setLoading(false);
    showDashboardError("We couldn’t load your habits. Check your connection and try again.");
  }
}

/* --- Event wiring ---------------------------------------------------------- */
function initDashboard() {
  $("#today-date").textContent = new Intl.DateTimeFormat("en-US", {
    weekday: "long", month: "long", day: "numeric",
  }).format(new Date());

  $("#add-habit-button").addEventListener("click", openAddDialog);
  $("#empty-add-button").addEventListener("click", openAddDialog);
  $("#close-habit-dialog").addEventListener("click", () => $("#habit-dialog").close());
  $("#cancel-habit-dialog").addEventListener("click", () => $("#habit-dialog").close());
  $("#habit-form").addEventListener("submit", (event) => {
    event.preventDefault();
    submitHabit(event.currentTarget);
  });
  $("#retry-load").addEventListener("click", loadHabits);
  $("#cancel-delete").addEventListener("click", () => $("#delete-dialog").close());
  $("#confirm-delete").addEventListener("click", confirmDelete);

  // One delegated listener on the habit grid handles every card's buttons.
  $("#habits-grid").addEventListener("click", (event) => {
    const card = event.target.closest(".habit-card");
    if (!card) return;

    const checkinButton = event.target.closest("[data-checkin]");
    if (checkinButton) {
      const habit = state.habits.find((h) => idStr(h.id) === checkinButton.dataset.checkin);
      if (habit && !state.checkedToday.has(idStr(habit.id))) checkin(habit);
      return;
    }

    const deleteButton = event.target.closest("[data-delete]");
    if (deleteButton) {
      state.deleteTarget = deleteButton.dataset.delete;
      const habit = state.habits.find((h) => idStr(h.id) === idStr(state.deleteTarget));
      $("#delete-description").innerHTML =
        `“<strong>${escapeHTML(habit?.name || "This habit")}</strong>” will be removed for good, ` +
        `along with its history.`;
      $("#delete-dialog").showModal();
    }
  });

  loadHabits();
}

initDashboard();