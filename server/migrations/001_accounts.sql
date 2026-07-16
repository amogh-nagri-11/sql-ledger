-- Chart of accounts. Each account has a type that determines whether a debit
-- or a credit increases its balance (see the balance query in the app layer).
CREATE TYPE account_type AS ENUM ('asset', 'liability', 'equity', 'revenue', 'expense');

CREATE TABLE accounts (
    id         BIGSERIAL PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE,          -- e.g. 'user:alice', 'revenue', 'fees_payable'
    type       account_type NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
