"use strict";

const fixtureGrid = document.getElementById("fixtureGrid");
const fixtureSearch = document.getElementById("fixtureSearch");
const stkRequestForm = document.getElementById("stkRequestForm");
const stkSubmit = document.getElementById("stkSubmit");
const stkRequestStatus = document.getElementById("stkRequestStatus");
const requestedPlan = document.getElementById("requestedPlan");
const customerPhone = document.getElementById("customerPhone");
const sharePhoneConsent = document.getElementById("sharePhoneConsent");
const paymentConsentText = document.getElementById("paymentConsentText");
let fixtures = [];
let paymentPlanPrices = { VIP: 300, VVIP: 500 };
let paymentEnabled = false;

function setPaymentStatus(message, isError = false) {
  stkRequestStatus.textContent = message;
  stkRequestStatus.style.color = isError ? "#ff9a9a" : "";
}

function updatePaymentConsent() {
  const plan = requestedPlan.value;
  const amount = paymentPlanPrices[plan];
  paymentConsentText.textContent = plan && amount
    ? `I authorize Royal Bets to request one payment of KES ${amount} for my ${plan} weekly plan through an M-Pesa STK prompt to this number.`
    : "I authorize Royal Bets to request the selected weekly payment through an M-Pesa STK prompt to this number.";
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function watchPaymentStatus(paymentId) {
  if (typeof paymentId !== "string" || !/^[a-zA-Z0-9_-]{32,64}$/.test(paymentId)) {
    throw new Error("The payment service returned an invalid request reference.");
  }
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await delay(3000);
    const response = await fetch(`/api/payments/${encodeURIComponent(paymentId)}`, {
      headers: { Accept: "application/json" }
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `Payment status request failed (${response.status}).`);
    if (result.status === "paid") {
      setPaymentStatus("Payment confirmed by Safaricom. Your payment is recorded; membership access is not automated on this site yet.");
      return;
    }
    if (result.status === "failed" || result.status === "request_failed") {
      setPaymentStatus(result.message, true);
      return;
    }
  }
  setPaymentStatus("The request is still pending. Check your M-Pesa messages; do not retry unless the request has expired.");
}

async function loadPaymentAvailability() {
  try {
    const response = await fetch("/api/payments/config", { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`Payment configuration request failed (${response.status}).`);
    const config = await response.json();
    if (config.plans && typeof config.plans === "object") paymentPlanPrices = config.plans;
    paymentEnabled = config.enabled === true;
    stkSubmit.disabled = !paymentEnabled;
    setPaymentStatus(config.enabled
      ? "M-Pesa STK checkout is ready. Select a plan and enter the recipient's number."
      : "Online payment is not set up yet. Royal Bets must configure Daraja and a public HTTPS callback before STK prompts can be sent.");
    updatePaymentConsent();
  } catch (error) {
    paymentEnabled = false;
    stkSubmit.disabled = true;
    setPaymentStatus("Could not check M-Pesa availability. Please try again later.", true);
    console.error("Could not load payment configuration:", error);
  }
}

function formatDate(value) {
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("en-GB", {
    weekday: "short", day: "numeric", month: "short", year: "numeric"
  }).format(date);
}

function addText(parent, tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = value;
  parent.append(node);
  return node;
}

function renderFixtures() {
  const query = fixtureSearch.value.trim().toLocaleLowerCase();
  const visible = fixtures.filter((fixture) =>
    [fixture.league, fixture.date, fixture.home, fixture.away, fixture.analysis, fixture.tipTeaser]
      .some((value) => String(value || "").toLocaleLowerCase().includes(query))
  );
  fixtureGrid.replaceChildren();
  if (visible.length === 0) {
    addText(
      fixtureGrid,
      "p",
      "empty",
      query ? "No published fixtures match your search." : "No match previews are posted yet. Please check back soon."
    );
    return;
  }
  visible.forEach((fixture) => {
    const card = document.createElement("article");
    card.className = "fixture-card";
    const meta = document.createElement("div");
    meta.className = "fixture-meta";
    addText(meta, "span", "league", fixture.league);
    addText(meta, "span", "", `${formatDate(fixture.date)} · ${fixture.time} EAT`);
    const teams = document.createElement("div");
    teams.className = "teams";
    addText(teams, "span", "", fixture.home);
    addText(teams, "span", "versus", "VS");
    addText(teams, "span", "", fixture.away);
    addText(card, "p", "fixture-analysis", fixture.analysis);
    if (fixture.tipTeaser) {
      const teaser = document.createElement("div");
      teaser.className = "pick-preview";
      addText(teaser, "strong", "", fixture.tipTeaser);
      addText(teaser, "span", "", "Tips are opinions, not guarantees");
      card.prepend(meta, teams);
      card.append(teaser);
    } else {
      card.prepend(meta, teams);
    }
    fixtureGrid.append(card);
  });
}

async function loadFixtures() {
  fixtureGrid.replaceChildren();
  addText(fixtureGrid, "p", "empty", "Loading published match previews…");
  try {
    const response = await fetch("/api/fixtures", { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`Fixture request failed (${response.status}).`);
    const result = await response.json();
    if (!Array.isArray(result)) throw new Error("The fixture service returned an invalid response.");
    fixtures = result;
    renderFixtures();
  } catch (error) {
    fixtureGrid.replaceChildren();
    addText(fixtureGrid, "p", "empty", "Could not load published fixtures. Please try again later.");
    console.error("Could not load public fixtures:", error);
  }
}

fixtureSearch.addEventListener("input", renderFixtures);
document.querySelectorAll(".plan-link").forEach((link) => {
  link.addEventListener("click", () => {
    requestedPlan.value = link.dataset.plan;
    sharePhoneConsent.checked = false;
    updatePaymentConsent();
    customerPhone.focus({ preventScroll: true });
  });
});
requestedPlan.addEventListener("change", updatePaymentConsent);
stkRequestForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!sharePhoneConsent.checked) {
    setPaymentStatus("Please confirm the payment request before continuing.", true);
    return;
  }
  stkSubmit.disabled = true;
  setPaymentStatus("Sending your request securely to Safaricom…");
  try {
    const response = await fetch("/api/payments/stk", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        phone: customerPhone.value,
        plan: requestedPlan.value,
        authorized: sharePhoneConsent.checked
      })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `Payment request failed (${response.status}).`);
    setPaymentStatus("STK request accepted. Check your phone and enter your PIN only in the official M-Pesa prompt.");
    stkRequestForm.reset();
    updatePaymentConsent();
    await watchPaymentStatus(result.id);
  } catch (error) {
    setPaymentStatus(error.message, true);
  } finally {
    stkSubmit.disabled = !paymentEnabled;
  }
});

document.getElementById("year").textContent = String(new Date().getFullYear());
loadFixtures();
loadPaymentAvailability();
