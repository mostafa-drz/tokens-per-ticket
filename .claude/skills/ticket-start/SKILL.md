---
name: ticket-start
description: Prepare a worktree for a ticket and give the user the command that starts a Claude Code session billed to it.
argument-hint: "<TICKET-KEY> [short title]"
disable-model-invocation: true
allowed-tools:
  - "Bash(node --import tsx scripts/ticket-start.mts *)"
---

# Start a ticket

A running session can't change which ticket it bills: the spend tag is set
when Claude Code starts. So this skill prepares everything, and the user
starts the new session themselves.

1. Run `node --import tsx scripts/ticket-start.mts $ARGUMENTS --print` (the `ticket:start` script, run directly so it works under any package manager).
2. If it fails, relay the error as is.
3. Otherwise tell the user, in two short lines:
   - which branch and worktree are ready (reused or created)
   - that they should open a new terminal and paste the printed `cd … && claude …` command, and install dependencies in the worktree first (the script prints the command) if it was just created

Don't run the printed `claude` command yourself.
