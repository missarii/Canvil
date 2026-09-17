# Layered architecture

Use this when a project must separate transport, orchestration, domain rules and
persistence concerns.

## Shape

```
transport  (HTTP/gRPC/CLI)  -> validates input, maps errors to status codes
application (use cases)     -> orchestrates domain objects, owns transactions
domain      (entities)      -> pure rules, no I/O, no framework imports
infrastructure (adapters)   -> database, queue, 3rd-party APIs
```

## Rules that keep it honest

1. Dependencies point inward only. Domain must not import infrastructure.
2. A use case returns a domain result, not a framework response object.
3. Repositories are declared as interfaces in the domain layer and implemented
   in infrastructure.
4. Cross-cutting concerns (logging, auth) are applied at the transport boundary
   or as decorators, never sprinkled inside the domain.

## When to skip it

A CLI tool or a <5k line service does not need four layers. Extra indirection
costs more than it saves; a single `services/` folder is fine.

## Review questions

- Can I unit test the domain with no database running?
- If I swap PostgreSQL for another store, how many files change?
- Where does the transaction boundary sit, and is it exactly one use case?
