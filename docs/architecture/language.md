# The Veko language

Veko is 4VEKO's own embedded language. A **configuration** written in Veko declares business
objects (catalogs, documents, registers) and the logic that runs when they are written or
posted. The **platform kernel** (TypeScript) stores the objects, runs the code in a sandbox,
and provides the General Ledger, inventory, accounts, parties and permissions, with all their
integrity rules. Code can only change the books through the kernel, so a configuration can
never post an unbalanced entry, write into a closed period or reach another organization.

Veko is an independent design. Its syntax, keywords, object model and runtime were written
from scratch; they are not derived from 1C's language, configuration format or documentation.

## A complete example

```
# Equipment rental: a catalog, a document and a register.

catalog Equipment
  field serial: Text required
  field dailyRate: Money required
end

register EquipmentOut nonnegative
  dimension equipment: Equipment
  resource units: Quantity
end

document Rental
  field customer: Customer required
  field returned: Boolean
  table lines
    equipment: Equipment required
    days: Quantity required
    rate: Money
  end
  field total: Money

  on write
    let sum = 0
    for line in lines
      if line.rate == null
        line.rate = line.equipment.dailyRate
      end
      sum = sum + round(line.days * line.rate, 2)
    end
    total = sum
    if total <= 0
      fail "A rental needs at least one line with a price."
    end
  end

  on post
    for line in lines
      if returned
        EquipmentOut.subtract(equipment: line.equipment, units: 1)
      else
        EquipmentOut.add(equipment: line.equipment, units: 1)
      end
    end
    ledger.post(debit: accounts.receivable, credit: accounts.services,
                amount: total, party: customer, memo: "Rental " + number)
  end
end
```

## Lexical structure

- Comments start with `#` and run to the end of the line.
- Identifiers: letters, digits and `_`, not starting with a digit. Case-sensitive.
- Keywords: `catalog document register function field table dimension resource required
  nonnegative on end let if elif else for in while return fail break continue and or not
  true false null this`.
- Numbers are **exact decimals** (`12`, `0.1`, `19.99`). There is no floating point:
  `0.1 + 0.2 == 0.3` is true.
- Strings use double quotes with `\"`, `\\`, `\n`, `\t` escapes.
- Newlines separate statements only where it matters: a `(` or `[` at the start of a line
  never continues the previous line.

## Declarations

| Declaration | Purpose |
| --- | --- |
| `catalog Name … end` | Reference data (lists of things): fields, optional `on write` |
| `document Name … end` | Business events with a number and date: fields, tables, `on write`, `on post` |
| `register Name [nonnegative] … end` | Balances of resources by dimensions, written only when documents post |
| `function name(a, b) … end` | Reusable code, callable from anywhere |

Field types: `Text`, `Number`, `Money` (stored to cents), `Quantity` (4 decimals), `Date`,
`Boolean`, a catalog or document name, or a kernel record: `Customer`, `Vendor`, `Item`,
`Account`. `required` makes a field mandatory. Every document also has `number` (assigned by
the platform, e.g. `Rental-1001`), `date` and `posted`.

A `nonnegative` register refuses any posting that would leave a resource below zero for the
dimensions it touched: the posting fails and nothing is saved.

## Statements and expressions

```
let x = expr                 # new variable in the current block
x = expr                     # assignment (variables, fields, table-row fields)
if cond … elif cond … else … end
for item in list … end
while cond … end
return [expr]
fail "message"               # stop, roll back, show the message to the user
break / continue
```

Operators, by precedence (low to high): `or`, `and`, `not`, comparisons (`== != < <= > >=`),
`+ -`, `* / %`, unary `-`, then calls `f(a, name: b)`, members `a.b` and indexes `a[i]`.
`+` joins text when either side is text. Lists `[1, 2]` and records `{name: "A"}` are
available as literals.

## What code can use

| Name | Meaning |
| --- | --- |
| field and table names, `this`, `number`, `date`, `posted` | the current catalog item or document |
| `ledger.post(debit:, credit:, amount:, party:?, memo:?)` | add a debit/credit pair to this document's journal entry (`on post` only) |
| `accounts.receivable` `.payable` `.inventory` `.cash` `.undeposited` `.sales` `.services` `.cogs` `.salesTax`, `accounts.number("6500")` | accounts of the organization |
| `stock.receive(item, qty, cost, credit: account)`, `stock.issue(item, qty, debit: account?)` → cost | move stock through the inventory kernel; the platform posts the Inventory side itself at the exact cost (`on post` only) |
| `Register.add(...)`, `Register.subtract(...)` | register movements (`on post` only) |
| `Register.balance(dimension: value, …)` | current balances, as a record of resources |
| `Catalog.find(field: value, …)`, `Document.find(…)` | first matching record or `null` |
| `today() toDate("2026-10-28") addDays(d, n) daysBetween(a, b) round(x, places) abs min max len text number upper lower message(text)` | standard library |

Code cannot post to the control accounts kept by kernel subledgers (Accounts Receivable,
Accounts Payable, Inventory, Received Not Billed), so those accounts always match the invoices,
bills and stock behind them. The sample configuration (`apps/api/src/modules/config/sample.ts`)
therefore takes rental payments into Undeposited Funds.

Reading a reference field follows it: `line.equipment.dailyRate`, `customer.termsDays`.

## How posting runs

"Post" is one database transaction: the platform locks the document, undoes its previous
posting (deletes its register movements, reverses its journal entry, reverses its stock
moves), runs `on post`, posts all `ledger.post` pairs as **one** balanced journal entry
through the kernel, writes register movements, checks `nonnegative` registers, and marks the
document posted. Any `fail`, runtime error, unbalanced entry, closed period or negative
balance rolls everything back.

## Sandbox limits

Code has no access to files, network, time zones, randomness or JavaScript. Each run is
limited to 1,000,000 steps, 2 seconds, call depth 200 and texts of 1,000,000 characters.
Errors carry the line and column of the code that caused them.

## Versions

Saving a configuration checks it first (syntax, unknown names, types, duplicate members) and
refuses it with line-numbered diagnostics if anything is wrong. Accepted configurations are
stored as numbered versions; the newest is active. Records keep their data when a
configuration changes; fields that no longer exist are kept but not shown.

## Roadmap for the language

1. **Now:** language, sandboxed interpreter, catalogs, documents with tables, registers,
   `on write` / `on post`, ledger and stock through the kernel, configurator in the browser,
   generated list and form screens.
2. **Next:** reports written in Veko (queries over registers and documents), user-defined
   forms layout, extensions of built-in objects (events on built-in invoices and bills),
   debugger with breakpoints, type checking of expressions.
3. **Then:** move built-in modules (sales, purchasing) into a standard configuration written
   in Veko, keeping the kernel in TypeScript.
