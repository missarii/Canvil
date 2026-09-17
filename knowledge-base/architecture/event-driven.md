# Event-driven architecture

## When it fits

- Multiple consumers must react to the same fact.
- Producers must not know about consumers.
- Work must survive a consumer outage (durable broker).

## Core concepts

- **Event**: immutable statement of something that happened, in past tense
  (`OrderPlaced`, not `PlaceOrder`).
- **Command**: a request that can be rejected. Never publish commands to a
  broadcast topic.
- **Consumer group**: each group receives every message once; members inside a
  group share the load.

## Delivery guarantees

| Guarantee | Cost | Requirement |
| --- | --- | --- |
| At-most-once | fastest, may lose | acceptable data loss |
| At-least-once | default | **consumers must be idempotent** |
| Exactly-once | highest | broker/transaction support |

Design for at-least-once and make handlers idempotent by keying on an event id.

## Failure handling

1. Retry with exponential backoff and jitter, bounded attempts.
2. Then park the message in a dead-letter queue with the original payload and
   the failure reason.
3. Alert on DLQ depth; a DLQ nobody reads is data loss with extra steps.

## Anti-patterns

- Using events as a remote function call (request/reply over a topic).
- God events carrying entire database rows.
- No schema/versioning strategy on the payload.
