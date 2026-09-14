@AGENTS.md

# tokens-per-ticket

A boilerplate that attributes AI development spend to tickets. Claude Code tags every call
with `ticket:<KEY>`, LiteLLM adds spend up per tag, and this repo supplies the conventions,
the CLI, and the ledger app. The README is the single source of documentation. Keep it current
instead of adding new docs.

## Commands

```bash
pnpm dev            # ledger on :3000
pnpm test:unit      # node:test via tsx
pnpm test:e2e       # Playwright on :3100 (sample data)
pnpm typecheck      # next typegen && tsc
pnpm lint
pnpm gateway:up     # LiteLLM + Postgres on :4000
pnpm gateway:smoke  # prove tagged spend flows
```

## Rules

- **Don't rebuild what LiteLLM does.** Before adding tracking, budgets, alerts, or aggregation,
  check the LiteLLM docs and source. Add code here only for the gaps: contract, launcher, hook,
  Linear write-back, ledger UI.
- **The contract is config.** Nothing about branch shape, team keys, or the tracker is
  hard-coded. It all goes through `tokens-per-ticket.yaml` and `src/lib/contract.ts`.
- **One ticket per session and per worktree.** Never switch branches in a checkout that has
  uncommitted changes. Use `pnpm ticket:start <KEY>`.
- **Keep `src/lib` free of Next.js imports**, except `data.ts` and `review.ts`. The CLI scripts
  and the hook import the rest directly through tsx.
- **Never sum a day's top-level metrics across tags.** One request carries several tags
  (LiteLLM adds `User-Agent` tags). Read `breakdown.entities` for the ticket list, and the
  one-tag query for a ticket's detail. `tests/unit/ledger.test.ts` guards this.
- **Secrets stay server-side.** `LITELLM_API_KEY` is an admin key. Never expose it through
  `NEXT_PUBLIC_*`. Live data in production requires `LEDGER_BASIC_AUTH`.
- **Sample data is labelled as sample data** on every page.
- **Architecture claims need a source.** When touching gateway, Claude Code, or Linear
  integration points, cite the official doc (or LiteLLM source file) in a code comment, as
  the existing modules do.

## Tests

- Changes in `src/lib` come with unit tests. Prefer fixtures recorded from a real gateway
  (`tests/fixtures`) over hand-written response shapes.
- UI changes come with a Playwright spec in `tests/e2e`. Cover what a user would notice if it
  broke: honesty about data source, ordering, the ticket page, empty and error states. Use
  `getByRole` first, and never `waitForTimeout`.

## Commits

Small, incremental [Conventional Commits](https://www.conventionalcommits.org): `feat(scope):`,
`fix(scope):`, `test(scope):`, `docs:`, `chore:`. Scopes in use: `contract`, `gateway`,
`ledger`, `cli`, `claude`, `app`, `e2e`. The body explains why, not what.
