"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, FormError, Input, Select } from "@/components/ui/inputs";
import { ErrorState } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { api, ApiError } from "@/lib/api";
import { readStatementCsv } from "@/lib/bank-statement-csv";

type Account = { id: string; type: string; subtype: string; number: string; name: string; isActive: boolean };

export function ImportStatement({ onDismiss }: { onDismiss: () => void }) {
  const router = useRouter();
  const queries = useQueryClient();
  const toast = useToast();
  const accounts = useQuery({ queryKey: ["accounts"], queryFn: () => api<{ data: Account[] }>("/accounts") });
  const banks = accounts.data?.data.filter((account) => account.isActive && account.type === "asset" && account.subtype === "bank");
  const upload = useMutation({
    mutationFn: async (form: FormData) => {
      const file = form.get("statementFile");
      if (!(file instanceof File) || !file.size) throw new Error("Choose a statement CSV file.");
      const lines = readStatementCsv(await file.text());
      const body = Object.fromEntries(["accountId", "externalId", "startDate", "endDate", "openingBalance", "closingBalance"]
        .map((name) => [name, String(form.get(name) ?? "").trim()]));
      return api<{ id: string; imported: number; duplicate: boolean }>("/bank-reconciliations/import", { method: "POST", body: { ...body, lines } });
    },
    onSuccess: (result) => {
      void queries.invalidateQueries({ queryKey: ["bank-reconciliations"] });
      toast.success(result.duplicate ? "Statement already imported. No duplicate lines were added." : `Imported ${result.imported} statement lines.`);
      onDismiss();
      router.push(`/bank-reconciliations/${result.id}`);
    },
  });
  const issues = upload.error instanceof ApiError ? upload.error.fieldErrors() : {};
  const lineIssues = Object.entries(issues).filter(([path]) => /^lines(\.|$)/.test(path));
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !upload.isPending) onDismiss(); }} title="Import bank statement" wide
      description="For the first statement, postings before the start date are treated as cleared. Later statements must follow the previous period and opening balance must equal its closing balance.">
      <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); upload.mutate(new FormData(event.currentTarget)); }}>
        <FormError message={upload.error?.message} />
        {accounts.error && <ErrorState error={accounts.error} retry={() => accounts.refetch()} />}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Bank account" required error={issues.accountId}>{(props) => <Select {...props} name="accountId" defaultValue="">
            <option value="">{banks?.length === 0 ? "No active bank accounts" : "Choose an account…"}</option>
            {banks?.map((account) => <option key={account.id} value={account.id}>{account.number} {account.name}</option>)}
          </Select>}</Field>
          <Field label="Statement reference" required hint="Use the same reference every time you import this statement." error={issues.externalId}>
            {(props) => <Input {...props} name="externalId" />}
          </Field>
          <Field label="Period start" required error={issues.startDate}>{(props) => <Input {...props} type="date" name="startDate" />}</Field>
          <Field label="Period end" required error={issues.endDate}>{(props) => <Input {...props} type="date" name="endDate" />}</Field>
          <Field label="Opening balance" required error={issues.openingBalance}>{(props) => <Input {...props} name="openingBalance" inputMode="decimal" placeholder="0.00" />}</Field>
          <Field label="Closing balance" required error={issues.closingBalance}>{(props) => <Input {...props} name="closingBalance" inputMode="decimal" placeholder="0.00" />}</Field>
        </div>
        <Field label="Statement CSV" required hint="Include the columns externalId, date, description, amount. Use a stable bank transaction ID and a YYYY-MM-DD date. Enter deposits as positive USD amounts and withdrawals as negative amounts. A header-only CSV imports an empty statement. Limit 1,000 transactions.">
          {(props) => <Input {...props} type="file" name="statementFile" accept=".csv,text/csv" className="h-auto cursor-pointer py-2" />}
        </Field>
        {lineIssues.length > 0 && <ul className="list-disc pl-5 text-sm text-danger">{lineIssues.slice(0, 5).map(([path, message]) => <li key={path}>
          {path.replace(/^lines\.(\d+)\.?/, (_, i: string) => `CSV record ${Number(i) + 2} `)}: {message}
        </li>)}</ul>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" disabled={upload.isPending} onClick={onDismiss}>Cancel</Button>
          <Button type="submit" loading={upload.isPending} disabled={!banks?.length}>Import statement</Button>
        </div>
      </form>
    </Dialog>
  );
}
