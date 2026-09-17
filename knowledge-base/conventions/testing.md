# Testing conventions

## Shape

- One test file per unit under test: `src/foo/bar.ts` -> `tests/bar.test.ts`.
- Test names describe behaviour, not implementation:
  `"rejects an expired token"`, not `"calls verifyToken"`.
- Arrange / Act / Assert with blank lines between the three phases.
- Assert one logical outcome per test; multiple `expect`s are fine when they
  describe the same outcome.

## What to test

1. Happy path.
2. Each branch of the conditional logic.
3. Boundaries: empty, single item, max size, off-by-one.
4. Failure paths: invalid input, network error, timeout.
5. Regressions: every fixed bug gains a test that fails before the fix.

## Fakes over mocks

Prefer small hand-written fakes that implement the real interface. Mocking a
framework's internals couples the test to the framework version.

## Determinism

- No reliance on wall-clock time: inject a clock or use fake timers.
- No reliance on a shared external database or network in unit tests.
- Sort results before asserting when order is not part of the contract.
- Temporary directories only, removed in `afterEach`.

## Coverage

Coverage is a diagnostic, not a goal. 100% coverage with assertions that never
fail is worthless; uncovered error paths in a payment flow are not. Gate CI on
coverage of *changed* lines if you must gate at all.