# TypeScript conventions

## Compiler baseline

```jsonc
{
  "strict": true,
  "noImplicitOverride": true,
  "noFallthroughCasesInSwitch": true,
  "verbatimModuleSyntax": true
}
```

`strict` is not negotiable in a codebase Canvil will edit. If a third-party type
is wrong, wrap it — do not lower the flag.

## Types

1. Model illegal states out of existence with discriminated unions rather than
   optional field soup:

   ```ts
   type Result =
     | { status: "ok"; value: string }
     | { status: "error"; error: Error };
   ```

2. `unknown` at every trust boundary (JSON.parse, HTTP, env). Narrow with a
   schema validator (Zod) instead of a cast.
3. Ban `as` for narrowing; `as const` for literals is fine.
4. Ban non-null assertion `!` outside tests.
5. Prefer `readonly` arrays and `Readonly<T>` for values crossing boundaries.

## Naming

- Files: `kebab-case.ts`; types/interfaces: `PascalCase`; values:
  `camelCase`; module-level constants: `SCREAMING_SNAKE_CASE` only for true
  constants.
- Booleans read as predicates: `isValid`, `hasAccess`, `canRetry`.
- No `I` prefix on interfaces.

## Errors

- Throw `Error` subclasses, never strings.
- Use `cause` when rethrowing: `throw new ConfigError(msg, { cause: err })`.
- Never swallow with an empty `catch {}`; at minimum log with context.
- `catch (e)` values are `unknown` — narrow before touching `.message`.

## Async

- Never mix callbacks and promises in the same function.
- Sequential `await` in a loop is a smell when iterations are independent: use
  `Promise.all`.
- Always bound concurrency for external calls (p-limit style, size 5-10).
- Propagate `AbortSignal` through every network call.

## Module layout

- `index.ts` files re-export only; no side effects.
- Imports ordered: node builtins, external packages, internal absolute,
  relative; blank line between groups.
- In ESM + NodeNext, relative imports include the `.js` extension.