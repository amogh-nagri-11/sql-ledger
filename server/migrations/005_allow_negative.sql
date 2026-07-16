-- Some accounts must never go negative (e.g. a customer's cash balance — you
-- can't spend money you don't have). Others legitimately can. This per-account
-- flag drives the overdraft check in the write path. Default true keeps the
-- existing accounts unconstrained.
ALTER TABLE accounts ADD COLUMN allow_negative BOOLEAN NOT NULL DEFAULT true;
