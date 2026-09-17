# Repository pattern

Purpose: keep persistence details out of the domain, and give tests a seam.

## Interface

```ts
export interface UserRepository {
  findById(id: string): Promise<User | null>;
  findByEmail(email: string): Promise<User | null>;
  save(user: User): Promise<void>;
  delete(id: string): Promise<void>;
}
```

## Rules

1. Declare the interface next to the domain model, implement it in the adapter
   folder (`PrismaUserRepository`).
2. Return domain objects, not ORM rows. Map explicitly at the boundary.
3. Do not leak query builders. If callers need `where` clauses, expose a
   purpose-named method (`findActiveSince`) instead.
4. One repository per aggregate root, not per table.

## Testing

- Unit tests use an in-memory implementation of the interface.
- Integration tests run the real adapter against a throwaway database created
  per test file, migrated once, and truncated between tests.

## Anti-patterns

- Generic `BaseRepository<T>` exposing `find(where)`; it is an ORM with steps.
- Business rules inside repository methods.
- Repositories that call other repositories (that is a service's job).
