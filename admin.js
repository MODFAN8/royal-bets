"use strict";

const loginPanel = document.getElementById("loginPanel");
const dashboardPanel = document.getElementById("dashboardPanel");
const loginForm = document.getElementById("loginForm");
const loginStatus = document.getElementById("loginStatus");
const loginButton = document.getElementById("loginButton");
const fixtureForm = document.getElementById("fixtureForm");
const fixtureStatus = document.getElementById("fixtureStatus");
const fixtureList = document.getElementById("fixtureList");
const saveFixtureButton = document.getElementById("saveFixture");
const cancelEditButton = document.getElementById("cancelEdit");
const fixtureIdInput = document.getElementById("fixtureId");
let csrfToken = "";
let fixtures = [];
const fields = {
  league: document.getElementById("league"),
  date: document.getElementById("date"),
  time: document.getElementById("time"),
  home: document.getElementById("home"),
  away: document.getElementById("away"),
  analysis: document.getElementById("analysis"),
  tipTeaser: document.getElementById("tipTeaser"),
  vipTip: document.getElementById("vipTip"),
  vvipTip: document.getElementById("vvipTip"),
  published: document.getElementById("published")
};

function setStatus(element, message, isError = false) {
  element.textContent = message;
  element.classList.toggle("error", isError);
}

async function request(url, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("Accept", "application/json");
  if (options.body) headers.set("Content-Type", "application/json");
  if (options.method && options.method !== "GET" && csrfToken) headers.set("X-CSRF-Token", csrfToken);
  const response = await fetch(url, { ...options, headers, credentials: "same-origin" });
  let payload = {};
  try {
    payload = await response.json();
  } catch {
    throw new Error("The server returned an invalid response.");
  }
  if (!response.ok) {
    if (response.status === 401 && url !== "/api/admin/login") showLogin();
    throw new Error(payload.error || `Request failed (${response.status}).`);
  }
  return payload;
}

function showLogin() {
  csrfToken = "";
  loginPanel.hidden = false;
  dashboardPanel.hidden = true;
}

function showDashboard(token) {
  csrfToken = token;
  loginPanel.hidden = true;
  dashboardPanel.hidden = false;
}

function addText(parent, tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = value;
  parent.append(node);
  return node;
}

function formatFixtureDate(value) {
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("en-GB", {
    weekday: "short", day: "numeric", month: "short", year: "numeric"
  }).format(date);
}

function renderFixtures() {
  fixtureList.replaceChildren();
  if (fixtures.length === 0) {
    addText(fixtureList, "p", "muted", "No fixtures saved yet. Add one using the form above.");
    return;
  }
  [...fixtures].sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`)).forEach((fixture) => {
    const row = document.createElement("article");
    row.className = "fixture-row";
    const summary = document.createElement("div");
    addText(summary, "p", "fixture-name", `${fixture.home} vs ${fixture.away}`);
    addText(
      summary,
      "p",
      "fixture-meta",
      `${fixture.league} · ${formatFixtureDate(fixture.date)} · ${fixture.time} EAT · ${fixture.published ? "Published" : "Draft"}`
    );
    const actions = document.createElement("div");
    actions.className = "fixture-actions";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "button button-outline";
    edit.textContent = "Edit";
    edit.setAttribute("aria-label", `Edit ${fixture.home} vs ${fixture.away}`);
    edit.addEventListener("click", () => beginEdit(fixture));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "button button-danger";
    remove.textContent = "Delete";
    remove.setAttribute("aria-label", `Delete ${fixture.home} vs ${fixture.away}`);
    remove.addEventListener("click", () => deleteFixture(fixture));
    actions.append(edit, remove);
    row.append(summary, actions);
    fixtureList.append(row);
  });
}

async function refreshFixtures() {
  fixtures = await request("/api/admin/fixtures");
  renderFixtures();
}

function resetForm() {
  fixtureForm.reset();
  fixtureIdInput.value = "";
  fields.published.checked = true;
  saveFixtureButton.textContent = "Publish fixture";
  cancelEditButton.hidden = true;
}

function beginEdit(fixture) {
  fixtureIdInput.value = fixture.id;
  Object.entries(fields).forEach(([key, field]) => {
    if (key === "published") field.checked = fixture.published;
    else field.value = fixture[key] || "";
  });
  saveFixtureButton.textContent = "Save changes";
  cancelEditButton.hidden = false;
  fields.league.focus();
}

async function deleteFixture(fixture) {
  if (!window.confirm(`Permanently remove ${fixture.home} vs ${fixture.away}?`)) return;
  try {
    await request(`/api/admin/fixtures/${encodeURIComponent(fixture.id)}`, { method: "DELETE" });
    setStatus(fixtureStatus, "Fixture deleted.");
    if (fixtureIdInput.value === fixture.id) resetForm();
    await refreshFixtures();
  } catch (error) {
    setStatus(fixtureStatus, error.message, true);
  }
}

async function checkSession() {
  try {
    const session = await request("/api/admin/session");
    if (!session.configured) {
      showLogin();
      setStatus(loginStatus, "Admin access is not configured on this server yet. Ask the site owner to set its private environment variables.", true);
      return;
    }
    if (!session.authenticated) {
      showLogin();
      return;
    }
    showDashboard(session.csrfToken);
    await refreshFixtures();
  } catch (error) {
    showLogin();
    setStatus(loginStatus, "Could not connect to the server. Please try again.", true);
    console.error("Could not check admin session:", error);
  }
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginButton.disabled = true;
  setStatus(loginStatus, "Signing in…");
  try {
    const result = await request("/api/admin/login", {
      method: "POST",
      body: JSON.stringify({
        username: document.getElementById("username").value,
        password: document.getElementById("password").value
      })
    });
    document.getElementById("password").value = "";
    showDashboard(result.csrfToken);
    setStatus(loginStatus, "");
    await refreshFixtures();
  } catch (error) {
    setStatus(loginStatus, error.message, true);
  } finally {
    loginButton.disabled = false;
  }
});

document.getElementById("logoutButton").addEventListener("click", async () => {
  try {
    await request("/api/admin/logout", { method: "POST", body: "{}" });
    showLogin();
    loginForm.reset();
    setStatus(loginStatus, "You have signed out.");
    fixtureList.replaceChildren();
  } catch (error) {
    setStatus(fixtureStatus, error.message, true);
  }
});

fixtureForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  saveFixtureButton.disabled = true;
  setStatus(fixtureStatus, "Saving fixture…");
  const fixture = Object.fromEntries(Object.entries(fields).map(([key, field]) => [
    key,
    key === "published" ? field.checked : field.value.trim()
  ]));
  const id = fixtureIdInput.value;
  try {
    await request(id ? `/api/admin/fixtures/${encodeURIComponent(id)}` : "/api/admin/fixtures", {
      method: id ? "PUT" : "POST",
      body: JSON.stringify(fixture)
    });
    setStatus(fixtureStatus, fixture.published ? "Fixture saved and published." : "Fixture saved as a private draft.");
    resetForm();
    await refreshFixtures();
  } catch (error) {
    setStatus(fixtureStatus, error.message, true);
  } finally {
    saveFixtureButton.disabled = false;
  }
});

cancelEditButton.addEventListener("click", () => {
  resetForm();
  setStatus(fixtureStatus, "");
});

checkSession();
