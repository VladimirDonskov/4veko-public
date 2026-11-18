export type Deposit = {
  id: string;
  number: string;
  date: string;
  bankAccountId: string;
  bankAccountNumber: string;
  bankAccountName: string;
  total: string;
  status: "posted" | "void";
  memo: string | null;
  journalEntryId: string;
  voidJournalEntryId: string | null;
  voidDate: string | null;
};

export type DepositReceipt = {
  id: string;
  number: string;
  date: string;
  customerId: string;
  customerName: string;
  method: string;
  reference: string | null;
  amount: string;
};

export type DepositDetail = Deposit & {
  receipts: DepositReceipt[];
  matchedStatementId: string | null;
  baselineStatementId: string | null;
  voidReason: string | null;
};
