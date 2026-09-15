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
pnpm gateway:up     # LiteLLM + plugin + registry + Postgres (:4000, :4100)
pnpm gateway:smoke  # prove tagged spend flows
pnpm test:registry  # the session registry
pnpm test:gateway   # the LiteLLM plugin
pnpm build:cli      # rebuild .tokens-per-ticket/tpt.mjs
```

## Rules

- **Don't rebuild what LiteLLM does.** Before adding tracking, budgets, alerts, or aggregation,
  check the LiteLLM docs and source. Add code here only for the gaps: contract, session hooks,
  registry, gateway plugin, Linear write-back, ledger UI.
- **Automatic first.** Engineers shouldn't have to run a command for attribution. Anything new
  should work from the hooks, the registry, and the gateway plugin; `tpt start` stays optional.
- **Hooks never block and never fail a session.** Every path of `src/cli/hook.ts` returns output,
  warns at most once per problem, and the gateway plugin fails open.
- **Rebuild the bundle.** `.tokens-per-ticket/tpt.mjs` is generated from `src/cli` and `src/lib`
  and committed, because adopting repos copy it. Run `pnpm build:cli` after changing either;
  CI fails when it's stale.
- **The contract is config.** Nothing about branch shape, team keys, or the tracker is
  hard-coded. It all goes through `tokens-per-ticket.yaml` and `src/lib/contract.ts`.
- **Never switch branches in a checkout that has uncommitted changes.** Use a worktree
  (`pnpm tpt start <KEY>`) to work a second ticket.
- **Keep `src/lib` and `src/cli` free of Next.js imports**, except `src/lib/data.ts` and
  `src/lib/review.ts`. They are bundled into the CLI.
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
`registry`, `ledger`, `cli`, `claude`, `app`, `e2e`. The body explains why, not what.
