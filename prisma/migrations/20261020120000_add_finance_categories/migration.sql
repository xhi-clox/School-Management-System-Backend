-- User-managed income/expense categories.
-- Additive only: existing LedgerEntry / SchoolExpense rows are untouched and keep
-- working, since transactions store the category as free text. Seeded with the
-- categories the UI previously hardcoded, so pickers are not empty on day one.

-- CreateTable
CREATE TABLE "FinanceCategory" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinanceCategory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FinanceCategory_type_name_key" ON "FinanceCategory"("type", "name");
CREATE INDEX "FinanceCategory_type_isActive_idx" ON "FinanceCategory"("type", "isActive");

-- Seed defaults (idempotent)
INSERT INTO "FinanceCategory" ("id", "type", "name", "isActive", "createdAt", "updatedAt") VALUES
  ('fcat_income_donation',     'income',  'Donation',       true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('fcat_income_grant',        'income',  'Grant',          true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('fcat_income_rent',         'income',  'Rent',           true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('fcat_income_fine',         'income',  'Fine',           true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('fcat_income_sale_assets',  'income',  'Sale of Assets', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('fcat_income_misc',         'income',  'Miscellaneous',  true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('fcat_income_other',        'income',  'Other',          true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('fcat_expense_bills',       'expense', 'Bills',          true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('fcat_expense_maintenance', 'expense', 'Maintenance',    true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('fcat_expense_events',      'expense', 'Events',         true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('fcat_expense_stationery',  'expense', 'Stationery',     true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('fcat_expense_other',       'expense', 'Other',          true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("type", "name") DO NOTHING;
