---
description: "Complete AAHP handoff cycle: update state files, log session, regenerate manifest"
allowed-tools: "Read, Edit, Write, Bash(sha256sum*), Bash(wc*), Bash(date*), Bash(git*)"
---

Perform a complete AAHP v3 handoff for the current session. Follow these steps exactly:

## Step 1: Create Lock
Create `.ai/handoff/HANDOFF.lock` with current agent identity and timestamp.

## Step 2: Update STATUS.md
Rewrite `.ai/handoff/STATUS.md` to reflect the CURRENT state of the project. Include:
- Build health (build, test, lint, type-check results)
- Infrastructure state
- Services/components status
- What is missing
- Recently resolved items
- Trust levels for all claims

## Step 3: Update NEXT_ACTIONS.md
- Mark completed tasks as done (move to "Recently Completed")
- Add any newly discovered tasks
- Ensure max 5 active (unblocked) tasks
- Update blocked status for any blocked tasks

## Step 4: Append to LOG.md
Add a session summary entry at the TOP of LOG.md:
```
## [DATE] Session: [Brief Title]

> **Agent:** [model name]
> **Timestamp:** [ISO-8601]

**What was done:**
- Bullet points of work completed

**Decisions made:**
- Any decisions or trade-offs

**Open items:**
- What remains to be done
```
If LOG.md exceeds 10 entries, move older entries to LOG-ARCHIVE.md.

## Step 5: Update DASHBOARD.md
- Update build status and test counts
- Update pipeline state
- Update open tasks table

## Step 6: Regenerate MANIFEST.json
- Compute SHA-256 checksums for ALL handoff files
- Count lines in each file
- Write one-line summaries
- Update last_session metadata
- Update quick_context (2-3 sentences)
- Estimate token budgets
- Preserve task graph data

## Step 7: Remove Lock & Commit
- Delete HANDOFF.lock
- Stage all handoff files: `git add .ai/handoff/`
- Commit: `feat(handoff): session handoff [AAHP-auto]`

Report the handoff summary to the user when complete.
