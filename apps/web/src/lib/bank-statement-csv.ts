type StatementColumn = "externalId" | "date" | "description" | "amount";

const requiredColumns: StatementColumn[] = ["externalId", "date", "description", "amount"];

/** Read comma-separated records, including quoted commas, escaped quotes, and multiline descriptions. */
export function readStatementCsv(source: string): Record<StatementColumn, string>[] {
  const text = source.replace(/^\uFEFF/, "");
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  let afterQuote = false;
  const completeRecord = () => {
    record.push(field.trim());
    if (record.length > 1 || record[0] !== "") {
      if (records.length >= 1001) throw new Error("A statement can contain up to 1,000 transactions.");
      records.push(record);
    }
    record = [];
    field = "";
    afterQuote = false;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else {
        quoted = false;
        afterQuote = true;
      }
    } else if (c === ",") {
      record.push(field.trim());
      field = "";
      afterQuote = false;
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      completeRecord();
    } else if (c === '"' && field === "" && !afterQuote) {
      quoted = true;
    } else if (c === '"' || afterQuote) {
      throw new Error(`Invalid quotes in CSV record ${records.length + 1}.`);
    } else {
      field += c;
    }
  }
  if (quoted) throw new Error("The CSV ends inside a quoted field.");
  completeRecord();
  const [header = [], ...rows] = records;
  function position(column: StatementColumn) {
    if (header.filter((name) => name === column).length !== 1) throw new Error(`Include exactly one ${column} column in the CSV header.`);
    return header.indexOf(column);
  }
  const columns = Object.fromEntries(requiredColumns.map((column) => [column, position(column)])) as Record<StatementColumn, number>;
  return rows.map((row, index) => {
    if (row.length !== header.length) throw new Error(`CSV record ${index + 2} has ${row.length} columns. Expected ${header.length}.`);
    const externalId = row[columns.externalId]!;
    if (!externalId) throw new Error(`CSV record ${index + 2} is missing its bank transaction ID.`);
    return { externalId, date: row[columns.date]!, description: row[columns.description]!, amount: row[columns.amount]! };
  });
}
