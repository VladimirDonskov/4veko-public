# VekoScript platform (Java)

Spring Boot service that hosts VekoScript applications on PostgreSQL: deployment with
migrations, generated storage, catalogs, documents, posting, registers, audit and after-commit
events. Scripts run in isolated `vks worker` processes. API and configuration:
[docs/vekoscript/integration.md](../docs/vekoscript/integration.md).

Needs the worker binary (`cargo build --release -p vks-cli` in `engine/vekoscript`), Java 21+
and PostgreSQL. Tests use the database `vekoscript_test` on `localhost:5433` (override with
`VKS_TEST_DB_URL`):

```bash
./mvnw -B test
```
