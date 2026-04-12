# Cross-LLM Workflow Patterns

> Patterns that work across all LLM providers. Not tied to any specific tool or API.

## Pattern 1: Implement-Review-Verify (IRV)

The most important pattern for high-quality AI-assisted work.

```
1. IMPLEMENT with Model A (e.g., Claude Sonnet)
   - Write the code, tests, documentation
   - Model A has blind spots from its training

2. REVIEW with Model B (e.g., GPT-4)
   - Different model family catches different issues
   - Focus: correctness, edge cases, security

3. VERIFY with Model C or Human
   - Final check by a third perspective
   - Or human review for critical changes
```

**When to use**: Security-sensitive code, production deployments, architectural decisions.
**When to skip**: Simple bug fixes, documentation updates, formatting changes.

## Pattern 2: Cost-Aware Escalation

Start with the cheapest model. Escalate only when quality is insufficient.

```
Attempt 1: Local LLM / Haiku / GPT-4-mini
  - Simple tasks succeed here (80% of daily work)
  - If output is correct -> done

Attempt 2: Sonnet / Gemini Flash
  - Standard complexity tasks
  - If output is correct -> done

Attempt 3: Opus / GPT-4
  - Complex reasoning required
  - Architecture decisions
  - Security analysis

Attempt 4: Multi-model consensus
  - Critical decisions only
  - Run same prompt through 2-3 providers
  - Compare and synthesize
```

**Key insight**: Most daily tasks don't need the most expensive model. Save budget for when it matters.

## Pattern 3: Heterogeneous Swarm (AAHP Native)

Route different phases of work to specialized models.

```
Phase 1: RESEARCH
  Model: Perplexity (web-grounded)
  Output: Structured findings with citations
  Token cost: Low (focused query)

Phase 2: ARCHITECTURE
  Model: Opus / GPT-4 (high reasoning)
  Input: Research summary (not raw search results)
  Output: ADR with implementation instructions
  Token cost: Medium

Phase 3: IMPLEMENTATION
  Model: Sonnet / Codex (fast coding)
  Input: ADR instructions (not full conversation history)
  Output: Code + tests
  Token cost: Medium

Phase 4: REVIEW
  Model: Different provider than Phase 3
  Input: Diff + ADR (not implementation conversation)
  Output: Review findings
  Token cost: Low
```

**AAHP advantage**: Each model only sees the structured handoff state, not the full conversation history. This saves 98% of tokens vs. passing full context between models.

## Pattern 4: Context Window Management

Different strategies for different context sizes.

```
Small context (<8K): Local LLMs
  - Send only the relevant code snippet
  - Include function signatures, not full files
  - One task at a time

Medium context (8K-128K): Most cloud models
  - Include relevant files fully
  - Add project conventions
  - Room for back-and-forth

Large context (128K-1M): Gemini, Claude
  - Can include entire codebases
  - But: more context != better results
  - Focus attention with clear instructions
  - Use AAHP manifest for orientation, not full file dumps
```

**Best practice**: Even with 1M context, keep prompts focused. "Here are 50 files, find the bug" is worse than "The bug is in auth handling, here are the 3 relevant files."

## Pattern 5: Prompt Portability

Write prompts that work across providers by following these rules:

```
DO:
  - Use clear, structured instructions
  - Separate context from instructions
  - Use markdown formatting (understood by all models)
  - Specify output format explicitly
  - Include examples when possible

DON'T:
  - Use provider-specific syntax
  - Rely on system prompts (not all providers support them equally)
  - Assume tool use works the same everywhere
  - Use XML tags (some models handle them poorly)
```

## Pattern 6: Multi-Model Consensus

For critical decisions, run the same question through multiple models.

```
1. Formulate the question clearly
2. Send to 2-3 different model families:
   - Claude Opus
   - GPT-4
   - Gemini Pro
3. Compare responses:
   - All agree -> High confidence
   - 2/3 agree -> Medium confidence, investigate disagreement
   - All disagree -> Low confidence, needs human judgment
4. Document the consensus in AAHP LOG.md
```

**When to use**: Architecture decisions, security assessments, production deployment decisions.

## Pattern 7: Progressive Summarization

Keep context fresh across long sessions without losing information.

```
Every N messages (or when context gets large):
1. Summarize the conversation so far
2. Extract key decisions and findings
3. Write to AAHP handoff files (STATUS.md, LOG.md)
4. Continue with fresh context + handoff state

This is what AAHP does automatically between agent sessions,
but you can apply it within a single session too.
```

## Pattern 8: Tool-Augmented Generation

Enhance LLM output by combining with tools.

```
For facts: LLM + Web Search (Perplexity, Grok)
For code: LLM + Code Execution (Codex, Claude Code)
For data: LLM + Database queries
For files: LLM + File system access
For git: LLM + Git commands
For infra: LLM + Docker/SSH access

Don't ask the model to guess what it can verify.
```

## Anti-Patterns to Avoid

| Anti-Pattern | Why It's Bad | Better Approach |
|-------------|-------------|-----------------|
| Using Opus for everything | Expensive, often unnecessary | Cost-aware escalation |
| Passing full chat history between models | Token waste, context pollution | AAHP structured handoff |
| Same model for implement + review | Shared blind spots | Cross-model verification |
| Ignoring local LLMs | Free capacity wasted | Use for simple tasks |
| No verification of AI output | Hallucinations propagate | Trust but verify pattern |
| Massive context dumps | Dilutes model attention | Focused, relevant context |
| Hardcoding to one provider | Vendor lock-in, no redundancy | Provider-agnostic patterns |
