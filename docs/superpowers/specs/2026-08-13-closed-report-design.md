# /closed — Closed tickets report

**Date:** 2026-08-13
**Status:** Implemented

## Purpose

`/closed` lists every ticket that was **closed during the current stage**.

## Definition of "closed"

A ticket is included when its `closedAt` timestamp falls inside the current stage window:

```js
it.closedAt && t >= stage.startUtc && t < stage.endUtc
```

Start inclusive, end exclusive — `stageEndUtc` (`src/index.js:652`) is the start of the day after the stage's final day, so the final day is fully covered. Same window convention as `wasCompletedThisStage` (`src/index.js:710`).

### Corrected from the original draft

The first version of this spec defined inclusion as board Status `== "Closed"` scoped by `isInCurrentStage`. **Both halves were wrong**, and the command shipped returning `Total: 0` against a board that visibly had closed tickets.

- **There is no `Closed` status on the board.** The original design inferred one from `COMPLETED_STATUSES` (`src/index.js:620`), but that set is merely a list of strings the code tests against — not evidence of the board's actual status vocabulary. The status field is not part of the filter at all now.
- **Iteration membership is the wrong scope for this report.** `isInCurrentStage` (`src/index.js:695`) resolves an explicit iteration when set, and otherwise falls back to whether `createdAt` lands in the stage window. A ticket closed during Stage 15 was typically created — and staged — during an earlier stage, so both branches reject it. Scoping by close date is the point of the report.

Consequences of the corrected definition, all intentional:

- The report is **status-blind**. Anything closed in the window appears, whatever its board status — Done, Won't do, Cancelled, or no status. The `By status` line exists so that mix is visible rather than hidden.
- The report is **iteration-blind**. A ticket staged to Stage 12 but closed during Stage 15 is reported under Stage 15.
- **Draft issues never appear.** `DraftIssue` has no `closedAt` in `PROJECT_ITEMS_QUERY` (`src/index.js:494`). Only Issues and PullRequests can qualify.
- **Merged PRs count as closed**, since GitHub sets `closedAt` on merge.

## Command surface

```
/closed
/closed in md
/closed debug
```

Regex: `/^\/closed(?:@\w+)?(?:\s+([\s\S]+))?$/i`

`debug` prints the resolved window as ISO timestamps, how many board items have a `closedAt` at all versus inside the window, the status vocabulary of the matched set, and per-ticket `closedAt` / status / iteration / `isInCurrentStage`. It exists because the filter is a date-window comparison whose result is not obvious from the board UI.

## Output format

```
Closed tickets — Stage 15 (10 Aug 2026 – 23 Aug 2026)
Total: 3
By status: Done 2 · Won't do 1
By assignee: @alice 2 · @bob 1 · Unassigned 1

  - [2026-08-11] #418 Remove legacy webhook — @bob, @alice
  - [2026-08-12] web#412 (https://github.com/acme/web/issues/412) Fix auth redirect loop — @alice
  - [2026-08-20] #421 Drop unused index
```

- Tickets sorted by `closedAt` ascending; each line prefixed with its close date, since close date is the report's organising fact.
- `By status` shows the board status mix of the matched set.
- `By assignee` credits a multi-assignee ticket to each owner, so the tally can exceed `Total` — same convention as `/scoreboard`'s credited row. `Total` is the unique count.
- Ticket references via `ticketRef` (`src/index.js:795`), matching `/new`.
- Unassigned tickets are listed and counted under `Unassigned`, not dropped.

## Edge cases

| Case | Behaviour |
|---|---|
| No matching tickets | Header + `Total: 0`, single message, no tally lines |
| `GITHUB_PROJECT_ORG` / `GITHUB_PROJECT_NUMBER` unset | Same guard message as the other board handlers |
| Rate limited | `rateLimited(chatId)` checked first |
| Long list | `chunkMessage` splits across messages |
| Fetch failure | Logged, replies `Couldn't fetch closed tickets: <message>` |

## Side effects

- `insertMessage` records a `[Closed tickets requested: Stage NN]` marker and the reply.
- One `console.log('[closed] …')` line with board size and match count, visible via `journalctl -u clawdbot -f`.

## Verification

Fixture checks cover the window boundaries (start instant included, final day 23:59 included, the instant after the window excluded), the regression that caused `Total: 0` (a ticket staged to an earlier iteration but closed in this window must appear), exclusion of never-closed tickets, close-date ordering, and the assignee/status tallies.

Not yet verified end to end: the reported total against the board's own count of tickets closed in the stage window. The repo has no test framework and `src/index.js` starts the bot on import, so the fixture checks exercise the logic transcribed into a scratch script, not the deployed handler.

## Deployment note

`git pull` alone does not take effect — Node holds the old module in memory. `systemctl restart clawdbot` is required. An unregistered slash command is answered with **complete silence**, because the generic message handler returns early on `/`-prefixed text (`src/index.js:2130`); silence therefore means "not deployed", never "no results".
