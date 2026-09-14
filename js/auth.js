/* auth.js
   Shared session helpers + login / signup page logic.

   No tokens are stored in localStorage or sessionStorage on purpose.
   Session state lives ONLY in the browser's session cookie, which is set
   by the Flask backend's Set-Cookie header (HttpOnly + SameSite=Lax).

   Pages that include this file:
     - index.html    (login)    -> <body data-page="login">
     - signup.html   (signup)   -> <body data-page="signup">
     - dashboard.html (logout)  -> <body data-page="dashboard">
*/
"use strict";

const API = {
  signup: "/api/signup",
  login: "/api/login",
  logout: "/api/logout",
};

/* Send every request with credentials = "same-origin" so the browser
   automatically attaches the session cookie (no manual handling needed).
   All URLs are relative, keeping us on the same origin as the Flask app. */
async function requestJSON(url, options = {}) {
  const response = await fetch(url, {
    method: options.method || "GET",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  // Read the body once and try to parse it as JSON (the server may send a
  // plain-text error message instead — that's fine, we fall back gracefully).
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  // A 401/403 mid-session means the cookie expired — return to the login page.
  if ((response.status === 401 || response.status === 403)
      && document.body.dataset.page === "dashboard") {
    window.location.replace("index.html");
    throw new Error("session-expired");
  }

  if (!response.ok) {
    // Accept {error: "message"}, {error: ["message"]} and {error: {msg}}.
    const firstError = Array.isArray(data?.error) ? data.error[0] : data?.error;
    const message = typeof firstError === "string"
      ? firstError
      : firstError?.msg || `Server error: ${response.status}`;
    throw new Error(message);
  }
  return data;
}

/* If a logged-in visitor lands on the login/signup pages, send them along.
   We probe with POST /api/login; a success response means the cookie is valid. */
function guardIfLoggedIn() {
  requestJSON(API.login, { method: "POST" })
    .then(() => { window.location.replace("dashboard.html"); })
    .catch(() => { /* Not logged in — stay on the form. */ });
}

/* Wire up the show/hide "eye" toggle inside each .password-field. */
function initPasswordToggles() {
  document.querySelectorAll("[data-toggle-password]").forEach((button) => {
    button.addEventListener("click", () => {
      const input = button.previousElementSibling; // The password input sits before the button.
      if (!input) return;
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      button.setAttribute("aria-label", show ? "Hide password" : "Show password");
      button.setAttribute("aria-pressed", String(show));
    });
  });
}

function showNotice(id, message) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
}

function hideNotice(id) {
  const el = document.getElementById(id);
  if (el) el.hidden = true;
}

/* Swap a submit button into its loading state (spinner + disabled). */
function setButtonLoading(button, loading, label) {
  const labelEl = button.querySelector("[data-button-label]");
  const spinnerEl = button.querySelector(".spinner");
  if (loading) {
    if (labelEl && label) labelEl.textContent = label;
    if (spinnerEl) spinnerEl.hidden = false;
  } else if (spinnerEl) {
    spinnerEl.hidden = true;
  }
  button.disabled = loading;
}

/* --- Login ---------------------------------------------------------------- */
function initLoginPage() {
  const form = document.getElementById("login-form");
  initPasswordToggles();
  guardIfLoggedIn();

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    hideNotice("auth-error");
    hideNotice("auth-notice");
    const submitButton = form.querySelector('button[type="submit"]');
    setButtonLoading(submitButton, true, "Signing in…");

    requestJSON(API.login, {
      method: "POST",
      body: { email: form.email.value.trim(), password: form.password.value },
    })
      .then(() => {
        showNotice("auth-notice", "Welcome back! Taking you to your dashboard…");
        window.location.replace("dashboard.html");
      })
      .catch((err) => {
        setButtonLoading(submitButton, false);
        showNotice("auth-error",
          err.message === "session-expired"
            ? "Your session expired. Please sign in again."
            : err.message || "We couldn’t sign you in. Please try again.");
      });
  });
}

/* --- Signup --------------------------------------------------------------- */
function initSignupPage() {
  const form = document.getElementById("signup-form");
  initPasswordToggles();
  guardIfLoggedIn();

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    hideNotice("auth-error");
    const submitButton = form.querySelector('button[type="submit"]');
    setButtonLoading(submitButton, true, "Creating account…");

    requestJSON(API.signup, {
      method: "POST",
      body: {
        username: form.username.value.trim(),
        email: form.email.value.trim(),
        password: form.password.value,
      },
    })
      .then(() => {
        showNotice("auth-error", "Account created. Taking you to your new dashboard…");
        window.location.replace("dashboard.html");
      })
      .catch((err) => {
        setButtonLoading(submitButton, false);
        showNotice("auth-error",
          err.message === "session-expired"
            ? "Your session expired. Please sign in again."
            : err.message || "We couldn’t create your account. Please try again.");
      });
  });
}

/* --- Logout (used on the dashboard) --------------------------------------- */
function initLogoutButton() {
  const button = document.getElementById("logout-button");
  if (!button) return;
  button.addEventListener("click", () => {
    setButtonLoading(button, true, "Logging out…");
    requestJSON(API.logout, { method: "POST" })
      .catch(() => { /* Even if the session is already gone, still head back. */ })
      .finally(() => { window.location.replace("index.html"); });
  });
}

switch (document.body.dataset.page) {
  case "login": initLoginPage(); break;
  case "signup": initSignupPage(); break;
  case "dashboard": initLogoutButton(); break;
  default: break;
}