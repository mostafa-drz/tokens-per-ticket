---
name: ticket-cost
description: Report what a ticket has cost in AI tokens so far, from the LiteLLM gateway, and point out anything worth discussing (model mix, prompt cache use, failed calls). Use when the user asks what this ticket or ENG-123 has cost, how many tokens were used, or wants the spend posted to Linear.
argument-hint: "[TICKET-KEY] [--days N] [--post]"
allowed-tools: Bash(pnpm -s ticket:report:*)
---

# Ticket cost

1. Run `pnpm -s ticket:report $ARGUMENTS`.
   - With no key, the script reads it from the current branch.
   - Only add `--post` when the user explicitly asked to post or update the Linear comment. Posting is visible to the whole team.
2. If it fails, relay the error message as is. The script's messages already say how to fix the problem (gateway not running, missing key, branch outside the contract).
3. If there's no recorded spend, say so plainly and repeat the script's hint.
4. Otherwise show the report, then add at most three short observations the numbers actually support, for example:
   - One model dominates the spend and the work looks mechanical: a cheaper tier may fit.
   - Prompt cache reads are a low share of input tokens on a long-running ticket.
   - Failed requests are a noticeable share of all requests.
   - Spend is spread over many active days: the ticket may be bigger than its estimate.

Don't judge the developer. The number is a signal to talk about, not a score.
