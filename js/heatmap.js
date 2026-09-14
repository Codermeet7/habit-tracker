/* heatmap.js
   Date utilities + the pure "CSS grid of colored squares" heatmap renderer.

   The calendar is a fixed 13-column x 7-row grid (one column per week,
   one row per weekday) that ends on today. Each cell:
     - gets a title tooltip showing the date,
     - gets a data-level attribute (0 = no data, 1 = light, 2 = medium,
       3 = dark) that style.css turns into a color.
   Dark teal = completed (3+ log entries), light gray = missed, very light
   = no data yet. No external libraries are used.
*/
"use strict";

const WEEKDAY_HEADERS = ["M", "T", "W", "T", "F", "S", "S"];
const MONTH_ABBREVS = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun",
                       "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

/* "2026-09-11" (local time, zero-padded). Used as the map key for a day. */
function localDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/* Inverse of localDateKey: "2026-09-11" -> a local Date at noon.
   Noon (not midnight) sidesteps daylight-saving boundary glitches. */
function keyToDate(key) {
  const [y, m, d] = String(key).split("-").map(Number);
  return new Date(y, m - 1, d, 12);
}

/* Streaks, computed purely from the check-in day list.
   - current: consecutive days ending today (or yesterday, so a missed
     today doesn't kill a streak until the day actually rolls over).
   - longest: the best run anywhere in the history. */
function calculateStreaks(checkinKeys, today = new Date()) {
  const set = new Set(checkinKeys.map(localDateKey));
  const todayKey = localDateKey(today);

  let current = 0;
  let cursor = keyToDate(todayKey);
  if (!set.has(todayKey)) {
    // Nothing today: fall back to "ended yesterday" so a fresh morning
    // doesn't immediately reset a great run.
    if (!set.has(localDateKey(new Date(cursor.getTime() - DAY_MS)))) {
      return { current: 0, longest: 0 };
    }
    cursor = new Date(cursor.getTime() - DAY_MS);
  }
  while (set.has(localDateKey(cursor))) {
    current += 1;
    cursor = new Date(cursor.getTime() - DAY_MS);
  }

  let longest = 0;
  let run = 0;
  let previous = null;
  [...set]
    .filter((key) => key <= todayKey)
    .sort()
    .forEach((key) => {
      const gap = previous ? keyToDate(key).getTime() - keyToDate(previous).getTime() : DAY_MS;
      run = gap === DAY_MS ? run + 1 : 1;
      longest = Math.max(longest, run);
      previous = key;
    });

  return { current, longest };
}

/* Normalize whatever the server returns for check-ins into an array of
   "YYYY-MM-DD" strings. Handles:
     [ "2026-09-11" ], [ {date: "2026-09-11"} ], { checkins: [...] } etc. */
function normalizeCheckinDates(checkins, checkinKey) {
  if (!Array.isArray(checkins)) {
    if (checkins && typeof checkins === "object") {
      checkins = checkins.checkins ?? checkins.dates ?? checkins.days;
    }
    if (!Array.isArray(checkins)) return [];
  }
  const pick = typeof checkinKey === "function"
    ? checkinKey
    : (entry) => entry.date || entry.checkin_date || entry.day || entry["date"];
  return checkins
    .map((entry) => (typeof entry === "string" ? entry : pick(entry) || ""))
    .map((value) => String(value).slice(0, 10)) // "2026-09-11T.." -> "2026-09-11"
    .filter((key) => /^\d{4}-\d{2}-\d{2}$/.test(key));
}

/* Count how many log entries map to each day (drives the color scale). */
function buildHeatmapMap(checkinKeys) {
  const map = Object.create(null);
  checkinKeys.forEach((key) => { map[key] = (map[key] || 0) + 1; });
  return map;
}

/* Render the 13x7 grid into the card's .heatmap-calendar container.
   - container: the .habit-card element (the function finds its calendar).
   - today:     Date used to anchor the 13-week window.
   - checkins:  raw value from GET /api/habits/:id/checkins.
   - checkinKey: optional fn that extracts the date string from a record. */
function renderHeatmap(container, { today = new Date(), checkins = [], checkinKey } = {}) {
  const calendar = container.querySelector(".heatmap-calendar") || container;
  const monthRow = calendar.querySelector(".heatmap-months");
  const dayLabels = calendar.querySelector(".heatmap-day-labels");
  const grid = calendar.querySelector(".heatmap-grid");
  if (!grid || !monthRow) return;

  const normalized = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 12);
  const totalDays = 13 * 7;
  const start = new Date(normalized.getTime() - (totalDays - 1) * DAY_MS);
  const todayKey = localDateKey(normalized);
  const map = buildHeatmapMap(normalizeCheckinDates(checkins, checkinKey));

  // --- Month band: one label per month, merged across repeated weeks. ---
  const monthSpans = [];
  let current = null;
  for (let col = 0; col < 13; col++) {
    const month = new Date(start.getTime() + col * WEEK_MS).getMonth();
    if (!current || month !== current.month) {
      current = { month, label: MONTH_ABBREVS[month], startCol: col, endCol: col };
      monthSpans.push(current);
    } else {
      current.endCol = col;
    }
  }
  monthRow.replaceChildren(
    ...monthSpans.map((span) => {
      const el = document.createElement("span");
      el.style.gridColumn = `${span.startCol + 1} / ${span.endCol + 2}`;
      el.textContent = span.label;
      return el;
    })
  );

  // --- Weekday column: Mon..Sun labels. ---
  dayLabels.replaceChildren(
    ...WEEKDAY_HEADERS.map((label) => {
      const el = document.createElement("span");
      el.textContent = label;
      return el;
    })
  );

  // --- The grid itself: one colored square per day, oldest at the top left. ---
  grid.replaceChildren();
  for (let index = 0; index < totalDays; index++) {
    const date = new Date(start.getTime() + index * DAY_MS);
    const key = localDateKey(date);
    const level = map[key] || 0;

    const cell = document.createElement("div");
    cell.className = "heatmap-cell";
    cell.setAttribute("data-level", String(level));
    cell.title = key; // Native tooltip with the date.
    cell.setAttribute(
      "aria-label",
      `${key} — ${level ? `${level} check-in${level > 1 ? "s" : ""}` : "no data"}`
    );
    if (key === todayKey) cell.classList.add("is-today");
    grid.appendChild(cell);
  }

  // Preserve the user's horizontal scroll position across re-renders.
  const scrollBox = calendar.closest(".heatmap-scroll");
  if (scrollBox) {
    const ratio = scrollBox.scrollLeft / (Math.max(1, scrollBox.scrollWidth - scrollBox.clientWidth));
    requestAnimationFrame(() => {
      scrollBox.scrollLeft = ratio * (scrollBox.scrollWidth - scrollBox.clientWidth);
    });
  }
}

window.Heatmap = {
  localDateKey,
  keyToDate,
  calculateStreaks,
  normalizeCheckinDates,
  renderHeatmap,
};