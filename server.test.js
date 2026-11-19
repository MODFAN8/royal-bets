"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs/promises");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

async function unusedPort() {
  const listener = net.createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const { port } = listener.address();
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function startServer(t, extraEnv = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "royal-bets-test-"));
  const port = await unusedPort();
  const server = spawn(process.execPath, [path.join(__dirname, "server.js")], {
    cwd: __dirname,
    env: {
      ...process.env,
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: String(port),
      ADMIN_USERNAME: "test-admin",
      ADMIN_PASSWORD: "test-password-long-enough",
      SESSION_SECRET: "test-session-secret-0123456789-abcdef",
      DATA_FILE: path.join(directory, "fixtures.json"),
      PAYMENTS_FILE: path.join(directory, "payments.json"),
      ...extraEnv
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server did not start. Output: ${output}`)), 10_000);
    server.stdout.on("data", (chunk) => {
      output += chunk.toString();
      if (output.includes(`http://127.0.0.1:${port}`)) {
        clearTimeout(timer);
        resolve();
      }
    });
    server.stderr.on("data", (chunk) => { output += chunk.toString(); });
    server.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    server.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Server exited with code ${code}. Output: ${output}`));
    });
  });
  await ready;
  t.after(async () => {
    if (server.exitCode === null) {
      server.kill();
      await once(server, "exit");
    }
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { baseUrl: `http://127.0.0.1:${port}`, paymentsFile: path.join(directory, "payments.json") };
}

test("admin authentication protects fixture management and private tips", async (t) => {
  const { baseUrl } = await startServer(t);
  const origin = baseUrl;
  const publicBefore = await fetch(`${baseUrl}/api/fixtures`);
  assert.deepEqual(await publicBefore.json(), []);

  const unauthenticated = await fetch(`${baseUrl}/api/admin/fixtures`);
  assert.equal(unauthenticated.status, 401);

  const wrongLogin = await fetch(`${baseUrl}/api/admin/login`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ username: "test-admin", password: "wrong-password" })
  });
  assert.equal(wrongLogin.status, 401);

  const login = await fetch(`${baseUrl}/api/admin/login`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ username: "test-admin", password: "test-password-long-enough" })
  });
  assert.equal(login.status, 200);
  const loginData = await login.json();
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const csrf = loginData.csrfToken;
  const authenticatedHeaders = { Cookie: cookie, Origin: origin };

  const csrfMissing = await fetch(`${baseUrl}/api/admin/fixtures`, {
    method: "POST",
    headers: { ...authenticatedHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({})
  });
  assert.equal(csrfMissing.status, 403);

  const fixture = {
    league: "Test League",
    date: "2026-12-01",
    time: "12:30",
    home: "Test FC",
    away: "Demo United",
    analysis: "Public preview content.",
    tipTeaser: "VIP details for members.",
    vipTip: "Private VIP selection.",
    vvipTip: "Private VVIP selection.",
    published: true
  };
  const createdResponse = await fetch(`${baseUrl}/api/admin/fixtures`, {
    method: "POST",
    headers: { ...authenticatedHeaders, "Content-Type": "application/json", "X-CSRF-Token": csrf },
    body: JSON.stringify(fixture)
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();

  const publicFixturesResponse = await fetch(`${baseUrl}/api/fixtures`);
  const publicFixtures = await publicFixturesResponse.json();
  assert.equal(publicFixtures.length, 1);
  assert.equal(publicFixtures[0].tipTeaser, "VIP details for members.");
  assert.equal("vipTip" in publicFixtures[0], false);
  assert.equal("vvipTip" in publicFixtures[0], false);

  const adminFixturesResponse = await fetch(`${baseUrl}/api/admin/fixtures`, { headers: authenticatedHeaders });
  const adminFixtures = await adminFixturesResponse.json();
  assert.equal(adminFixtures[0].vipTip, "Private VIP selection.");
  assert.equal(adminFixtures[0].vvipTip, "Private VVIP selection.");

  const updatedFixture = { ...fixture, home: "Updated FC", published: false };
  const updatedResponse = await fetch(`${baseUrl}/api/admin/fixtures/${created.id}`, {
    method: "PUT",
    headers: { ...authenticatedHeaders, "Content-Type": "application/json", "X-CSRF-Token": csrf },
    body: JSON.stringify(updatedFixture)
  });
  assert.equal(updatedResponse.status, 200);
  assert.deepEqual(await (await fetch(`${baseUrl}/api/fixtures`)).json(), []);

  const deletedResponse = await fetch(`${baseUrl}/api/admin/fixtures/${created.id}`, {
    method: "DELETE",
    headers: { ...authenticatedHeaders, "X-CSRF-Token": csrf }
  });
  assert.equal(deletedResponse.status, 200);

  const logoutResponse = await fetch(`${baseUrl}/api/admin/logout`, {
    method: "POST",
    headers: { ...authenticatedHeaders, "Content-Type": "application/json", "X-CSRF-Token": csrf },
    body: "{}"
  });
  assert.equal(logoutResponse.status, 200);
  const afterLogout = await fetch(`${baseUrl}/api/admin/fixtures`, { headers: authenticatedHeaders });
  assert.equal(afterLogout.status, 401);
});

test("M-Pesa checkout validates the request, keeps the phone private, and accepts a callback", async (t) => {
  let stkPayload;
  const daraja = http.createServer(async (request, response) => {
    if (request.method === "GET" && request.url.startsWith("/oauth/v1/generate")) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ access_token: "mock-access-token", expires_in: 3600 }));
      return;
    }
    if (request.method === "POST" && request.url === "/mpesa/stkpush/v1/processrequest") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      stkPayload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        ResponseCode: "0",
        CheckoutRequestID: "ws_CO_mock_checkout_123",
        MerchantRequestID: "mock_merchant_123"
      }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  daraja.listen(0, "127.0.0.1");
  await once(daraja, "listening");
  t.after(async () => {
    await new Promise((resolve, reject) => daraja.close((error) => error ? reject(error) : resolve()));
  });
  const darajaAddress = daraja.address();
  const callbackToken = "abcdefghijklmnopqrstuvwxyzABCDEF";
  const { baseUrl, paymentsFile } = await startServer(t, {
    DARAJA_ENV: "sandbox",
    DARAJA_CONSUMER_KEY: "mock-consumer-key",
    DARAJA_CONSUMER_SECRET: "mock-consumer-secret",
    DARAJA_PASSKEY: "mock-passkey",
    DARAJA_SHORT_CODE: "123456",
    DARAJA_BUSINESS_TYPE: "paybill",
    DARAJA_CALLBACK_BASE_URL: "https://payments.example.com",
    DARAJA_CALLBACK_TOKEN: callbackToken,
    DARAJA_API_BASE_URL: `http://127.0.0.1:${darajaAddress.port}`
  });
  const configuration = await (await fetch(`${baseUrl}/api/payments/config`)).json();
  assert.deepEqual(configuration, { enabled: true, plans: { VIP: 300, VVIP: 500 } });

  const rejected = await fetch(`${baseUrl}/api/payments/stk`, {
    method: "POST",
    headers: { Origin: baseUrl, "Content-Type": "application/json" },
    body: JSON.stringify({ phone: "0712345678", plan: "VIP", authorized: false })
  });
  assert.equal(rejected.status, 400);

  const invalidPhone = await fetch(`${baseUrl}/api/payments/stk`, {
    method: "POST",
    headers: { Origin: baseUrl, "Content-Type": "application/json" },
    body: JSON.stringify({ phone: "070598302", plan: "VIP", authorized: true })
  });
  assert.equal(invalidPhone.status, 400);

  const checkout = await fetch(`${baseUrl}/api/payments/stk`, {
    method: "POST",
    headers: { Origin: baseUrl, "Content-Type": "application/json" },
    body: JSON.stringify({ phone: "0712345678", plan: "VIP", authorized: true })
  });
  assert.equal(checkout.status, 202);
  const payment = await checkout.json();
  assert.equal(payment.status, "awaiting_customer");
  assert.equal(payment.amount, 300);
  assert.equal(stkPayload.PhoneNumber, "254712345678");
  assert.equal(stkPayload.Amount, 300);
  assert.equal(stkPayload.TransactionType, "CustomerPayBillOnline");
  assert.match(stkPayload.CallBackURL, new RegExp(`/api/payments/callback/${callbackToken}$`));
  assert.equal("Password" in stkPayload, true);

  const pendingResponse = await fetch(`${baseUrl}${payment.statusUrl}`);
  const pending = await pendingResponse.json();
  assert.equal(pending.status, "awaiting_customer");
  assert.equal("phone" in pending, false);

  const callbackUrl = new URL(stkPayload.CallBackURL);
  const callback = await fetch(`${baseUrl}${callbackUrl.pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      Body: {
        stkCallback: {
          CheckoutRequestID: "ws_CO_mock_checkout_123",
          ResultCode: 0,
          ResultDesc: "The service request is successful",
          CallbackMetadata: { Item: [{ Name: "MpesaReceiptNumber", Value: "QAB123XYZ" }] }
        }
      }
    })
  });
  assert.equal(callback.status, 200);
  const paid = await (await fetch(`${baseUrl}${payment.statusUrl}`)).json();
  assert.equal(paid.status, "paid");
  assert.equal(paid.message, "Payment confirmed.");
  assert.equal("receiptNumber" in paid, false);

  const storedRequests = await fs.readFile(paymentsFile, "utf8");
  assert.equal(storedRequests.includes("0712345678"), false);
  assert.equal(storedRequests.includes("254712345678"), false);
  assert.equal(storedRequests.includes("mock-access-token"), false);
});

test("M-Pesa checkout stays disabled until Daraja credentials and HTTPS callback are configured", async (t) => {
  const { baseUrl } = await startServer(t);
  const configuration = await (await fetch(`${baseUrl}/api/payments/config`)).json();
  assert.equal(configuration.enabled, false);
  assert.deepEqual(configuration.plans, { VIP: 300, VVIP: 500 });

  const checkout = await fetch(`${baseUrl}/api/payments/stk`, {
    method: "POST",
    headers: { Origin: baseUrl, "Content-Type": "application/json" },
    body: JSON.stringify({ phone: "0712345678", plan: "VIP", authorized: true })
  });
  assert.equal(checkout.status, 503);
});

test("public site starts while admin access remains disabled until its secrets are set", async (t) => {
  const { baseUrl } = await startServer(t, {
    ADMIN_USERNAME: "",
    ADMIN_PASSWORD: "",
    SESSION_SECRET: ""
  });
  const session = await (await fetch(`${baseUrl}/api/admin/session`)).json();
  assert.deepEqual(session, { authenticated: false, configured: false });

  const login = await fetch(`${baseUrl}/api/admin/login`, {
    method: "POST",
    headers: { Origin: baseUrl, "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "anything" })
  });
  assert.equal(login.status, 503);
  assert.match((await login.json()).error, /Admin sign-in is disabled/);

  const paymentConfiguration = await (await fetch(`${baseUrl}/api/payments/config`)).json();
  assert.equal(paymentConfiguration.enabled, false);
});
