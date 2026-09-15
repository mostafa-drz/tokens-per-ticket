
# tokens-per-ticket

A boilerplate that attributes AI development spend to tickets. Claude Code hooks report each
session's ticket, a LiteLLM plugin tags every call `ticket:<KEY>`, and LiteLLM adds spend up per
tag. Reading and posting those numbers is a skill (`/ticket-cost`) driving the tracker's MCP
server, not code here. The README is the single source of documentation. Keep it current instead
of adding new docs.

## Commands

```bash
pnpm test:unit      # node:test via tsx
pnpm typecheck
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
  registry, gateway plugin.
- **Automatic first.** Engineers shouldn't have to run a command for attribution. Anything new
  should work from the hooks, the registry, and the gateway plugin.
- **Hooks never block and never fail a session.** Every path of `src/cli/hook.ts` returns output,
  warns at most once per problem, and the gateway plugin fails open.
- **Rebuild the bundle.** `.tokens-per-ticket/tpt.mjs` is generated from `src/cli` and `src/lib`
  and committed, because adopting repos copy it. Run `pnpm build:cli` after changing either;
  CI fails when it's stale.
- **The contract is config.** Nothing about branch shape, team keys, or the tracker is
  hard-coded. It all goes through `tokens-per-ticket.yaml` and `src/lib/contract.ts`.
- **Never switch branches in a checkout that has uncommitted changes.** Use a worktree
  (`git worktree add`) to work a second ticket.
- **Agentic where a model is better.** Reading spend, judging it, and writing it to a tracker are
  skill instructions plus MCP servers. Don't add API clients, renderers, or query layers for them.
- **Never sum a day's top-level metrics across tags.** One request carries several tags (LiteLLM
  adds `User-Agent` tags), so read one tag at a time, as the skill does.
- **`LITELLM_API_KEY` reads the whole organization's spend.** It belongs in CI or with a lead,
  never on every laptop.
- **Architecture claims need a source.** When touching gateway, Claude Code, or Linear
  integration points, cite the official doc (or LiteLLM source file) in a code comment, as
  the existing modules do.

## Tests

- Changes in `src/lib` and `src/cli` come with unit tests.
- The registry and the plugin have their own tests (`pnpm test:registry`, `pnpm test:gateway`).

## Commits

Small, incremental [Conventional Commits](https://www.conventionalcommits.org): `feat(scope):`,
`fix(scope):`, `test(scope):`, `docs:`, `chore:`. Scopes in use: `contract`, `gateway`,
`registry`, `cli`, `claude`, `skill`. The body explains why, not what.
