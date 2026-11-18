import { describe, expect, it } from "vitest";
import { VekoError } from "../src/lang/ast";
import { compile } from "../src/lang/checker";
import { Interpreter, VDate, VRecord, VRef, display, type Host, type Value } from "../src/lang/interpreter";
import { D } from "../src/lib/money";

function fakeHost(over: Partial<Host> = {}): Host & { messages: string[]; posted: unknown[] } {
  const messages: string[] = [];
  const posted: unknown[] = [];
  return {
    messages,
    posted,
    loadRef: async (ref) => new VRecord(new Map<string, Value>([["name", `loaded ${ref.id}`], ["rate", new D("12.5")]])),
    account: async (key) => new VRef("Account", key),
    accountByNumber: async (n) => new VRef("Account", `#${n}`),
    ledgerPost: async (a) => void posted.push(a),
    stockReceive: async () => {},
    stockIssue: async () => new D("10"),
    registerMove: async () => {},
    registerBalance: async () => new VRecord(new Map()),
    find: async () => null,
    message: (t) => void messages.push(t),
    today: () => "2026-10-28",
    ...over,
  };
}

async function run(source: string, fn = "main", args: Value[] = [], host = fakeHost(), limits?: ConstructorParameters<typeof Interpreter>[3]) {
  const { schema, diagnostics } = compile(source);
  if (diagnostics.length) throw diagnostics[0];
  return new Interpreter(schema, host, "function", limits).callFunction(fn, args);
}

const errorOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as VekoError;
  }
  throw new Error("expected an error");
};

describe("Veko: values and arithmetic", () => {
  it("computes with exact decimals, never floating point", async () => {
    expect(await run("function main()\n return 0.1 + 0.2 == 0.3\nend")).toBe(true);
    expect(display(await run("function main()\n return 19.99 * 3\nend"))).toBe("59.97");
    expect(display(await run("function main()\n return round(10 / 3, 2)\nend"))).toBe("3.33");
    expect(display(await run("function main()\n return round(2.345, 2)\nend"))).toBe("2.35");
  });

  it("joins text with + and converts with text()/number()", async () => {
    expect(await run('function main()\n return "Total: " + 12.50\nend')).toBe("Total: 12.5");
    expect(display(await run('function main()\n return number("41") + 1\nend'))).toBe("42");
  });

  it("has lists, records, indexing and len", async () => {
    const src = `
function main()
  let xs = [1, 2, 3]
  xs[1] = 20
  let r = {name: "A", qty: 2}
  r.qty = r.qty + 1
  return text(xs[1]) + "/" + text(r.qty) + "/" + text(len(xs))
end`;
    expect(await run(src)).toBe("20/3/3");
  });

  it("handles dates", async () => {
    const src = `
function main()
  let d = addDays(toDate("2026-12-30"), 3)
  return text(d) + " " + text(daysBetween(toDate("2026-10-28"), d)) + " " + text(today() < d)
end`;
    expect(await run(src)).toBe("2027-01-02 66 true");
  });
});

describe("Veko: control flow and functions", () => {
  it("runs if/elif/else, loops with break and continue", async () => {
    const src = `
function grade(n)
  if n >= 90
    return "A"
  elif n >= 80
    return "B"
  else
    return "C"
  end
end

function main()
  let s = ""
  for n in [95, 85, 50]
    s = s + grade(n)
  end
  let i = 0
  let total = 0
  while true
    i = i + 1
    if i > 10
      break
    end
    if i % 2 == 0
      continue
    end
    total = total + i
  end
  return s + text(total)
end`;
    expect(await run(src)).toBe("ABC25");
  });

  it("supports recursion and named arguments", async () => {
    const src = `
function fact(n)
  if n <= 1
    return 1
  end
  return n * fact(n - 1)
end
function main()
  return fact(n: 20)
end`;
    expect(display(await run(src))).toBe("2432902008176640000");
  });

  it("stops with a clear message on fail", async () => {
    const e = await errorOf(run('function main()\n  fail "Credit limit exceeded"\nend'));
    expect(e.kind).toBe("fail");
    expect(e.describe()).toBe("Line 2, column 3: Credit limit exceeded");
  });
});

describe("Veko: sandbox limits and runtime errors", () => {
  it("stops an endless loop", async () => {
    const e = await errorOf(run("function main()\n  while true\n  end\nend", "main", [], fakeHost(), { maxSteps: 10_000, maxMillis: 2000, maxDepth: 50, maxText: 1000 }));
    expect(e.kind).toBe("limit");
  });

  it("stops runaway recursion", async () => {
    const e = await errorOf(run("function f(n)\n  return f(n + 1)\nend\nfunction main()\n  return f(0)\nend", "main", [], fakeHost(), { maxSteps: 1e6, maxMillis: 2000, maxDepth: 50, maxText: 1000 }));
    expect(e.kind).toBe("limit");
    expect(e.message).toMatch(/nested calls/);
  });

  it("reports runtime errors with positions", async () => {
    expect((await errorOf(run("function main()\n  return 1 / 0\nend"))).describe()).toMatch(/^Line 2, .*Division by zero/);
    expect((await errorOf(run('function main()\n  return 1 + true\nend'))).message).toMatch(/Cannot use "\+"/);
    expect((await errorOf(run("function main()\n  if 1\n  end\nend"))).message).toMatch(/must be true or false/);
    expect((await errorOf(run("function main()\n  let x = null\n  return x.name\nend"))).message).toMatch(/null/);
  });

  it("refuses ledger and stock operations outside posting", async () => {
    const e = await errorOf(run("function main()\n  ledger.post(debit: accounts.cash, credit: accounts.sales, amount: 1)\nend"));
    expect(e.message).toMatch(/only be used while a document posts/);
  });
});

describe("Veko: syntax and checking", () => {
  it("reports syntax errors with line and column", () => {
    const r = compile("catalog Thing\n  field name Text\nend");
    expect(r.diagnostics[0]!.describe()).toMatch(/^Line 2, column 14: Expected a ":"/);
    expect(compile('function f()\n  return "open\nend').diagnostics[0]!.message).toMatch(/closing quote/);
  });

  it("collects every check error at once", () => {
    const r = compile(`
catalog Thing
  field name: Text
  field name: Money
  field owner: Nobody
end
document Sale
  field number: Text
  on write
    ledger.post(debit: accounts.cash, credit: accounts.sales, amount: 1)
    total = 5
    missing()
  end
end
register Empty
  dimension what: Thing
  resource label: Text
end`);
    const messages = r.diagnostics.map((d) => d.message);
    expect(messages).toEqual(
      expect.arrayContaining([
        'Catalog Thing already has a member named "name".',
        expect.stringMatching(/Unknown type "Nobody"/),
        '"number" is managed by the platform and cannot be declared.',
        'ledger.post can only be used in "on post".',
        expect.stringMatching(/Unknown variable "total"/),
        expect.stringMatching(/Unknown name "missing"/),
        'Resource "label" must be Number, Money or Quantity.',
      ]),
    );
  });

  it("checks register arguments and function arity", () => {
    const r = compile(`
register Stock
  dimension item: Item
  resource qty: Quantity
end
function two(a, b)
  return a + b
end
function main()
  let x = Stock.balance(itme: null)
  return two(1)
end`);
    expect(r.diagnostics.map((d) => d.message)).toEqual(
      expect.arrayContaining(['Register Stock has no dimension or resource "itme".', "two expects 2 argument(s) but got 1."]),
    );
  });
});

describe("Veko: handlers", () => {
  const source = `
catalog Equipment
  field dailyRate: Money required
end
document Rental
  field customer: Customer required
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
        line.rate = line.equipment.rate
      end
      sum = sum + round(line.days * line.rate, 2)
    end
    total = sum
    message("Total is " + text(total))
  end
  on post
    ledger.post(debit: accounts.undeposited, credit: accounts.services, amount: total, party: customer, memo: "Rental " + number)
  end
end`;

  function rentalObject() {
    const row = (days: string, rate: string | null) =>
      new VRecord(new Map<string, Value>([["equipment", new VRef("Equipment", "e1")], ["days", new D(days)], ["rate", rate === null ? null : new D(rate)]]), new Set(["equipment", "days", "rate"]), "lines row");
    return new VRecord(
      new Map<string, Value>([
        ["number", "Rental-1001"],
        ["date", new VDate("2026-10-28")],
        ["posted", false],
        ["customer", new VRef("Customer", "c1")],
        ["lines", [row("3", null), row("2", "20")]],
      ]),
      new Set(["number", "date", "posted", "customer", "lines", "total"]),
      "Rental",
    );
  }

  it("on write fills defaults and computes totals; on post posts to the ledger", async () => {
    const { schema, diagnostics } = compile(source);
    expect(diagnostics).toEqual([]);
    const doc = schema.documents.get("Rental")!;
    const members = ["number", "date", "posted", "customer", "total", "lines"];
    const obj = rentalObject();
    const host = fakeHost();
    await new Interpreter(schema, host, "write").runHandler(doc.handlers.find((h) => h.event === "write")!, obj, members);
    expect(display(obj.fields.get("total")!)).toBe("77.5");
    expect(host.messages).toEqual(["Total is 77.5"]);

    obj.frozen = true;
    await new Interpreter(schema, host, "post").runHandler(doc.handlers.find((h) => h.event === "post")!, obj, members);
    expect(host.posted).toHaveLength(1);
    expect((host.posted[0] as { memo: string }).memo).toBe("Rental Rental-1001");
  });

  it("does not let on post change the document", async () => {
    const { schema } = compile(source.replace('    ledger.post(debit', '    for line in lines\n      line.days = 0\n    end\n    ledger.post(debit'));
    const doc = schema.documents.get("Rental")!;
    const obj = rentalObject();
    const e = await errorOf(new Interpreter(schema, fakeHost(), "post").runHandler(doc.handlers.find((h) => h.event === "post")!, obj, ["number", "date", "posted", "customer", "total", "lines"]));
    expect(e.message).toMatch(/cannot be changed/);
  });
});
