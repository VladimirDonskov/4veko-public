export type BankStatement = {
  id: string;
  accountId: string;
  accountName: string;
  accountNumber: string;
  externalId: string;
  startDate: string;
  endDate: string;
  openingBalance: string;
  closingBalance: string;
  status: "open" | "closed";
  closedAt: string | null;
};

export type StatementLine = {
  id: string;
  externalId: string;
  date: string;
  description: string;
  amount: string;
  journalLineId: string | null;
  entryNumber: number | null;
  entryId: string | null;
  lineNo: number | null;
};

export type OutstandingPosting = { id: string; entryId: string; entryNumber: number; lineNo: number; date: string; description: string | null; amount: string; matchedLater: boolean; depositVoidedOn?: string | null };

export type ReconciliationSummary = {
  bookBalance: string;
  outstandingAmount: string;
  adjustedBankBalance: string;
  difference: string;
  statementDifference: string;
  unmatchedCount: number;
  outstandingCount: number;
};

export type Reconciliation = {
  canClose: boolean;
  canReopen: boolean;
  canDiscard: boolean;
  statement: BankStatement;
  lines: StatementLine[];
  candidates: OutstandingPosting[];
  summary: ReconciliationSummary;
  closedSummary: ReconciliationSummary | null;
};
