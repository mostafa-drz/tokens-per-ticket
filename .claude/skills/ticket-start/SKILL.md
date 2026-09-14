---
name: ticket-start
description: Prepare a separate worktree for a ticket and give the user the command that starts a Claude Code session in it. Only needed to work two tickets side by side; on a ticket branch, spend is attributed automatically.
argument-hint: "<TICKET-KEY> [short title]"
disable-model-invocation: true
allowed-tools: Bash(node .tokens-per-ticket/tpt.mjs start *)
---

# Start a ticket in its own worktree

1. Run `node .tokens-per-ticket/tpt.mjs start $ARGUMENTS --print`.
2. If it fails, relay the error as is.
3. Otherwise tell the user which branch and worktree are ready, and that they can open a new terminal and paste the printed command.

Don't run the printed `claude` command yourself.
