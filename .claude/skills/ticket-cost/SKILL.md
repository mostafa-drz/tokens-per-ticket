---
name: ticket-cost
description: Report what a ticket has cost in AI tokens so far, from the LiteLLM gateway, and point out anything worth discussing (model mix, prompt cache use, failed calls). Use when the user asks what this ticket or ENG-123 has cost, or wants the spend posted to the tracker.
argument-hint: "[TICKET-KEY] [--days N] [--post]"
allowed-tools: Bash(node .tokens-per-ticket/tpt.mjs report *)
---

# Ticket cost

1. Run `node .tokens-per-ticket/tpt.mjs report $ARGUMENTS`. With no key it reads the ticket from the current branch.
   Only add `--post` when the user explicitly asked to post or update the tracker comment.
2. If it fails, relay the error as is. The messages say how to fix the problem.
3. Otherwise show the report, then at most three short observations the numbers support
   (model mix on routine work, low prompt-cache share, failed requests, many active days).

The number is a signal to talk about, not a score.
