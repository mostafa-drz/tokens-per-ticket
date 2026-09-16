---
name: ticket-cost
description: What a ticket has cost in AI tokens so far, read from the LiteLLM gateway, with the numbers worth discussing. Optionally posts or updates the figures as a comment on the ticket through the tracker's MCP server. Use when the user asks what this ticket or ENG-123 has cost.
argument-hint: "[TICKET-KEY] [--days N] [--post]"
allowed-tools: Bash(node .tokens-per-ticket/tpt.mjs ticket*), Bash(set -a*)
---

# What this ticket cost

## 1. The ticket

Use the key the user gave. Otherwise run `node .tokens-per-ticket/tpt.mjs ticket`, which prints
`<KEY> <tag>` for the current branch, or explains why the branch names no ticket. The spend tag
is always `ticket:<KEY>`.

## 2. The numbers

Read them straight from the gateway (default 30 days; `--days N` changes the window). Load the
repository's `.env.local` in the same command, because `curl` doesn't read it on its own:

```bash
set -a; [ -f .env.local ] && . ./.env.local; set +a; curl -sS -H "Authorization: Bearer $LITELLM_API_KEY" \
  "$LITELLM_BASE_URL/tag/daily/activity?tags=<tag>&start_date=<window start>&end_date=<tomorrow>&page_size=1000"
```

Ask up to tomorrow's date: LiteLLM buckets each day by its own server's clock, so "today" in your
timezone can miss the newest rows.

`LITELLM_BASE_URL` and `LITELLM_API_KEY` come from the environment or that file. That key reads
the whole organization's spend, so most laptops don't have it: if it's missing, say so and stop.

Each day in `results` carries `metrics` (spend, prompt_tokens, completion_tokens,
cache_read_input_tokens, api_requests, failed_requests) and `breakdown.model_groups` per model.
Sum the days for the totals. `prompt_tokens` already includes cache reads and writes.

## 3. Say what matters

Give the totals (spend, tokens, requests, active days) and the split by model, then at most three
observations the numbers support: an expensive model on routine work, a low prompt-cache share,
failed requests, spend spread over many days. Tokens per ticket is a signal to talk about, not a
score to rank people by. Say plainly when nothing is worth flagging.

## 4. Only with --post: put it on the ticket

Use the tracker's MCP server (Linear, Jira, or whatever this team runs), never a hand-written API
call. If no tracker MCP server is connected, show the comment text and say it can be pasted in.

Keep exactly one comment per ticket: list the ticket's comments, and if one of yours ends with
`_Updated by tokens-per-ticket_`, update that comment instead of adding another. Write the figures
as a small Markdown table, name the tag and the date range, and end with that line.
