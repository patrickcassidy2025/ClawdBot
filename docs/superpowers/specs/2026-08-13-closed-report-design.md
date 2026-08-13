# /closed — Closed tickets report

**Date:** 2026-08-13
**Status:** Approved

## Purpose

`/scoreboard` buckets board statuses into To Do, In Progress, Done, and Other. Tickets whose Status field is literally `Closed` fall into Other, where they are indistinguishable from Backlog, In Review, On hold, and the rest. There is currently no way to see them.

`/closed` lists every ticket in the current stage whose board Status is `Closed`.

## Scope

**In scope:** one new Telegram command handler, one new line in `/help`.

**Out of scope:** changes to `/scoreboard`'s bucketing, new helpers, refactoring of existing handlers, any stage other than the current one.

## Definition of "closed"

A ticket is included when **both** hold:

1. `(it.status || '').toLowerCase() === 'closed'` — the board Status single-select field, exactly `Closed`.
2. `isInCurrentStage(it, stage)` — iteration membership, per the existing helper at `src/index.js:694`.

Deliberately **not** used:

- `closedAt` — reflects when GitHub closed the underlying issue, frequently in an earlier stage than the one the card is staged to. Commits `91db5f4` and `fa89ae9` moved `/scoreboard` off this field for exactly that reason; `/closed` must not reintroduce it.
- `COMPLETED_STATUSES` (`src/index.js:620`) — that set spans Done, Won't do, Cancelled, and Closed. This report is only the literal `Closed` status.
- GitHub issue `state === 'CLOSED'` — the board Status field is the source of truth for the report.

Scoping by `isInCurrentStage` rather than a date window makes `/closed` consistent with every `/scoreboard` bucket.

## Command surface

```
/closed
/closed in md
```

Regex mirrors `/new`:

```js
/^\/closed(?:@\w+)?(\s+in\s+md)?$/i
```

## Output format

```
Closed tickets — Stage NN (12 Aug – 25 Aug)
Total: 7
By assignee: @alice 3 · @bob 2 · @carol 2

  - #412 Fix auth redirect loop — @alice
  - #418 Remove legacy webhook — @bob
  - #421 Drop unused index — @carol
```

- Header uses `stage.label` and `stage.rangeLabel`.
- `By assignee` tallies each assignee, sorted by count descending, joined with ` · `. A multi-assignee ticket is credited to each owner, so the tally can exceed `Total` — same convention as `/scoreboard`'s credited row.
- Ticket lines use `ticketRef(item)` (`src/index.js:795`) for the reference, matching `/new`'s `formatItem`.
- Tickets with no assignee are listed with no ` — @…` suffix and counted under an `Unassigned` entry in the tally. They are **not** dropped: `/scoreboard` skips unassigned tickets because it is a per-person board, but a "show me everything closed" report that silently hides tickets would be wrong.

## Generation

Built directly in code, like `/new` — no Anthropic API call. The reply is a plain list of facts; routing it through the model adds latency, cost, and a hallucination surface for no gain. `/scoreboard` already has to constrain the model with STRICT RULES to stop it reformatting verbatim data.

## Edge cases

| Case | Behaviour |
|---|---|
| No matching tickets | Header + `Total: 0`, single message, no tally line and no blank-line gap |
| `GITHUB_PROJECT_ORG` / `GITHUB_PROJECT_NUMBER` unset | Same guard message the other board handlers emit |
| Rate limited | `rateLimited(chatId)` checked first, before any work |
| Long list | `chunkMessage` splits across Telegram messages, as elsewhere |
| Fetch failure | Caught, logged to `console.error`, replies `Couldn't fetch closed tickets: <message>` |

## Side effects

- `insertMessage` records both a `[Closed tickets requested: Stage NN]` user marker and the reply, keeping the report in conversation history like its siblings.
- One `console.log('[closed] …')` verification line reporting board size, in-stage count, and match count — visible via `journalctl -u clawdbot -f`, matching the `[scoreboard]` logging convention.

## Files changed

| File | Change |
|---|---|
| `src/index.js` | New handler after the `/new` handler (~line 1330); one line added to the `/help` list (~line 137) |

## Verification

`/closed`'s total must equal the count of `Closed` tickets visible on the board filtered to the current iteration. Cross-check against `/scoreboard raw`, whose status breakdown prints a `Closed` row scoped the same way — the two numbers must agree.
