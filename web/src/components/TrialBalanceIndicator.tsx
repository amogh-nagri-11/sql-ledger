import { useEffect, useState } from "react";
import { getTrialBalance, type TrialBalance } from "../api.js";
import { formatMoney } from "../money.js";

// The centerpiece: visually proves SUM(all entries) === 0. Polls on an interval
// AND refetches whenever a transaction is posted (via the refreshKey prop).
export function TrialBalanceIndicator({ refreshKey }: { refreshKey: number }) {
  const [tb, setTb] = useState<TrialBalance | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const load = () =>
      getTrialBalance()
        .then((data) => active && (setTb(data), setError(null)))
        .catch((e) => active && setError(String(e.message ?? e)));

    load();
    const timer = setInterval(load, 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [refreshKey]);

  if (error) {
    return <div className="indicator indicator--error">API unreachable: {error}</div>;
  }
  if (!tb) {
    return <div className="indicator indicator--loading">Checking ledger…</div>;
  }

  return (
    <div className={`indicator ${tb.balanced ? "indicator--ok" : "indicator--bad"}`}>
      <div className="indicator__headline">
        {tb.balanced ? "✓ Ledger balanced" : `✗ Ledger off by ${formatMoney(tb.net)}`}
      </div>
      <div className="indicator__detail">
        debits {formatMoney(tb.totalDebits)} &nbsp;·&nbsp; credits {formatMoney(tb.totalCredits)}
        &nbsp;·&nbsp; net {formatMoney(tb.net)}
      </div>
    </div>
  );
}
