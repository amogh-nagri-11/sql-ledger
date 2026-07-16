// The API base defaults to the local server; override with VITE_API_URL.
const BASE = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

export interface Account {
  id: number;
  name: string;
  type: string;
}

export interface TrialBalance {
  balanced: boolean;
  net: number;
  totalDebits: number;
  totalCredits: number;
  asOf: string;
}

export interface StatementEntry {
  entryId: number;
  transactionId: number;
  direction: "debit" | "credit";
  amount: number;
  effect: number;
  runningBalance: number;
  description: string | null;
  createdAt: string;
}

export interface Statement {
  account: string;
  accountType: string;
  balance: number;
  entries: StatementEntry[];
}

export interface Leg {
  account: string;
  direction: "debit" | "credit";
  amount: number;
}

async function json<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (body as { message?: string; error?: string }).message ??
      (body as { error?: string }).error ??
      `Request failed (${res.status})`;
    throw new Error(msg);
  }
  return body as T;
}

export function listAccounts(): Promise<Account[]> {
  return fetch(`${BASE}/accounts`).then((r) => json<Account[]>(r));
}

export function getTrialBalance(): Promise<TrialBalance> {
  return fetch(`${BASE}/ledger/trial-balance`).then((r) => json<TrialBalance>(r));
}

export function getStatement(account: string): Promise<Statement> {
  return fetch(`${BASE}/accounts/${encodeURIComponent(account)}/statement`).then((r) =>
    json<Statement>(r),
  );
}

export function postTransaction(input: {
  idempotencyKey: string;
  description?: string;
  legs: Leg[];
}): Promise<unknown> {
  return fetch(`${BASE}/transactions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }).then((r) => json(r));
}
