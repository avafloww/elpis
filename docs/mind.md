# Mind

Mind is Elpis's durable dependency-aware work graph. It stores executable commitments and non-commitment possibilities in the same system without treating “recorded” as “promised.”

## Item model

Kinds:

- `task`
- `project`
- `idea`
- `question`
- `reminder`

Statuses:

- `inbox`
- `open`
- `in_progress`
- `waiting`
- `done`
- `cancelled`

An otherwise active item reports effective status `blocked` when an unfinished dependency prevents it from being ready.

Items support priorities, parent/child hierarchy, due dates, tags, comments, append-only events, dependencies, archive state, and scheduler-backed reminders.

## Dependency rules

Dependencies are directed edges. Mind rejects self-dependencies and cycles. `ready()` returns executable items whose own status and dependency state permit work.

Parent hierarchy and dependency links are separate: a task can belong to a project without depending on every sibling.

## Interfaces

- `elpis.mind.*` in the JavaScript sandbox;
- operator-only `/mind` Discord commands in configured home guilds;
- the Mind pane in Elpis Console;
- compact request-only frontier cards on eligible turns.

All interfaces use the same `MindService` and SQLite tables.

## Reminders

A Mind reminder creates a linked scheduler row. Completing, cancelling, or deleting the relevant state cancels linked pending reminders. Scheduler wake delivery records whether the reminder fired.

## Privacy boundary

Mind currently has no per-item server scope. The live frontier is therefore included only on internal/home turns and is suppressed for a mixed turn after any social input. Full bodies and comments are not included in the frontier card.

## Agent neutrality

Event actors and comments use the configured/hot-read inhabitant name where appropriate, with neutral `agent` fallback. The storage layer does not hardcode a particular inhabitant.
