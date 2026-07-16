-- A transaction is the atomic unit of a ledger post. It groups two or more
-- ledger_entries whose signed amounts must sum to zero.
--
-- idempotency_key is UNIQUE: retrying the same logical post (same key) can never
-- create a second transaction. That uniqueness is enforced by the DB, not by
-- app-level "check then insert", so it holds even under concurrent retries.
CREATE TABLE transactions (
    id              BIGSERIAL PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    description     TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
