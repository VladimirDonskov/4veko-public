# Metadata

Metadata declares the business objects of an application. It never executes code: the engine
turns declarations into an immutable `MetadataModel`, the platform stores each deployed
version and generates storage from it, and the analyzer checks scripts against it.

```
catalog Products {
    field code: String(20) required unique;
    field name: String(200) required;
    field price: Decimal(18, 2) default 0;
}

document GoodsReceipt {
    field warehouse: Ref<Warehouses> required;
    field total: Decimal(18, 2);
    rows items {
        field product: Ref<Products> required;
        field quantity: Decimal(18, 3) required;
    }
}

register StockBalance {
    dimension product: Ref<Products>;
    dimension warehouse: Ref<Warehouses>;
    measure quantity: Decimal(18, 3);
}
```

## Objects

| Object | Purpose | System members |
| --- | --- | --- |
| `catalog` | reference data (products, warehouses, counterparties) | `id version deleted` |
| `document` | business events with a date and lines; can be posted | `id version number date status deleted` |
| `rows` (inside a document) | the document's lines | `lineNo` |
| `register` | accumulation register: dated movements, balances by dimension | `period recorder lineNo direction active` |
| `information register [periodic]` | facts by dimension | declared and stored; script access is Planned |

Archiving (`delete()`) is a soft delete: records stay so references and history remain valid.

## Field types

| Type | Storage (PostgreSQL) | Rules |
| --- | --- | --- |
| `String` | `text` | |
| `String(n)` | `varchar(n)` | 1 ≤ n ≤ 10,000; length counts characters |
| `Decimal(p, s)` | `numeric(p, s)` | 1 ≤ p ≤ 28, 0 ≤ s ≤ p; values must fit exactly, never rounded |
| `Integer` | `bigint` | |
| `Boolean` | `boolean` | |
| `Date` | `date` | |
| `DateTime` | `timestamptz` | UTC |
| `Ref<Name>` | `uuid` + foreign key | `Name` is a catalog or document of the application |

Modifiers: `required`, `unique` (catalog String and Integer fields only; enforced among
non-archived records), `default <literal>` (must fit the type). Register members take no
modifiers; dimensions are always required. Dimensions are references, `String(n)`, Integer,
Boolean or Date; measures are Decimal or Integer.

## Validation codes

| Code | Rule |
| --- | --- |
| VKS2001 | name reserved by the platform (`Catalog Document Register Accounting Context Query Workflow Platform`) |
| VKS2002 | object names start with a capital letter |
| VKS2003 | object declared twice |
| VKS2004 | more than 200 fields |
| VKS2005 | field uses a system member name |
| VKS2006 | field names start with a lowercase letter |
| VKS2007 | duplicate field or member |
| VKS2008 | invalid dimension type |
| VKS2009 | measure is not numeric |
| VKS2010 | `unique` on an unsupported field |
| VKS2011 | modifiers on register members |
| VKS2012 | default does not fit the type |
| VKS2013 | catalog or rows without fields |
| VKS2014 | register without dimensions or measures, or more than 16 dimensions |
| VKS2015 | invalid String length |
| VKS2016 | invalid Decimal precision or scale |
| VKS2017 | `Ref<...>` to an unknown object |

## Versions and migrations

Every deployment that changes the source becomes a new version (an identical source is a
no-op). The engine compares the new model with the previous one and returns a logical plan;
each step says whether it can lose or invalidate data:

| Step | Needs approval when |
| --- | --- |
| create catalog / document / rows / register | never |
| add field | the field is required and has no default |
| change field | the type does not widen safely, or the field becomes required or unique |
| drop field, drop rows, drop object | always |
| change register (dimensions, measures, kind) | always: movements must be rebuilt by reposting |

Widening that is always safe: longer `String(n)`, `Decimal` with no fewer integer digits and
no smaller scale, `Integer` → `Decimal(p, s)` with p − s ≥ 19, `Date` → `DateTime`.

The Java platform turns the plan into DDL and runs it in the deployment transaction
(PostgreSQL DDL is transactional). A plan with risky steps is refused with HTTP 409 and the
plan, until it is deployed again with `"approveDestructive": true`; the approval is audited.
A step the database cannot apply (for example `SET NOT NULL` over existing empty values) fails
the deployment and changes nothing.

Each application gets its own PostgreSQL schema (`vks_<id>`). Tables are `c_<Catalog>`,
`d_<Document>`, `d_<Document>__<rows>`, `r_<Register>`; declared fields are `f_<field>`
columns. All identifiers are validated and quoted; values are always bound parameters.

`vks metadata app.vks` prints the model; `vks plan new.vks --from old.vks` prints the plan.
