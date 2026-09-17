# Authorization

Authentication answers *who*. Authorization answers *what may they do* — and it
is the most commonly broken control in real applications (OWASP A01).

## Principles

1. **Deny by default.** Every new endpoint starts closed; access is granted
   explicitly.
2. **Server-side only.** Hiding a button is UX, not a control. Every mutating
   endpoint re-checks permission with the authenticated identity.
3. **Object-level checks.** Verify the resource belongs to the caller, not just
   that the caller is logged in (IDOR). A `GET /orders/:id` must check
   `order.userId === session.userId`, or use a scoped query
   (`findByIdForUser(id, userId)`).
4. **Centralize the policy.** One place that maps (role, action, resource) to a
   decision. Scattered `if (user.isAdmin)` checks drift.
5. **Fail closed.** An error while evaluating a policy must deny.

## Model choice

| Model | Use when |
| --- | --- |
| RBAC | Few coarse roles, stable over time |
| ABAC | Rules depend on attributes (owner, tenant, time) |
| ReBAC | Relationship graphs (parent folders, org hierarchies) |

## Tenant isolation

Every query in a multi-tenant system carries the tenant id from the session —
never from the request body. Add a test that proves tenant A cannot read tenant
B's row by id.

## Test checklist

- Unauthenticated request -> 401.
- Authenticated but unauthorised -> 403 (not 200 with empty data).
- Authenticated as another user -> 403/404, and no data leak in the body or
  timing.
- Mass assignment: sending `"role":"admin"` in a profile update must be ignored
  or rejected, not persisted.
