# Deta Infra

Multichain wallet infrastructure powered by [IKA SDK](https://docs.ika.xyz) (dWallet Network).

Handles Google identity onboarding, DKG-based wallet provisioning, and deterministic address derivation for **Sui, EVM, Solana, and Bitcoin**.

---

## Prerequisites

- **Node.js** ≥ 20
- **PostgreSQL** ≥ 15
- **Python 3** (only for serving the test client)

Redis is optional — default queue mode is `inline`.

---

## Setup

```bash
npm install
cp .env.example .env
```

Fill in the required values in `.env`:

| Variable | What it is |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `APP_JWT_SECRET` | Random string (≥ 16 chars) for session JWTs |
| `IKA_SUI_RPC_URL` | Sui RPC endpoint |
| `IKA_SIGNER_SECRET_KEY_BASE64` | Base64 sponsor keypair |
| `IKA_USER_SHARE_ROOT_SEED_BASE64` | Base64 32-byte root seed |

Everything else has sensible defaults — see `.env.example`.

### Database

```bash
# Push schema directly (quickest for dev)
npm run db:push

# Or use migrations
npm run db:generate
npm run db:migrate
```

---

## Run the Backend

```bash
npm run dev
```

Starts on **http://localhost:5050**. Health check: `GET /healthz`.

---

## Run the Test Client

The test client is a plain HTML page in `test-client/`. It's just for exercising the API — not a real frontend.

```bash
cd test-client
py -3 -m http.server 5174 --bind 127.0.0.1
```

Open **http://localhost:5174**.

### Google Auth flow

1. Enter your Google Client ID and click **Initialize Google**.
2. Click the Google sign-in button.
3. The client calls the backend, gets a session token, and polls until addresses appear.

### Dev Bypass (no Google needed)

Click **Create Wallet** in the Dev Bypass section. It creates a fake identity, provisions a wallet, and polls for addresses — no Google account required.

> The dev bypass endpoint (`POST /v1/dev/create-wallet`) is only active when `NODE_ENV` is not `production`.

---

## API Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/v1/auth/google/continue` | — | Exchange Google ID token for session |
| `GET` | `/v1/wallets/me` | Bearer | Wallet info |
| `GET` | `/v1/wallets/me/addresses` | Bearer | Derived addresses |
| `GET` | `/v1/wallets/me/provisioning-status` | Bearer | Poll provisioning status |
| `POST` | `/v1/dev/create-wallet` | — | Dev bypass (non-production only) |
| `GET` | `/healthz` | — | Health check |

---

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start with auto-reload (tsx watch) |
| `npm run build` | Compile TypeScript |
| `npm start` | Run compiled output |
| `npm test` | Run test suite (vitest) |
| `npm run db:push` | Push schema to DB |
| `npm run db:generate` | Generate migrations |
| `npm run db:migrate` | Apply migrations |
