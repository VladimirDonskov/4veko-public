# ADR 0002: A new Java service hosts VekoScript; the existing TypeScript ERP stays for now

Status: accepted (2026-10-28), a deliberate and temporary deviation

## Context

The VekoScript brief requires the ERP backend to be Java + Spring Boot and forbids NestJS,
Node.js or TypeScript as the ERP backend. 4VEKO releases 0.1 and 0.2 (ledger, sales,
inventory, procure-to-pay) are already built and tested on Node.js/Fastify/TypeScript.
Rewriting them in Java before VekoScript exists would delay the language by months and risk
regressions in tested accounting code.

## Decision

Agreed with the product owner: a new Spring Boot service (`backend/`) owns everything
VekoScript-related — application metadata and versions, generated storage, catalogs,
documents, registers, posting, audit and the worker pool — on PostgreSQL. The existing
TypeScript ERP keeps running unchanged. Its modules move to the Java platform one at a time,
each when it can be expressed as VekoScript metadata and handlers with equal or better tests.

The TypeScript "Veko" prototype (commit 75e3727) stays until the Java platform and a
Monaco-based configurator cover what it does; then it is removed.

## Consequences

- Two backends run side by side during the transition; they do not share tables.
- New business functionality goes to the Java/VekoScript platform, not the TypeScript ERP.
- The deviation is tracked in [checkpoint.md](../checkpoint.md) until the TypeScript backend
  is retired.
