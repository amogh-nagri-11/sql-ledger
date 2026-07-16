# Double-Entry Ledger Engine

A double-entry accounting ledger built on **PostgreSQL + raw SQL**, wrapped in a
**Node/Express/TypeScript** API and a small **React** dashboard. Balances are
never stored — they are *derived* by summing immutable journal entries — and the
core invariant (every account's books net to zero) is proven under real
concurrency, not just asserted.

> The database design is the hard part; the app layer is plumbing. No ORM is
> used anywhere, on purpose — the SQL is the thing worth showing.

---

## Why this exists / core ideas

- **Double-entry:** every transaction is two or more *legs* whose signed amounts
  sum to zero. Money is only ever moved, never created or destroyed.
- **Derived balances, never stored:** there is no mutable `balance` column
  anywhere — not even as a cache. An account's balance is `SUM` of its entries
  under the normal-balance rule. This makes **point-in-time balances** ("what
  was my balance last Tuesday?") fall out for free: it's the same query with a
  `created_at <= $asOf` cutoff.
- **Integer money:** amounts are `BIGINT` in the smallest currency unit (cents).
  No floats touch money anywhere — the frontend divides by 100 *only* at render.
- **Idempotency is a database guarantee:** each transaction carries a unique
  `idempotency_key`. Replays return the original transaction instead of
  double-posting, and this holds even under concurrent retries because it's
  enforced by a `UNIQUE` constraint, not app-level check-then-write.

---

## Schema

```
accounts                      transactions                 ledger_entries
--------                      ------------                 --------------
id             BIGSERIAL PK   id              BIGSERIAL PK  id             BIGSERIAL PK
name           TEXT UNIQUE    idempotency_key TEXT UNIQUE   transaction_id BIGINT FK -> transactions
type           account_type   description     TEXT          account_id     BIGINT FK -> accounts
allow_negative BOOLEAN        created_at      TIMESTAMPTZ   amount         BIGINT  CHECK (amount > 0)
created_at     TIMESTAMPTZ                                  direction      entry_direction ('debit'|'credit')
                                                            created_at     TIMESTAMPTZ
```

```
transactions 1 ────< N ledger_entries N >──── 1 accounts
```

- `account_type` enum: `asset | liability | equity | revenue | expense`.
- `entry_direction` enum: `debit | credit`. `amount` is always positive; the
  sign is carried by the direction.
- **Normal-balance rule:** for `asset`/`expense` accounts a *debit* increases
  the balance; for `liability`/`revenue`/`equity` a *credit* does.
- Indexes: `ledger_entries(account_id)`, `ledger_entries(account_id, created_at)`
  (serves point-in-time queries), `ledger_entries(transaction_id)`.

---

## The write path (`postTransaction`)

Two guarantees that matter regardless of language:

1. **Balance check happens in app code before any DB round trip** — an
   unbalanced transaction fails fast and never opens a database transaction.
2. **Idempotency check → account resolution → inserts all happen inside ONE
   database transaction.** If anything fails partway, the whole thing rolls
   back — a half-written transaction can never exist.

If two requests with the same idempotency key race past the initial existence
check, one loses the `UNIQUE` insert (`23505`); that's caught and turned into an
idempotent replay of the winner, not an error.

---

## Concurrency proof (not a claim)

The one piece of evidence that separates this from "tables with foreign keys."
100 transfers are fired concurrently with `Promise.all` against real (Dockerized)
Postgres, then the invariant is asserted:

```
 ✓ test/ledger.integration.test.ts (4 tests)
   ✓ concurrency (real Postgres) > 100 concurrent transfers keep the ledger balanced
   ✓ concurrency (real Postgres) > concurrent posts with the SAME idempotency key create exactly one transaction
   ✓ negative-balance prevention (real Postgres) > rejects a single overdraw
   ✓ negative-balance prevention (real Postgres) > under 100 concurrent $1 withdrawals from a $50 wallet, exactly 50 succeed and it never goes negative

 Test Files  1 passed (1)
      Tests  4 passed (4)
```

- **100 concurrent transfers** → all commit as distinct transactions, the
  ledger still nets to zero, and the two accounts moved by exactly ±100. No lost
  or double updates.
- **Same-key race** → 25 concurrent posts with one idempotency key resolve to a
  single transaction (1 real write + 24 replays); the DB holds 1 transaction /
  2 entries, not 25.

> Note: all DB-backed tests live in a single file so they run strictly
> sequentially against the shared database. Splitting them across files let
> Vitest overlap two files' concurrent writes — a test-isolation artifact, not a
> ledger bug (a standalone harness ran 2,000 concurrent posts with zero loss).

---

## Negative-balance prevention (stretch)

Accounts flagged `allow_negative = false` cannot be overdrawn. Because there is
no stored balance to lock, the write path takes a **row lock on the account**
(`SELECT … FOR UPDATE`) *before* reading the derived balance. That lock
serializes every concurrent writer touching the account, so the check-then-write
is atomic even though the balance is computed on the fly. Locks are acquired in
ascending account-id order to avoid deadlocks across multi-account posts.

Proven by the test above: 100 concurrent $1 withdrawals from a $50 wallet →
**exactly 50 succeed, 50 are rejected, and the balance never goes below zero.**

> Alternative approach: `SERIALIZABLE` isolation + retry-on-serialization-failure.
> `FOR UPDATE` is used here because it's targeted and needs no retry loop.

---

## API

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/health` | Liveness + DB reachability |
| `GET`  | `/accounts` | Chart of accounts |
| `POST` | `/transactions` | Post a balanced transaction (Zod-validated) |
| `GET`  | `/accounts/:name/balance?asOf=` | Current or point-in-time balance |
| `GET`  | `/ledger/trial-balance?asOf=` | Whole-ledger invariant check |
| `GET`  | `/accounts/:name/statement?limit=&asOf=` | Entry history with running balance |
| `GET`  | `/accounts/:name/reconcile?expected=` | Compare ledger balance to an external figure |

Post a transaction:

```bash
curl -X POST http://localhost:3000/transactions \
  -H 'Content-Type: application/json' \
  -d '{
    "idempotencyKey": "demo-1",
    "description": "alice -> bob 500",
    "legs": [
      { "account": "user:bob",   "direction": "debit",  "amount": 500 },
      { "account": "user:alice", "direction": "credit", "amount": 500 }
    ]
  }'
```

---

## Running it

Requires Docker and Node 20+.

```bash
# 1. Start Postgres
docker compose up -d db

# 2. Backend (from ./server)
cd server
npm install
npm run migrate      # applies migrations/*.sql via a tiny raw-SQL runner
npm run seed         # inserts demo accounts
npm run start        # API on http://localhost:3000
npm test             # concurrency + negative-balance suite (real Postgres)

# 3. Frontend (from ./web)
cd ../web
npm install
npm run dev          # dashboard on http://localhost:5173
```

Ops guardrail — a cron-style trial-balance health check:

```bash
cd server
npm run healthcheck            # loops every 60s, alerts if the ledger is ever off
npm run healthcheck -- --once  # single check then exit (nonzero exit on failure)
```

---

## Dashboard

Three views (no router, no heavy state library):

1. **Post a transaction** — pick From (credited) → To (debited), amount, submit.
2. **Live trial-balance indicator** — polls every few seconds and refetches after
   each post; shows a big green "✓ Ledger balanced" or red "off by $X". This is
   the piece that visually proves the invariant.
3. **Account statement** — entries newest-first with a per-row running balance.

---

## Project structure

```
ledger-sql/
├── docker-compose.yml          # Postgres 16 (+ optional api service)
├── server/
│   ├── migrations/             # 001..005 raw .sql files
│   ├── src/
│   │   ├── index.ts            # Express app + routes
│   │   ├── ledger.ts           # domain logic (post, balance, statement, reconcile)
│   │   ├── schemas.ts          # Zod request validation
│   │   ├── db.ts               # pg Pool + withTransaction()
│   │   └── scripts/            # migrate, seed, health-check
│   └── test/
│       └── ledger.integration.test.ts
└── web/                        # React + Vite dashboard
```

## Design constraints (deliberately kept)

- No ORM (Prisma/Sequelize/TypeORM) — it would hide the queries being showcased.
- No stored `balance` column, ever — not even as a cache. The correct scaling
  step would be a snapshot-plus-replay pattern, not a mutable column.
- No floats for money — integers everywhere, divide only at render.
