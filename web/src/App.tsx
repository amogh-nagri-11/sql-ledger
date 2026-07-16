import { useCallback, useEffect, useState } from "react";
import { type Account, listAccounts } from "./api.js";
import { AccountStatement } from "./components/AccountStatement.js";
import { PostTransactionForm } from "./components/PostTransactionForm.js";
import { TrialBalanceIndicator } from "./components/TrialBalanceIndicator.js";

export function App() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Bumped after every successful post to trigger dependent refetches.
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    listAccounts()
      .then(setAccounts)
      .catch((e) => setLoadError(String(e.message ?? e)));
  }, []);

  const onPosted = useCallback(() => setRefreshKey((k) => k + 1), []);

  return (
    <main className="app">
      <header>
        <h1>Double-Entry Ledger</h1>
        <p className="subtitle">
          Balances are derived from immutable entries — no stored balance column anywhere.
        </p>
      </header>

      <TrialBalanceIndicator refreshKey={refreshKey} />

      {loadError && (
        <div className="status status--err">
          Could not load accounts: {loadError}. Is the API running on :3000?
        </div>
      )}

      <div className="grid">
        <PostTransactionForm accounts={accounts} onPosted={onPosted} />
        <AccountStatement accounts={accounts} refreshKey={refreshKey} />
      </div>
    </main>
  );
}
