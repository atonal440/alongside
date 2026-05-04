# pwa/src/utils/suggestQueue.ts

## Functions

**`suggestQueue(tasks, _today, links?)`** — Returns an ordered array of tasks for the Suggest view. Filters with `isReady` from `shared/readiness.ts`, then sorts by `readinessScore` (also from shared) so the ordering matches `get_ready_tasks` over MCP. The first item is what `SuggestView` shows as the main card; the remaining items populate the sidebar queue. The `_today` parameter is accepted for call-site compatibility but ignored — `nowIso` is derived internally via `new Date().toISOString()`.

## See Also

- [[readiness]] — `isReady` predicate applied inside `suggestQueue` to filter non-actionable tasks
- [[SuggestView]] — consumes the first item as the main card; shows queue length in the sidebar
- [[ReviewView]] — uses `suggestQueue` for the Next Suggestion panel
