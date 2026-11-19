"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");
const IS_PRODUCTION = process.env.NODE_ENV === "production";
const DATA_FILE = path.resolve(process.env.DATA_FILE || path.join(ROOT, "data", "fixtures.json"));
const PAYMENTS_FILE = path.resolve(process.env.PAYMENTS_FILE || path.join(ROOT, "data", "payments.json"));
const STORE_FORMAT = "royal-bets-fixtures";
const STORE_VERSION = 1;
const PAYMENT_STORE_FORMAT = "royal-bets-payment-requests";
const PAYMENT_STORE_VERSION = 1;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 5;
const MAX_BODY_BYTES = 16 * 1024;
const SESSION_COOKIE = IS_PRODUCTION ? "__Host-royal_bets_session" : "royal_bets_session";
const STATIC_FILES = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/admin", ["admin.html", "text/html; charset=utf-8"]],
  ["/admin/", ["admin.html", "text/html; charset=utf-8"]],
  ["/admin.html", ["admin.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/admin.js", ["admin.js", "text/javascript; charset=utf-8"]]
]);

const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET;
const DARAJA_ENV = process.env.DARAJA_ENV;
const DARAJA_CONSUMER_KEY = process.env.DARAJA_CONSUMER_KEY;
const DARAJA_CONSUMER_SECRET = process.env.DARAJA_CONSUMER_SECRET;
const DARAJA_PASSKEY = process.env.DARAJA_PASSKEY;
const DARAJA_SHORT_CODE = process.env.DARAJA_SHORT_CODE;
const DARAJA_BUSINESS_TYPE = process.env.DARAJA_BUSINESS_TYPE;
const DARAJA_CALLBACK_BASE_URL = process.env.DARAJA_CALLBACK_BASE_URL;
const DARAJA_CALLBACK_TOKEN = process.env.DARAJA_CALLBACK_TOKEN;
const DARAJA_ACCOUNT_REFERENCE = process.env.DARAJA_ACCOUNT_REFERENCE || "ROYALBETS";
const PAYMENT_PLANS = Object.freeze({ VIP: 300, VVIP: 500 });
const DARAJA_API_BASE_URL = process.env.NODE_ENV === "test" && process.env.DARAJA_API_BASE_URL
  ? process.env.DARAJA_API_BASE_URL
  : DARAJA_ENV === "production"
    ? "https://api.safaricom.co.ke"
    : "https://sandbox.safaricom.co.ke";
const CALLBACK_ROUTE = DARAJA_CALLBACK_TOKEN
  ? `/api/payments/callback/${encodeURIComponent(DARAJA_CALLBACK_TOKEN)}`
  : "";

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error("PORT must be a valid TCP port.");
}
if (!ADMIN_USERNAME || ADMIN_USERNAME.length > 100) {
  throw new Error("Set ADMIN_USERNAME in the environment before starting the server.");
}
if (!ADMIN_PASSWORD || ADMIN_PASSWORD.length < 14) {
  throw new Error("Set ADMIN_PASSWORD to a password of at least 14 characters.");
}
if (!SESSION_SECRET || SESSION_SECRET.length < 32) {
  throw new Error("Set SESSION_SECRET to a random value of at least 32 characters.");
}
if (IS_PRODUCTION && process.env.SESSION_COOKIE_SECURE === "false") {
  throw new Error("Secure session cookies cannot be disabled in production.");
}
if (DARAJA_ENV && !["sandbox", "production"].includes(DARAJA_ENV)) {
  throw new Error("DARAJA_ENV must be sandbox or production.");
}
if (DARAJA_BUSINESS_TYPE && !["paybill", "till"].includes(DARAJA_BUSINESS_TYPE)) {
  throw new Error("DARAJA_BUSINESS_TYPE must be paybill or till.");
}

const passwordSalt = `royal-bets-admin:${ADMIN_USERNAME}`;
const passwordHash = crypto.scryptSync(ADMIN_PASSWORD, passwordSalt, 64);
const sessions = new Map();
const loginAttempts = new Map();
let fixtures = [];
let writeQueue = Promise.resolve();
let paymentRequests = [];
let paymentWriteQueue = Promise.resolve();
let cachedDarajaToken = null;

function isPaymentConfigured() {
  if (!["sandbox", "production"].includes(DARAJA_ENV)) return false;
  if (!DARAJA_CONSUMER_KEY || !DARAJA_CONSUMER_SECRET || !DARAJA_PASSKEY) return false;
  if (!DARAJA_SHORT_CODE || !/^\d{5,12}$/.test(DARAJA_SHORT_CODE)) return false;
  if (!DARAJA_BUSINESS_TYPE || !DARAJA_CALLBACK_TOKEN ||
      !/^[a-zA-Z0-9_-]{32,128}$/.test(DARAJA_CALLBACK_TOKEN)) return false;
  if (!DARAJA_CALLBACK_BASE_URL || DARAJA_ACCOUNT_REFERENCE.length > 12) return false;
  try {
    const callbackBase = new URL(DARAJA_CALLBACK_BASE_URL);
    if (callbackBase.protocol !== "https:" || callbackBase.username || callbackBase.password ||
        callbackBase.pathname !== "/" || callbackBase.search || callbackBase.hash) return false;
  } catch {
    return false;
  }
  return true;
}

function equalSecret(actual, expected) {
  const actualBytes = Buffer.from(String(actual));
  const expectedBytes = Buffer.from(String(expected));
  return actualBytes.length === expectedBytes.length && crypto.timingSafeEqual(actualBytes, expectedBytes);
}

function signSession(id) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(id).digest("base64url");
}

function sessionCookieValue(id) {
  return `${id}.${signSession(id)}`;
}

function parseCookies(header) {
  const cookies = new Map();
  for (const part of (header || "").split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    cookies.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim());
  }
  return cookies;
}

function getSession(request) {
  const value = parseCookies(request.headers.cookie).get(SESSION_COOKIE);
  if (!value) return null;
  const separator = value.lastIndexOf(".");
  if (separator < 1) return null;
  const id = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  if (!equalSecret(signature, signSession(id))) return null;
  const session = sessions.get(id);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(id);
    return null;
  }
  return { id, ...session };
}

function setSessionCookie(response, id) {
  const flags = ["Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`];
  if (IS_PRODUCTION) flags.push("Secure");
  response.setHeader("Set-Cookie", `${SESSION_COOKIE}=${sessionCookieValue(id)}; ${flags.join("; ")}`);
}

function clearSessionCookie(response) {
  const flags = ["Path=/", "HttpOnly", "SameSite=Strict", "Max-Age=0"];
  if (IS_PRODUCTION) flags.push("Secure");
  response.setHeader("Set-Cookie", `${SESSION_COOKIE}=; ${flags.join("; ")}`);
}

function applySecurityHeaders(response) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "same-origin");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'self'"
  );
}

function sendJson(response, status, value, extraHeaders = {}) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extraHeaders
  });
  response.end(body);
}

function sendError(response, status, message) {
  sendJson(response, status, { error: message });
}

function isSameOrigin(request) {
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (!origin || !host) return false;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.host === host;
  } catch {
    return false;
  }
}

async function readJson(request) {
  const contentType = request.headers["content-type"] || "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    const error = new Error("Content-Type must be application/json.");
    error.status = 415;
    throw error;
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_BODY_BYTES) {
      const error = new Error("Request body is too large.");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Expected an object.");
    return parsed;
  } catch {
    const error = new Error("Request body must be valid JSON.");
    error.status = 400;
    throw error;
  }
}

function cleanString(value, maxLength) {
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  if (!cleaned || cleaned.length > maxLength) return null;
  return cleaned;
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validateFixture(body) {
  const fields = {
    league: cleanString(body.league, 60),
    date: cleanString(body.date, 10),
    time: cleanString(body.time, 5),
    home: cleanString(body.home, 60),
    away: cleanString(body.away, 60),
    analysis: cleanString(body.analysis, 800),
    tipTeaser: typeof body.tipTeaser === "string" ? body.tipTeaser.trim().slice(0, 160) : "",
    vipTip: typeof body.vipTip === "string" ? body.vipTip.trim().slice(0, 1000) : "",
    vvipTip: typeof body.vvipTip === "string" ? body.vvipTip.trim().slice(0, 1000) : "",
    published: body.published === true
  };
  if (Object.entries(fields).some(([key, value]) => ["tipTeaser", "vipTip", "vvipTip"].includes(key) ? false : !value)) {
    return { error: "Complete the competition, date, time, both teams and free preview." };
  }
  if (!validDate(fields.date)) return { error: "Enter a valid match date." };
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(fields.time)) return { error: "Enter a valid kickoff time." };
  if (fields.home.toLocaleLowerCase() === fields.away.toLocaleLowerCase()) {
    return { error: "Home and away teams must be different." };
  }
  if (fields.analysis.length < 5) return { error: "The free preview must contain at least 5 characters." };
  if (typeof body.published !== "boolean") return { error: "Choose whether this fixture is published." };
  return { fixture: fields };
}

function publicFixture(fixture) {
  return {
    id: fixture.id,
    league: fixture.league,
    date: fixture.date,
    time: fixture.time,
    home: fixture.home,
    away: fixture.away,
    analysis: fixture.analysis,
    tipTeaser: fixture.tipTeaser
  };
}

async function persist(nextFixtures) {
  const directory = path.dirname(DATA_FILE);
  await fs.mkdir(directory, { recursive: true });
  const temporary = `${DATA_FILE}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify({
      format: STORE_FORMAT,
      version: STORE_VERSION,
      fixtures: nextFixtures
    }, null, 2), { encoding: "utf8", mode: 0o600, flag: "wx" });
    await fs.rename(temporary, DATA_FILE);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function persistPaymentRequests(nextRequests) {
  const directory = path.dirname(PAYMENTS_FILE);
  await fs.mkdir(directory, { recursive: true });
  const temporary = `${PAYMENTS_FILE}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify({
      format: PAYMENT_STORE_FORMAT,
      version: PAYMENT_STORE_VERSION,
      requests: nextRequests
    }, null, 2), { encoding: "utf8", mode: 0o600, flag: "wx" });
    await fs.rename(temporary, PAYMENTS_FILE);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function updatePaymentRequests(updater) {
  const operation = paymentWriteQueue.then(async () => {
    const next = updater(paymentRequests);
    await persistPaymentRequests(next);
    paymentRequests = next;
    return next;
  });
  paymentWriteQueue = operation.catch(() => {});
  return operation;
}

async function loadPaymentRequests() {
  try {
    const parsed = JSON.parse(await fs.readFile(PAYMENTS_FILE, "utf8"));
    if (parsed.format !== PAYMENT_STORE_FORMAT || parsed.version !== PAYMENT_STORE_VERSION || !Array.isArray(parsed.requests)) {
      throw new Error("Payment request data has an unsupported format or version.");
    }
    paymentRequests = parsed.requests;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    paymentRequests = [];
    await persistPaymentRequests(paymentRequests);
  }
}

function normalizeKenyanPhone(value) {
  if (typeof value !== "string" || value.length > 24) return null;
  const compact = value.trim().replace(/[\s()-]/g, "");
  const digits = compact.startsWith("+") ? compact.slice(1) : compact;
  let normalized = digits;
  if (/^0[17]\d{8}$/.test(digits)) normalized = `254${digits.slice(1)}`;
  if (!/^254[17]\d{8}$/.test(normalized)) return null;
  return normalized;
}

function getDarajaTimestamp() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Nairobi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}${values.month}${values.day}${values.hour}${values.minute}${values.second}`;
}

async function darajaAccessToken() {
  if (cachedDarajaToken && cachedDarajaToken.expiresAt > Date.now() + 30_000) {
    return cachedDarajaToken.value;
  }
  const credentials = Buffer.from(`${DARAJA_CONSUMER_KEY}:${DARAJA_CONSUMER_SECRET}`).toString("base64");
  const response = await fetch(
    `${DARAJA_API_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
    {
      headers: { Authorization: `Basic ${credentials}`, Accept: "application/json" },
      signal: AbortSignal.timeout(10_000)
    }
  );
  const body = await response.json().catch(() => ({}));
  if (!response.ok || typeof body.access_token !== "string") {
    throw new Error("Safaricom authentication failed.");
  }
  const expiresIn = Math.max(60, Number(body.expires_in) || 300);
  cachedDarajaToken = { value: body.access_token, expiresAt: Date.now() + expiresIn * 1000 };
  return cachedDarajaToken.value;
}

async function requestStkPush(phone, plan, amount) {
  const timestamp = getDarajaTimestamp();
  const password = Buffer.from(`${DARAJA_SHORT_CODE}${DARAJA_PASSKEY}${timestamp}`).toString("base64");
  const transactionType = DARAJA_BUSINESS_TYPE === "till"
    ? "CustomerBuyGoodsOnline"
    : "CustomerPayBillOnline";
  const token = await darajaAccessToken();
  const response = await fetch(`${DARAJA_API_BASE_URL}/mpesa/stkpush/v1/processrequest`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify({
      BusinessShortCode: DARAJA_SHORT_CODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: transactionType,
      Amount: amount,
      PartyA: phone,
      PartyB: DARAJA_SHORT_CODE,
      PhoneNumber: phone,
      CallBackURL: `${DARAJA_CALLBACK_BASE_URL.replace(/\/+$/, "")}${CALLBACK_ROUTE}`,
      AccountReference: DARAJA_ACCOUNT_REFERENCE,
      TransactionDesc: `Royal Bets ${plan} weekly membership`
    }),
    signal: AbortSignal.timeout(15_000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ResponseCode !== "0" ||
      typeof body.CheckoutRequestID !== "string" ||
      typeof body.MerchantRequestID !== "string") {
    throw new Error("Safaricom did not accept the STK request.");
  }
  return body;
}

function publicPaymentStatus(payment) {
  return {
    id: payment.id,
    plan: payment.plan,
    amount: payment.amount,
    status: payment.status,
    message: payment.status === "paid"
      ? "Payment confirmed."
      : payment.status === "failed"
        ? "Payment was not completed."
        : payment.status === "request_failed"
          ? "The STK request could not be sent."
          : "Check your phone for the official M-Pesa prompt."
  };
}

function updateFixtures(updater) {
  const operation = writeQueue.then(async () => {
    const next = updater(fixtures);
    await persist(next);
    fixtures = next;
    return next;
  });
  writeQueue = operation.catch(() => {});
  return operation;
}

async function loadStore() {
  try {
    const parsed = JSON.parse(await fs.readFile(DATA_FILE, "utf8"));
    if (parsed.format !== STORE_FORMAT || parsed.version !== STORE_VERSION || !Array.isArray(parsed.fixtures)) {
      throw new Error("Fixture data file has an unsupported format or version.");
    }
    fixtures = parsed.fixtures.map((fixture) => {
      if (!fixture || typeof fixture.id !== "string") throw new Error("Fixture data file contains an invalid fixture.");
      const result = validateFixture(fixture);
      if (!result.fixture) throw new Error("Fixture data file contains an invalid fixture.");
      return { id: fixture.id, ...result.fixture };
    });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    fixtures = [];
    await persist(fixtures);
  }
}

function clientIp(request) {
  return request.socket.remoteAddress || "unknown";
}

function loginIsBlocked(ip) {
  const record = loginAttempts.get(ip);
  if (!record) return false;
  if (record.windowEndsAt <= Date.now()) {
    loginAttempts.delete(ip);
    return false;
  }
  return record.count >= LOGIN_MAX_ATTEMPTS;
}

function recordFailedLogin(ip) {
  const now = Date.now();
  const current = loginAttempts.get(ip);
  if (!current || current.windowEndsAt <= now) {
    loginAttempts.set(ip, { count: 1, windowEndsAt: now + LOGIN_WINDOW_MS });
    return;
  }
  current.count += 1;
}

function authenticatedSession(request, response, requireCsrf) {
  const session = getSession(request);
  if (!session) {
    sendError(response, 401, "Please sign in again.");
    return null;
  }
  if (requireCsrf && !equalSecret(request.headers["x-csrf-token"] || "", session.csrfToken)) {
    sendError(response, 403, "Request verification failed. Reload the admin page and try again.");
    return null;
  }
  return session;
}

async function serveStatic(pathname, response) {
  const entry = STATIC_FILES.get(pathname);
  if (!entry) {
    sendError(response, 404, "Not found.");
    return;
  }
  const [filename, contentType] = entry;
  const content = await fs.readFile(path.join(ROOT, filename));
  response.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": "no-store"
  });
  response.end(content);
}

async function handleRequest(request, response) {
  applySecurityHeaders(response);
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const pathname = url.pathname;
  const method = request.method || "GET";

  if (method === "GET" && pathname === "/api/health") {
    sendJson(response, 200, { ok: true });
    return;
  }
  if (method === "GET" && pathname === "/api/payments/config") {
    sendJson(response, 200, { enabled: isPaymentConfigured(), plans: PAYMENT_PLANS });
    return;
  }
  if (method === "POST" && CALLBACK_ROUTE && pathname === CALLBACK_ROUTE) {
    const body = await readJson(request);
    const callback = body.Body && body.Body.stkCallback;
    if (!callback || typeof callback.CheckoutRequestID !== "string" ||
        !Number.isFinite(Number(callback.ResultCode))) {
      sendError(response, 400, "Invalid payment callback.");
      return;
    }
    const existing = paymentRequests.find((item) => item.checkoutRequestId === callback.CheckoutRequestID);
    if (!existing) {
      sendError(response, 404, "Payment request not found.");
      return;
    }
    if (existing.status !== "paid" && existing.status !== "failed") {
      const succeeded = Number(callback.ResultCode) === 0;
      const items = callback.CallbackMetadata && Array.isArray(callback.CallbackMetadata.Item)
        ? callback.CallbackMetadata.Item
        : [];
      const receipt = items.find((item) => item && item.Name === "MpesaReceiptNumber");
      await updatePaymentRequests((current) => current.map((item) => item.id === existing.id
        ? {
          ...item,
          status: succeeded ? "paid" : "failed",
          resultDescription: typeof callback.ResultDesc === "string" ? callback.ResultDesc.slice(0, 200) : "",
          receiptNumber: receipt && typeof receipt.Value === "string" ? receipt.Value.slice(0, 40) : "",
          updatedAt: new Date().toISOString()
        }
        : item));
    }
    sendJson(response, 200, { ResultCode: 0, ResultDesc: "Accepted" });
    return;
  }
  if (pathname.startsWith("/api/payments/") && method !== "GET" &&
      !(method === "POST" && CALLBACK_ROUTE && pathname === CALLBACK_ROUTE) &&
      !isSameOrigin(request)) {
    sendError(response, 403, "Cross-origin request rejected.");
    return;
  }
  if (method === "POST" && pathname === "/api/payments/stk") {
    if (!isPaymentConfigured()) {
      sendError(response, 503, "M-Pesa STK checkout is not configured yet.");
      return;
    }
    const body = await readJson(request);
    if (body.authorized !== true) {
      sendError(response, 400, "Confirm the payment request before continuing.");
      return;
    }
    const plan = cleanString(body.plan, 10);
    if (!plan || !Object.hasOwn(PAYMENT_PLANS, plan)) {
      sendError(response, 400, "Choose a valid paid weekly plan.");
      return;
    }
    const phone = normalizeKenyanPhone(body.phone);
    if (!phone) {
      sendError(response, 400, "Enter a valid Kenyan M-Pesa mobile number.");
      return;
    }
    const payment = {
      id: crypto.randomBytes(24).toString("base64url"),
      plan,
      amount: PAYMENT_PLANS[plan],
      status: "initiating",
      checkoutRequestId: "",
      merchantRequestId: "",
      receiptNumber: "",
      resultDescription: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await updatePaymentRequests((current) => [...current, payment]);
    try {
      const result = await requestStkPush(phone, plan, payment.amount);
      await updatePaymentRequests((current) => current.map((item) => item.id === payment.id
        ? {
          ...item,
          status: "awaiting_customer",
          checkoutRequestId: result.CheckoutRequestID,
          merchantRequestId: result.MerchantRequestID,
          updatedAt: new Date().toISOString()
        }
        : item));
      sendJson(response, 202, {
        ...publicPaymentStatus(paymentRequests.find((item) => item.id === payment.id)),
        statusUrl: `/api/payments/${payment.id}`
      });
    } catch (error) {
      await updatePaymentRequests((current) => current.map((item) => item.id === payment.id
        ? { ...item, status: "request_failed", updatedAt: new Date().toISOString() }
        : item));
      console.error("Safaricom STK request failed:", error.message);
      sendError(response, 502, "Safaricom could not accept the STK request. Check the number and try again.");
    }
    return;
  }
  const paymentStatusRoute = pathname.match(/^\/api\/payments\/([a-zA-Z0-9_-]{32,64})$/);
  if (method === "GET" && paymentStatusRoute) {
    const payment = paymentRequests.find((item) => item.id === paymentStatusRoute[1]);
    if (!payment) {
      sendError(response, 404, "Payment request not found.");
      return;
    }
    sendJson(response, 200, publicPaymentStatus(payment));
    return;
  }
  if (method === "GET" && pathname === "/api/fixtures") {
    sendJson(response, 200, fixtures.filter((item) => item.published).map(publicFixture));
    return;
  }
  if (method === "GET" && pathname === "/api/admin/session") {
    const session = getSession(request);
    sendJson(response, 200, session
      ? { authenticated: true, csrfToken: session.csrfToken }
      : { authenticated: false });
    return;
  }
  if (pathname.startsWith("/api/admin/") && !isSameOrigin(request) && method !== "GET") {
    sendError(response, 403, "Cross-origin request rejected.");
    return;
  }
  if (method === "POST" && pathname === "/api/admin/login") {
    const ip = clientIp(request);
    if (loginIsBlocked(ip)) {
      sendError(response, 429, "Too many sign-in attempts. Try again in 15 minutes.");
      return;
    }
    const body = await readJson(request);
    const usernameMatches = equalSecret(body.username || "", ADMIN_USERNAME);
    const attemptedPassword = typeof body.password === "string" ? body.password : "";
    const attemptedHash = crypto.scryptSync(attemptedPassword, passwordSalt, 64);
    const passwordMatches = crypto.timingSafeEqual(attemptedHash, passwordHash);
    if (!usernameMatches || !passwordMatches) {
      recordFailedLogin(ip);
      sendError(response, 401, "Invalid username or password.");
      return;
    }
    loginAttempts.delete(ip);
    for (const [sessionId, session] of sessions) {
      if (session.expiresAt <= Date.now()) sessions.delete(sessionId);
    }
    const id = crypto.randomBytes(32).toString("base64url");
    const session = { csrfToken: crypto.randomBytes(32).toString("base64url"), expiresAt: Date.now() + SESSION_TTL_MS };
    sessions.set(id, session);
    setSessionCookie(response, id);
    sendJson(response, 200, { authenticated: true, csrfToken: session.csrfToken });
    return;
  }
  if (method === "POST" && pathname === "/api/admin/logout") {
    const session = authenticatedSession(request, response, true);
    if (!session) return;
    sessions.delete(session.id);
    clearSessionCookie(response);
    sendJson(response, 200, { authenticated: false });
    return;
  }
  if (method === "GET" && pathname === "/api/admin/fixtures") {
    if (!authenticatedSession(request, response, false)) return;
    sendJson(response, 200, fixtures);
    return;
  }
  if (method === "POST" && pathname === "/api/admin/fixtures") {
    if (!authenticatedSession(request, response, true)) return;
    const body = await readJson(request);
    const result = validateFixture(body);
    if (!result.fixture) {
      sendError(response, 400, result.error);
      return;
    }
    const fixture = { id: crypto.randomUUID(), ...result.fixture };
    const next = await updateFixtures((current) => [...current, fixture]);
    sendJson(response, 201, next.find((item) => item.id === fixture.id));
    return;
  }
  const fixtureRoute = pathname.match(/^\/api\/admin\/fixtures\/([a-zA-Z0-9_-]{1,80})$/);
  if (fixtureRoute && method === "PUT") {
    if (!authenticatedSession(request, response, true)) return;
    const body = await readJson(request);
    const result = validateFixture(body);
    if (!result.fixture) {
      sendError(response, 400, result.error);
      return;
    }
    let updated = null;
    const next = await updateFixtures((current) => current.map((item) => {
      if (item.id !== fixtureRoute[1]) return item;
      updated = { id: item.id, ...result.fixture };
      return updated;
    }));
    if (!updated) {
      sendError(response, 404, "Fixture not found.");
      return;
    }
    sendJson(response, 200, next.find((item) => item.id === updated.id));
    return;
  }
  if (fixtureRoute && method === "DELETE") {
    if (!authenticatedSession(request, response, true)) return;
    let found = false;
    const next = await updateFixtures((current) => current.filter((item) => {
      if (item.id !== fixtureRoute[1]) return true;
      found = true;
      return false;
    }));
    if (!found) {
      sendError(response, 404, "Fixture not found.");
      return;
    }
    sendJson(response, 200, { deleted: true });
    return;
  }
  if (method === "GET" && STATIC_FILES.has(pathname)) {
    await serveStatic(pathname, response);
    return;
  }
  sendError(response, 404, "Not found.");
}

async function main() {
  await loadStore();
  await loadPaymentRequests();
  const server = http.createServer((request, response) => {
    handleRequest(request, response).catch((error) => {
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      if (error.status) {
        sendError(response, error.status, error.message);
        return;
      }
      console.error("Request failed:", error);
      sendError(response, 500, "The server could not complete the request.");
    });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.listen(PORT, HOST, () => {
    console.log(`Royal Bets server listening at http://${HOST}:${PORT}`);
  });
  const close = () => server.close((error) => {
    if (error) {
      console.error("Server shutdown failed:", error);
      process.exitCode = 1;
    }
  });
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
}

main().catch((error) => {
  console.error("Could not start Royal Bets server:", error);
  process.exitCode = 1;
});
