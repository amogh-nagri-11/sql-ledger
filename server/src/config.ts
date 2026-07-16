export const config = {
  databaseUrl:
    process.env.DATABASE_URL ?? "postgres://ledger:ledger@localhost:5432/ledger",
  port: Number(process.env.PORT ?? 3000),
};
