# Pocket · Personal finance, in perspective

A personal finance app for Akash, built entirely with **JavaScript**: React + Vite, Express + Node.js, and Node’s built-in SQLite driver. No Python, TypeScript, cloud account, or AI API key is required. Fonts are bundled locally; the app makes no external service calls.

## Start here

Requires **Node.js 24 or newer** and npm.

1. Install dependencies with `npm install`.
2. Start development with `npm run dev`.
3. Open **http://127.0.0.1:5173** (use the address printed by Vite if that port is occupied).
4. In a separate terminal, run `npm run setup-owner`. Choose your username and a unique password/passphrase of at least 14 characters. Password entry is hidden. Never send credentials in chat or commit them to Git.
5. Sign in, then add an account with its opening balance and add income and expenses. Or choose **Try demo data** in the empty app to explore sample records.

For everyday use, run `npm run build`, then `npm start` and open **http://localhost:3001**. Keep the Node process running while using Pocket. `npm test` runs the financial and API regression tests.

## Included

- Responsive dashboard with cumulative income/spending charts, category breakdowns, and recent activity.
- Add, edit, delete, search, and filter transactions by month, category, and account. Custom categories and negative account balances are supported.
- Fixed monthly spending plans with automatic positive **and negative** carryover, plus named category budgets that combine selected categories (for example, Essentials: Food, Utilities, and Rent).
- Create custom transaction categories and use them in transactions and category budgets; categories are saved with the finance data.
- Monthly, deadline-based, and no-deadline goals for savings or debt payoff, contribution history, and achieved/abandoned status.
- Investment assets and liabilities with manual valuation history, gains/losses, and total net worth.
- Bank/account balances and month-by-month reports; filtered transaction CSV export with spreadsheet formula protection.
- Local smart-entry suggestions, keyword categorization, recent-history budget suggestions, anomaly flags, and spending comparisons. These are transparent **rule-based helpers**, not an LLM or financial advice.
- Persistent dark mode, keyboard-accessible dialogs, labeled form controls, and mobile navigation.
- Single-owner login with no public registration, salted scrypt password hashing, rate-limited sign-in, and revocable 12-hour server-side sessions in HttpOnly, SameSite cookies.

## Financial conventions

- Currency is **INR (₹)**. Multi-currency is not included.
- Account balances and net worth are **current, all-time** figures, including all recorded transactions. The month picker scopes activity, reports, budgeting, and monthly goal progress; it does not reconstruct historic net worth.
- Opening balances are starting balances before recorded transactions. Income increases an account, expenses decrease it. Negative credit-account balances represent debt.
- Investment assets must be separate from bank balances. Do not record the same debt as both a negative account balance and an investment liability.
- Budget available = monthly base + prior carryover. Remaining = available − that month’s expenses. Income does not increase the spending allowance. Carryover starts in the first budget’s effective month, including months without transactions; editing prior transactions recalculates subsequent months.
- Category budgets apply their monthly limit to the combined expenses in selected categories and repeat from the selected start month. Carryover and inclusion in the Overview total are configurable per budget. Each category can belong to one category budget at a time.
- Goal progress entries are dated logs and affect net worth as virtual balances: savings progress adds a fund, while debt goals subtract the unpaid balance (target minus payments). Monthly goals display the selected month's progress and retain a lifetime fund. These entries do not move account cash; avoid counting the same savings or debt in both a goal and an account/investment. Budget logs are derived from matching expense transactions, not duplicated records.
- Investment values are manual, not market feeds. Each changed value is appended to its valuation history. Cost basis is user-entered and not a tax calculation.
- Smart entry understands descriptions such as “Spent 450 on groceries from HDFC Bank on 2026-10-02”. Dates must use YYYY-MM-DD; missing or unrecognized dates default to today. **Always review the suggestion** before saving.
- Suggested budgets use the last three recorded spending months before the selected month. Anomalies need at least three prior expenses in the category and flag amounts above twice the recent average. Partial months may skew comparisons.
- Amounts accept up to two decimal places; core balance, budget, and goal calculations use integer minor units.

## Privacy, phone access, and backups

By default the app binds only to your own computer (`HOST=127.0.0.1`). `.env` retains this safe default; `.env.example` documents deployment settings. Owner credentials live as a salted password hash in SQLite, never in frontend code or `.env`. All finance API routes, including CSV export, require authentication. An unconfigured app is locked until you create the owner from the terminal; there is no public setup or registration endpoint.

The interface works on phone browsers, but no installable PWA/offline service worker is included. For phone access use the HTTPS deployment below; avoid sending your owner password over unencrypted LAN HTTP.

### Deploy online with HTTPS

1. Use a Node.js 24+ host with a **persistent disk** and one running application instance. This SQLite app is not designed for ephemeral/serverless storage or multiple replicas. Mount the database outside the publicly served `dist` directory.
2. Run `npm ci` and `npm run build`. Run `npm start` as the service command (not the Vite development server).
3. Set `NODE_ENV=production`, `HOST=0.0.0.0` (or the internal bind address required by your host), `PORT` as required by the host, `PUBLIC_ORIGIN` to your exact **HTTPS origin without a trailing slash**, and `DATABASE_PATH` to the SQLite file on the persistent disk. The app refuses production startup without an HTTPS origin.
4. Configure a TLS-terminating reverse proxy / managed HTTPS endpoint. Set `TRUST_PROXY_HOPS` to the actual number of trusted proxy hops (commonly `1`). The proxy must overwrite forwarded headers. **Block direct public access to the Node port**; only the trusted proxy should reach it. Incorrect proxy trust can break HTTPS detection and IP-based rate limiting.
5. In the host’s private shell, run `npm run setup-owner` with the same `DATABASE_PATH` environment. Choose credentials there, then sign in through the HTTPS URL. Production cookies use `Secure`, `HttpOnly`, `SameSite=Strict`, and a `__Host-` prefix. There is no default password.
6. Verify `/api/state` and `/api/export` return 401 when signed out. Restrict server/backup access, keep dependencies patched, and use encrypted disks/backups. Don’t configure proxy/CDN caching for `/api` responses or log request bodies / cookies.

Forgot your password, or need to revoke access? Run `npm run setup-owner` again in the server terminal. It replaces the owner credentials and revokes **all device sessions** without deleting financial data. Sign out revokes the current device’s session. Sessions have a fixed 12-hour lifetime; expired sessions return the UI to login. Credentials and session hashes persist across restarts in SQLite. No plaintext passwords or raw session tokens are stored in the database, and no authentication tokens are kept in browser localStorage.

Login is limited to 10 attempts per IP and 50 globally per 15 minutes per application process; successful logins count too. Limits reset after a restart. For public deployment add edge rate limiting / abuse protection at your host, and consider a VPN or an MFA-enabled access gateway for stronger protection. This is password-based owner authentication, not a guarantee against a compromised password, device, or server. The app does not itself terminate TLS or encrypt SQLite.

Data lives in **`data/pocket.sqlite`**, not browser storage. The folder is excluded from Git. For a full backup, stop the app and copy the `data` directory somewhere secure. Restore it while the app is stopped. CSV export covers transactions only, not a restorable full backup. Demo records live in the same database as personal records: use demo only before entering real data; to start completely fresh, stop the app, back up if needed, and remove the demo `data` directory manually.

## Structure

- `src/main.jsx` — React views, forms, and charts.
- `src/styles.css` — responsive design and themes.
- `server/app.js` — validated API, smart-entry review, CSV export.
- `server/finance.js` — independently tested financial calculations.
- `server/store.js` — prepared-statement SQLite persistence.
- `server/index.js` — local server and production static hosting.
- `server/auth.js` — owner authentication, session verification, and login rate limits.
- `server/setup-owner.js` — interactive, terminal-only owner creation/password reset.
- `src/AuthGate.jsx` — login page, logout, and session-expiry UI.
- `server/*.test.js` — API and calculation regression tests using temporary/in-memory databases; tests never touch personal data.

SQLite is marked experimental by the installed Node.js 24.4 runtime and may print a warning. No third-party bank integration, automatic funds transfers, multi-user support, OCR, or investment advice is included.