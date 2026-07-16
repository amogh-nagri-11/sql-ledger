-- The append-only heart of the ledger. One row per leg of a transaction.
--
-- Money is stored as BIGINT in the smallest currency unit (e.g. cents) and is
-- always POSITIVE; the sign is carried by `direction`. No mutable balance is
-- ever stored anywhere — balances are always DERIVED by summing these rows.
CREATE TYPE entry_direction AS ENUM ('debit', 'credit');

CREATE TABLE ledger_entries (
    id             BIGSERIAL PRIMARY KEY,
    transaction_id BIGINT NOT NULL REFERENCES transactions(id) ON DELETE RESTRICT,
    account_id     BIGINT NOT NULL REFERENCES accounts(id)     ON DELETE RESTRICT,
    amount         BIGINT NOT NULL CHECK (amount > 0),
    direction      entry_direction NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
