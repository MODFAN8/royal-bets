# Royal Bets

Royal Bets is a football tips storefront with a Node.js server for publishing match previews and a private admin dashboard.

## Run locally

Requirements: Node.js 20.6 or newer.

1. Copy `.env.example` to `.env` (`Copy-Item .env.example .env` in PowerShell).
2. Set `ADMIN_USERNAME` and a unique `ADMIN_PASSWORD` of at least 14 characters.
3. Generate a session secret with `node -e "process.stdout.write(require('node:crypto').randomBytes(48).toString('base64url'))"` and place the output in `SESSION_SECRET`.
4. Keep `.env` private and never commit or share it.
5. Run `npm start`.
6. Open `http://127.0.0.1:3000`. To post matches, open `http://127.0.0.1:3000/admin`.

The server stores fixtures in `data/fixtures.json`. The public website uses `GET /api/fixtures`; the private dashboard uses authenticated `/api/admin/*` routes. Paid VIP and VVIP tips are only returned by the authenticated admin API, never the public fixture API.

## Production deployment

Deploy the Node.js server over HTTPS. Configure the environment variables in the host's secret settings, set `NODE_ENV=production`, and use a persistent disk for `DATA_FILE`. Run one server instance: fixture data is file-backed and login sessions are held in memory, so a restart signs the admin out. Use a managed database and shared session store before running multiple instances or hosting subscriber-only access.

The admin password and session secret are server environment secrets; they are not entered into or bundled with the website. Do not expose the server on an unsecured public network or deploy without HTTPS.

## Membership/payment status

VIP and VVIP checkout sends the phone number to Safaricom Daraja with an STK request; the customer enters their PIN only in Safaricom's official M-Pesa prompt. Royal Bets does not save the customer's phone number or PIN. The callback stores payment status and receipt identifiers in `PAYMENTS_FILE`; use a private persistent disk and protect backups because these are transaction records. An STK payment alone does not yet provision a subscriber account or unlock private tips automatically.

Checkout stays disabled unless all Daraja settings are valid. For sandbox testing, obtain test credentials from Safaricom Daraja and configure:

- `DARAJA_ENV`: `sandbox` for test transactions, or `production` only after Safaricom approval.
- `DARAJA_CONSUMER_KEY`, `DARAJA_CONSUMER_SECRET`, and `DARAJA_PASSKEY`: Safaricom-issued credentials. Store them only in host secrets or the ignored local `.env` file.
- `DARAJA_SHORT_CODE` and `DARAJA_BUSINESS_TYPE`: the actual Safaricom-issued Paybill or Till shortcode and its type. This is not a personal phone number.
- `DARAJA_CALLBACK_BASE_URL`: the server's public HTTPS origin, with no path (for example `https://api.example.com`). Localhost cannot receive production callbacks.
- `DARAJA_CALLBACK_TOKEN`: a random URL-safe secret of 32–128 characters; generate one with `node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))"`.
- `DARAJA_ACCOUNT_REFERENCE`: a short Paybill account reference, at most 12 characters.

The callback must be publicly reachable over HTTPS before checkout can be enabled. Do not test by sending a real production STK request. The public status endpoint uses an unguessable request ID; it does not expose a customer number. Admin dashboard sign-in and subscriber membership authentication are separate features.

## Tests

Run `npm test` for the HTTP authentication, CSRF, fixture privacy, CRUD, and mocked Daraja checkout integration tests.
