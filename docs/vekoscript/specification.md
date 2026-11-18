# VekoScript language specification (v0.1)

VekoScript (`.vks`) is the native business language of 4VEKO. Developers declare business
**metadata** (catalogs, documents, registers) and write **business logic** (functions and
event handlers) against platform-managed objects. They never write persistence, transaction
or event-dispatch code: the platform does that.

VekoScript is an independent design. Its grammar, runtime and libraries were written from
general language-design principles and standard business concepts; nothing is taken from 1C's
language, runtime, libraries or documentation.

Status labels used in this folder: **Implemented**, **Tested**, **Partial**, **Planned**,
**Unsupported**. The status table at the end of this file is the source of truth.

## 1. Design principles

1. **Business objects are platform types.** `Catalog.Products`, `Document.GoodsReceipt` and
   `Register.StockBalance` exist because metadata declares them; scripts cannot declare
   classes, inherit, define constructors or reflect on internals.
2. **Dynamic variables, typed metadata.** A local variable can hold any value; a field declared
   `Decimal(18, 2)` accepts only values that fit it, checked when assigned and when saved.
3. **No dangerous implicit conversions.** No truthiness, no string/number coercion, no silent
   rounding of stored values.
4. **Exact money.** Integers are 64-bit with checked overflow; decimals are exact base-10
   (a 96-bit mantissa: 28 to 29 significant digits, at most 28 decimal places). Binary floating point does not exist in the language.
5. **Effects are requests.** Scripts never touch the database. Every read or change is a typed
   host request that the platform authorizes, validates and applies.
6. **Bounded execution.** Every run has limits on steps, time, memory, call depth, collection
   size and host calls.

## 2. Lexical structure

- Source is UTF-8. Identifiers: `[A-Za-z_][A-Za-z0-9_]*`, case-sensitive.
- Comments: `// to end of line` and `/* block */` (not nested).
- Statements end with `;`. Blocks use `{ }`.
- Integer literals: `0`, `1500` (64-bit). Decimal literals: `150.00`, `0.075` (exact; the
  written scale is kept: `150.00` has scale 2).
- String literals: `"text"` with escapes `\" \\ \n \t \r \u{1F600}`.
- Reserved words: `let function return if else while for in break continue on true false
  null`. They cannot name variables, functions or fields.
- Contextual words: `catalog document register information periodic field rows dimension
  measure resource required unique default`. They are keywords only where a declaration can
  start (or inside one); elsewhere they are ordinary names, so `document` is a fine handler
  parameter and `default` a fine map key.
- Identifiers use English letters, digits and `_` (non-ASCII letters are an error, VKS1007).
  Strings may contain any Unicode text.
- Operators: `+ - * / % == != < <= > >= && || ! = += -= . , : ; ( ) [ ] { } < >`.

## 3. Grammar

The complete EBNF is in [grammar.md](grammar.md). A module is a sequence of metadata
declarations, functions, event handlers and (in scripts run directly) statements.

```
// Metadata
catalog Products {
    field code: String(20) required unique;
    field name: String(200) required;
    field price: Decimal(18, 2) default 0;
    field active: Boolean default true;
}

// Logic
function lineTotal(quantity, unitPrice) {
    return round(quantity * unitPrice, 2);
}

on GoodsReceipt.BeforePost(document) {
    if document.items.count() == 0 {
        reject("Cannot post an empty receipt.");
    }
}
```

## 4. Values and types

| Type | Literal / constructor | Notes |
| --- | --- | --- |
| Null | `null` | absence of a value |
| Boolean | `true`, `false` | |
| Integer | `42` | i64; overflow is a runtime error |
| Decimal | `42.50`, `decimal("1.005")` | exact base-10, 28–29 significant digits; overflow is an error |
| String | `"text"` | immutable; length in characters |
| Date | `date("2026-10-28")`, `today()` | calendar date |
| DateTime | `dateTime("2026-10-28T14:30:00Z")`, `now()` | UTC instant, second precision |
| Duration | `days(3)`, `hours(2)`, `minutes(30)` | whole seconds |
| Money | `money(250.00, "USD")` | Decimal amount + ISO 4217 currency |
| Array | `[1, 2, 3]` | ordered, 0-based, mutable |
| Map | `{ name: "A", "two words": 2 }` | ordered string keys, mutable |
| BusinessReference | from metadata objects | identifies a catalog item or document (type + id) |
| BusinessObject | `Catalog.Products.create()` | a platform-managed record with fields and row collections |
| PlatformCollection | `document.items` | rows of a document, results of `list()` |
| Function | a top-level function name, built-ins | callable; no closures or lambdas |

`typeOf(x)` returns the type name.

### 4.1 Arithmetic and numeric promotion

- `Integer op Integer` → Integer for `+ - * %` (checked); `/` always returns Decimal.
- Any arithmetic mixing Integer and Decimal promotes the Integer to Decimal.
- Addition, subtraction and multiplication of decimals are exact and keep the scale the
  operands imply (`1.50 + 1` is `2.50`, `2.5 * 4` is `10.0`). Results that would need more than
  the decimal type's precision are rounded to fit it (28–29 significant digits); beyond the range of
  ±79,228,162,514,264,337,593,543,950,335 the result is an error (VKS4005).
- Division results are exact when they fit and otherwise rounded to the type's precision;
  they are shown without trailing zeros (`7 / 2` is `3.5`, `6 / 3` is `2`, `1 / 3` is
  `0.3333333333333333333333333333`, `100 / 3` is `33.333333333333333333333333333`).
- `Money ± Money` requires equal currencies → Money. `Money * Integer|Decimal` and
  `Money / Integer|Decimal` → Money. `Money / Money` (same currency) → Decimal ratio.
  `Money * Money` is an error.
- `Date + Duration`, `Date - Duration` → Date (whole days only); `Date - Date` → Duration;
  `DateTime ± Duration` → DateTime; `DateTime - DateTime` → Duration.
- `String + String` concatenates. `String + anything else` is an error: use `str(x)` or
  `format("{0} items", n)`.
- Division or remainder by zero is an error.

### 4.2 Rounding

`round(x, places)` rounds half away from zero (the usual commercial rule);
`round(x, places, "even")` rounds half to even. `x.round(2)` is the same as `round(x, 2)`.
Values are never rounded implicitly in expressions. **When a value is stored in a metadata
field**, it must already fit the field: a `Decimal(18, 2)` field rejects `10.005` with an
error rather than rounding it silently.

### 4.3 Equality and comparison

- `==` / `!=` never fail. Integer and Decimal compare numerically (`1 == 1.0`). Values of
  unrelated types are not equal (`1 == "1"` is `false`). `null == null` is `true`.
  References are equal when type and id are equal. Arrays and maps compare by identity.
- `< <= > >=` work on numbers, strings (ordinal), dates, date-times, durations and same-currency
  money. Anything else, including `null`, is an error.

### 4.4 Conditions

`if`, `while`, `&&`, `||` and `!` require Boolean operands. There is no truthiness: `if count`
is an error; write `if count > 0`. `&&` and `||` short-circuit.

### 4.5 Collections

- `array[i]` needs an Integer index within range, otherwise an error. Negative indexes are not
  allowed.
- `map["key"]` or `map.key` returns `null` when the key is missing; `map.has("key")` tests it.
  Maps keep insertion order.
- `for x in array` visits a snapshot of the elements; `for key in map` visits the keys;
  `for row in document.items` visits the rows; `for i in range(n)` / `range(a, b)` counts
  without building an array. Anything else is an error (VKS4020).
- Collections are limited in size by the execution limits.

### 4.6 Conversions (explicit only)

`str(x)`, `int(x)` (from Integer, Decimal without fraction, numeric String), `decimal(x)`,
`bool(x)` (from `"true"`/`"false"`), `date(s)`, `dateTime(s)`, `money(amount, currency)`.
Failed conversions are errors.

## 5. Variables, scope and functions

- `let name = expr;` declares a variable in the current block. Declaring the same name twice
  in one block is an error; inner blocks may shadow outer names.
- `name = expr;`, `name += expr;`, `name -= expr;` assign to an existing variable, a property
  or an element. Assigning to an undeclared name is an error found before execution.
- `function name(a, b) { ... }` declares a top-level function. Arguments are positional, then
  named (`f(1, rate: 0.05)`); each parameter must be given exactly once. A function without
  `return value;` returns `null`. Functions are values: `let f = lineTotal; f(2, 3.5);`.
- Recursion is allowed within the call-depth limit. There are no closures, nested functions,
  classes, `this` or global mutable state shared between executions.

## 6. Business objects

See [metadata.md](metadata.md) and [runtime.md](runtime.md).

```
let product = Catalog.Products.create();
product.code = "P-1001";
product.name = "Industrial Motor";
product.price = 1250.00;
product.save();

let receipt = Document.GoodsReceipt.create();
receipt.warehouse = Catalog.Warehouses.findByCode("MAIN");
receipt.items.add(product: product, quantity: 10, unitPrice: 250.00);
receipt.save();
receipt.post();

let onHand = Register.StockBalance.balance(product: product, warehouse: receipt.warehouse);
```

## 7. Errors

Every diagnostic and runtime error has a code, a message, and a line and column. Kinds:
`syntax`, `semantic`, `metadata`, `type`, `runtime`, `rejected` (raised by `reject(...)`,
shown to users as a business message), `limit`, `permission`, `host`.

## 8. Implementation status

The kept-current status table, with what is implemented, tested, partial and planned, is in
[runtime.md](runtime.md#status).
