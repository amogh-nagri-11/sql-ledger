import { useEffect, useState } from "react";
import { type Account, getStatement, type Statement } from "../api.js";
import { formatMoney } from "../money.js";

export function AccountStatement({
  accounts,
  refreshKey,
}: {
  accounts: Account[];
  refreshKey: number;
}) {
  const [selected, setSelected] = useState("");
  const [statement, setStatement] = useState<Statement | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Default to the first account once the list arrives.
  useEffect(() => {
    if (!selected && accounts.length > 0) setSelected(accounts[0].name);
  }, [accounts, selected]);

  useEffect(() => {
    if (!selected) return;
    let active = true;
    getStatement(selected)
      .then((s) => active && (setStatement(s), setError(null)))
      .catch((e) => active && setError(String(e.message ?? e)));
    return () => {
      active = false;
    };
  }, [selected, refreshKey]);

  return (
    <div className="card">
      <h2>Account statement</h2>

      <label>
        Account
        <select value={selected} onChange={(e) => setSelected(e.target.value)}>
          {accounts.map((a) => (
            <option key={a.id} value={a.name}>
              {a.name} ({a.type})
            </option>
          ))}
        </select>
      </label>

      {error && <div className="status status--err">{error}</div>}

      {statement && (
        <>
          <div className="statement__balance">
            Current balance: <strong>{formatMoney(statement.balance)}</strong>
          </div>
          <table className="statement">
            <thead>
              <tr>
                <th>When</th>
                <th>Description</th>
                <th>Dir</th>
                <th className="num">Amount</th>
                <th className="num">Running</th>
              </tr>
            </thead>
            <tbody>
              {statement.entries.length === 0 && (
                <tr>
                  <td colSpan={5} className="muted">No entries yet.</td>
                </tr>
              )}
              {statement.entries.map((e) => (
                <tr key={e.entryId}>
                  <td>{new Date(e.createdAt).toLocaleString()}</td>
                  <td>{e.description ?? <span className="muted">—</span>}</td>
                  <td>{e.direction}</td>
                  <td className={`num ${e.effect < 0 ? "neg" : "pos"}`}>
                    {e.effect < 0 ? "-" : "+"}
                    {formatMoney(e.amount)}
                  </td>
                  <td className="num">{formatMoney(e.runningBalance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
