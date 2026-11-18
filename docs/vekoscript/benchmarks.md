# Benchmarks

Run them with:

```bash
cargo run --release -p vks-cli --manifest-path engine/vekoscript/Cargo.toml -- bench
```

## Recorded result

2026-10-28, release build, Windows 11 x86_64, Intel Core i5-12450H, 16 GB RAM, Rust stable
(rustc 1.99.1). Single run; expect ±20% between runs on a laptop.

| Benchmark | Iterations | Per unit |
| --- | ---: | ---: |
| check `inventory.vks` (parse + metadata + analysis) | 2,000 | 229 µs/check |
| integer loop (`s += i`) | 1,000,000 | 90 ns/iteration |
| decimal multiply + round + add | 200,000 | 659 ns/iteration |
| recursive calls (`fib`) | 150,049 | 792 ns/call |
| string keys into a map | 100,000 | 938 ns/iteration |
| post a GoodsReceipt with 2 lines (in-memory platform: save, BeforeSave, BeforePost, Post, intent validation, movements, AfterPost) | 1,000 | 171 µs/document |
| `vks/1` envelope encode + decode (2 intents) | 20,000 | 9.4 µs/message |

## Reading the numbers

- The interpreter is a tree walker. About 90 ns per simple loop step suits business handlers,
  which do little arithmetic per platform call, but it is slow for number crunching. Compiling the analyzed tree to bytecode is the obvious next step if
  profiles show script time mattering next to database time.
- An earlier version of the in-memory platform copied its whole state on every call; posting
  1,000 documents cost 4.7 ms each. It now keeps an undo journal (171 µs). That cost was in the
  test platform, not the engine.
- End-to-end posting through Java and PostgreSQL is not benchmarked yet; the integration tests
  run the 17-step demo in about 3 seconds including deployment and schema creation, which is
  not a throughput measurement.
