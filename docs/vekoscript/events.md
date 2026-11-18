# Events

Handlers run business logic when the platform changes an object. They are declared with
`on <Object>.<Event>(<parameter>) { ... }`; at most one handler per object and event.

| Event | Objects | When | May change the object | Effect of `reject()` or an error |
| --- | --- | --- | --- | --- |
| BeforeCreate | catalogs, documents | first save of a new object, before BeforeSave | yes | nothing is saved |
| BeforeSave | catalogs, documents | every save | yes (compute fields, totals) | nothing is saved |
| BeforePost | documents | posting, after the row lock, before Post | no | not posted |
| Post | documents | posting; produces register movements | no | not posted |
| BeforeReverse | documents | reversal | no | not reversed |
| BeforeDelete | catalogs, documents | archiving | no | not archived |
| AfterCreate, AfterSave, AfterPost, AfterReverse, AfterDelete | as above | after the change commits | no | logged; the change stays |

## Inside the transaction

For one API call or script operation the platform:

1. opens a database transaction and, for an existing object, locks its row
   (`SELECT ... FOR UPDATE`);
2. checks the caller's capability and the object's state (version, posted or not);
3. checks every value against its declared type, then runs the Before* handler in the
   worker; BeforeCreate/BeforeSave may change fields and rows;
4. validates the result itself (types, required fields, references, unique values);
5. for posting, runs Post, validates every intent (register, dimensions, measures, types,
   referenced records) and writes the movements;
6. writes the new state, an audit record and the After* event (outbox) in the same
   transaction, and commits.

Any failure, including a rejection, a limit, a host error inside a nested save, or a storage
error, rolls back the whole operation. Handlers can call platform operations (for example save
another object); those run in the same transaction, with their own handlers, up to 8 levels.

An object cannot be saved, posted, reversed or deleted from inside its own handler (VKS4022):
the platform completes the operation after the handler returns.

## Posting

`Post` handlers do not write data; they describe it:

```
on GoodsReceipt.Post(document) {
    for item in document.items {
        Register.StockBalance.increase(product: item.product, warehouse: document.warehouse,
                                       quantity: item.quantity, amount: item.amount);
    }
}
```

Each `increase` / `decrease` becomes an intent. Movements take the document's date as their
period, the document as recorder and a line number. `increase` and `decrease` are refused
outside a Post handler: statically in other handlers (VKS3016) and at run time when a function
is called outside posting (VKS4018). Missing measures count as zero; every dimension is
required.

Duplicate posting is prevented three ways: the status check under the row lock, the
transaction, and a unique index on active movements per recorder line. Reversal marks the
document's movements inactive (they stay for audit) and sets the status to `reversed`; a
reversed document can be posted again.

## After commit

After* events are written to `vks_outbox` in the operation's transaction and delivered after
it commits, each in its own transaction, as the user who caused them. `notify(...)` in an
after-commit handler becomes a row in `vks_notification`. Failures are recorded
(`attempts`, `last_error`) and retried by a poller up to five times; they never undo the
committed change.
