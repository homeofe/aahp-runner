# Reusable Prompt Templates

> Provider-agnostic prompts for common operations. Copy and adapt for any LLM.

## 1. AAHP Session Start (Any LLM)

Use this when starting work on an AAHP-managed project with any LLM.

```
You are working on a project managed by the AAHP protocol (AI-to-AI Handoff Protocol v3).

Before doing anything:
1. Read .ai/handoff/MANIFEST.json
2. Check the quick_context field for current project state
3. Check if HANDOFF.lock exists (if yes: previous session did not complete cleanly)
4. Based on your task, read only the relevant handoff files:
   - Bug fix: STATUS.md + NEXT_ACTIONS.md
   - New feature: + CONVENTIONS.md + WORKFLOW.md
   - Debug: + LOG.md + TRUST.md

Current task: [DESCRIBE TASK HERE]

Rules:
- Follow CONVENTIONS.md strictly
- Update handoff files at end of session
- Never write secrets into handoff files
- Mark all unverified claims as (Assumed)
```

## 2. Code Review Prompt

```
Review the following code changes for:
1. Correctness: Does it do what it's supposed to?
2. Security: OWASP Top 10 vulnerabilities?
3. Performance: Any obvious bottlenecks?
4. Edge cases: What could go wrong?
5. Tests: Are they sufficient?

Rate each finding as:
- [CRITICAL] Must fix before merge
- [WARNING] Should fix, not blocking
- [SUGGESTION] Nice to have
- [GOOD] Positive observation

Verdict: SHIP / NEEDS_CHANGES / BLOCK

[PASTE DIFF OR CODE HERE]
```

## 3. Architecture Decision Prompt

```
I need to make an architecture decision for: [DESCRIBE FEATURE/PROBLEM]

Current system state:
[PASTE STATUS.md SUMMARY OR DESCRIBE]

Constraints:
- [List constraints: tech stack, budget, timeline, team]

Please provide:
1. 2-3 viable approaches with trade-offs
2. Your recommendation and reasoning
3. Risks and mitigation strategies
4. Implementation steps (numbered, specific)
5. Definition of done (acceptance criteria)

Format as an ADR (Architecture Decision Record).
```

## 4. Bug Investigation Prompt

```
Investigate this bug:

Symptoms: [WHAT IS HAPPENING]
Expected: [WHAT SHOULD HAPPEN]
Environment: [WHERE IT OCCURS]

Relevant files:
[LIST FILES OR PASTE CODE]

Error output:
[PASTE ERROR/STACK TRACE]

Please:
1. Identify the root cause (not just symptoms)
2. Explain WHY it happens
3. Propose a fix with specific code changes
4. Identify if this could affect other parts of the system
5. Suggest a test to prevent regression
```

## 5. Handoff Summary Generation

```
Generate an AAHP session summary for the work just completed.

What was done this session:
[DESCRIBE WORK]

Format:
## [TODAY'S DATE] Session: [Brief Title]

> **Agent:** [your model name]
> **Timestamp:** [current ISO-8601 time]

**What was done:**
- [bullet points]

**Decisions made:**
- [any decisions or trade-offs]

**Open items:**
- [what remains]

**Trust updates:**
- [any verification status changes]
```

## 6. Multi-Model Consensus Query

Use when you need to verify a critical decision across multiple LLMs.

```
I need a verified answer to this question. Please reason step by step.

Question: [YOUR QUESTION]

Context:
[RELEVANT CONTEXT]

Requirements:
- Show your reasoning explicitly
- Rate your confidence: HIGH / MEDIUM / LOW
- Flag any assumptions you're making
- If you're unsure, say so clearly

This response will be compared against other AI models for consensus.
```

## 7. AAHP Task Creation

```
Create a new AAHP task with the following details:

Title: [TASK TITLE]
Priority: [critical / high / medium / low]
Dependencies: [T-XXX, T-YYY or none]

Format for NEXT_ACTIONS.md:
## T-[NEXT_ID]: [Title]

**Goal:** [One sentence desired outcome]

**Context:**
- [Current state]
- [What has been tried/decided]

**What to do:**
1. [Specific step with file paths]
2. [Step two]
3. [Step three]

**Files:**
- path/to/file: what it does

**Definition of done:**
- [ ] [Acceptance criterion 1]
- [ ] [Acceptance criterion 2]
- [ ] STATUS.md updated
```

## 8. Convention Check

```
Check this code against project conventions:

Conventions to verify:
- [ ] English only (code, comments, docs)
- [ ] No em dashes (hyphens only)
- [ ] Conventional commit format
- [ ] Unit tests for new code
- [ ] No hardcoded secrets
- [ ] Type annotations present
- [ ] Error handling appropriate

Code:
[PASTE CODE]

Report violations with line numbers and suggested fixes.
```

## Usage Notes

- These prompts are designed to be provider-agnostic
- Adapt the [BRACKETED SECTIONS] for your specific use case
- For Claude Code: these can be embedded in custom commands (`.claude/commands/`)
- For other tools: copy-paste and adapt to the tool's prompt format
- Always include relevant context - don't make the model guess
