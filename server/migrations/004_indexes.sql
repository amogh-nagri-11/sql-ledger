-- Balance queries scan all entries for one account; the (account_id, created_at)
-- index also serves point-in-time queries ("balance as of <timestamp>").
CREATE INDEX idx_ledger_entries_account      ON ledger_entries (account_id);
CREATE INDEX idx_ledger_entries_account_time ON ledger_entries (account_id, created_at);

-- Fetching every leg of a transaction (e.g. idempotent replay response).
CREATE INDEX idx_ledger_entries_transaction  ON ledger_entries (transaction_id);
