import { useState } from "react";
import { type Account, postTransaction } from "../api.js";
import { dollarsToCents } from "../money.js";

// Frames a raw double-entry post as an intuitive transfer: money leaves the
// "from" account (credit) and lands in the "to" account (debit), same amount,
// so the two legs always sum to zero.
export function PostTransactionForm({
  accounts,
  onPosted,
}: {
  accounts: Account[];
  onPosted: () => void;
}) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setStatus(null);

    const cents = dollarsToCents(amount);
    if (!from || !to) return setStatus({ kind: "err", msg: "Pick both accounts." });
    if (from === to) return setStatus({ kind: "err", msg: "Accounts must differ." });
    if (cents === null) return setStatus({ kind: "err", msg: "Amount must be a positive number." });

    setBusy(true);
    try {
      await postTransaction({
        idempotencyKey: crypto.randomUUID(),
        description: description || undefined,
        legs: [
          { account: to, direction: "debit", amount: cents },
          { account: from, direction: "credit", amount: cents },
        ],
      });
      setStatus({ kind: "ok", msg: "Posted ✓" });
      setAmount("");
      setDescription("");
      onPosted();
    } catch (err) {
      setStatus({ kind: "err", msg: String((err as Error).message ?? err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <h2>Post a transaction</h2>

      <label>
        From (credited)
        <select value={from} onChange={(e) => setFrom(e.target.value)}>
          <option value="">— select —</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.name}>
              {a.name} ({a.type})
            </option>
          ))}
        </select>
      </label>

      <label>
        To (debited)
        <select value={to} onChange={(e) => setTo(e.target.value)}>
          <option value="">— select —</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.name}>
              {a.name} ({a.type})
            </option>
          ))}
        </select>
      </label>

      <label>
        Amount (USD)
        <input
          type="text"
          inputMode="decimal"
          placeholder="0.00"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </label>

      <label>
        Description (optional)
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>

      <button type="submit" disabled={busy}>
        {busy ? "Posting…" : "Post transaction"}
      </button>

      {status && (
        <div className={status.kind === "ok" ? "status status--ok" : "status status--err"}>
          {status.msg}
        </div>
      )}
    </form>
  );
}
