# Dependency injection

Canvil assumes constructor injection: dependencies are parameters, never
module-level singletons.

## Why

- Tests can pass fakes without module mocking.
- The dependency graph is readable from the constructor signature.
- Lifecycles (request-scoped vs singleton) become an explicit decision.

## TypeScript sketch

```ts
export class AuthService {
  constructor(
    private readonly users: UserRepository,
    private readonly hasher: PasswordHasher,
    private readonly tokens: TokenIssuer,
  ) {}

  async login(email: string, password: string): Promise<Session> {
    const user = await this.users.findByEmail(email);
    if (!user || !(await this.hasher.verify(password, user.passwordHash))) {
      throw new UnauthorizedError("invalid credentials");
    }
    return this.tokens.issue(user.id);
  }
}
```

## Rules

1. No `import { db } from "../db"` inside business logic. Wrap it in a
   provider and inject it.
2. Never resolve dependencies from a service locator inside a method body.
3. Wire the graph in exactly one place (a composition root / DI container).
4. Prefer small interfaces defined by the consumer, not the implementation.

## Failure modes to look for

- Circular dependencies are usually a sign two classes belong together.
- A constructor with 7+ parameters means the class has too many reasons to
  change; split it.
