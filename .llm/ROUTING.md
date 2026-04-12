# Model Routing Guide

> Decision matrix for choosing the right LLM for each task. Provider-agnostic.

## Quick Decision Tree

```
Is it a web search / fact-check?
  YES -> Perplexity sonar-pro (or Grok with web access)

Is it large document analysis (>100K tokens)?
  YES -> Gemini Pro 1M (cheapest large context)

Is it architecture / hard reasoning / security?
  YES -> Claude Opus or GPT-4 (highest reasoning)

Is it code implementation?
  YES -> Claude Sonnet or Codex (fast, accurate coding)

Is it code review?
  YES -> Use a DIFFERENT provider than the implementer

Is it simple formatting / classification / extraction?
  YES -> Haiku, GPT-4-mini, or local LLM (cheapest)

Is it creative / brainstorming?
  YES -> Claude Opus or GPT-4 (best creative output)

Default -> Claude Sonnet (best balance of speed/quality/cost)
```

## Detailed Routing Matrix

| Task Type | Complexity | Primary | Fallback | Cost/Session |
|-----------|-----------|---------|----------|-------------|
| Web research | Any | Perplexity sonar-pro | Gemini + search | $0.05-0.20 |
| Deep research | High | Perplexity deep-research | Grok reasoning | $0.20-0.50 |
| Code generation | Low | Sonnet / GPT-4-mini | Local LLM | $0.10-0.30 |
| Code generation | High | Sonnet / Codex | Opus | $0.20-1.00 |
| Architecture | Any | Opus / GPT-4 | Grok reasoning | $0.50-2.00 |
| Security review | Any | Opus | GPT-4 | $0.50-2.00 |
| Code review | Any | Different provider | - | $0.20-1.00 |
| Bug investigation | Low | Sonnet | Haiku | $0.10-0.30 |
| Bug investigation | High | Opus | GPT-4 | $0.50-2.00 |
| Data extraction | Any | Haiku / local LLM | GPT-4-mini | $0.01-0.10 |
| Formatting | Any | Local LLM / Haiku | GPT-4-mini | $0.01-0.05 |
| Large file analysis | Any | Gemini Pro | Claude 1M | $0.10-0.50 |
| Multi-step automation | Any | OpenClaw agent | Claude Code | $0.20-1.00 |
| Image understanding | Any | Claude / GPT-4 | Gemini | $0.10-0.50 |

## Cost-Aware Escalation Protocol

**Always start cheap, escalate only when needed.**

```
Level 1: Local LLM (free)
  - Simple reformatting, classification, extraction
  - Privacy-sensitive tasks
  - Offline operation

Level 2: Haiku / GPT-4-mini ($0.01-0.10)
  - Basic code generation
  - File exploration
  - Simple Q&A

Level 3: Sonnet / Gemini Flash ($0.10-0.50)
  - Standard coding tasks
  - Most daily work
  - Good balance of speed and quality

Level 4: Opus / GPT-4 / Grok ($0.50-2.00)
  - Architecture decisions
  - Security reviews
  - Complex reasoning
  - Hard debugging

Level 5: Multi-model consensus ($1.00-5.00)
  - Critical production changes
  - Security-sensitive code
  - Implement with A, review with B, verify with C
```

## Cross-Model Verification

For high-stakes work, use models from different providers:

| Step | Provider A | Provider B | Provider C |
|------|-----------|-----------|-----------|
| Implement | Claude Sonnet | - | - |
| Review | - | GPT-4 | - |
| Verify | - | - | Gemini Pro |

**Rule**: The reviewer must be from a different model family than the implementer. This catches blind spots specific to each model's training.

## MCP Tool Mapping

When akido-mcp is available, use these tools:

| Task | MCP Tool | Model |
|------|----------|-------|
| Research with citations | `perplexity_run` | sonar-pro |
| Large context analysis | `gemini_run` | gemini-2.5-pro |
| Fast coding tasks | `codex_run` | gpt-5-codex |
| General GPT tasks | `chatgpt_run` | gpt-5.4 |
| Real-time knowledge | `grok_run` | grok-4.20 |
| Local/private tasks | `local_llm_run` | loaded model |
| Multi-step with plugins | `openclaw_run` | server default |
| Claude from non-Claude | `claude_run` | claude-sonnet-4-6 |
| Threadripper GPU tasks | `local_llm_threadripper` | loaded model |

## When NOT to Route Externally

Stay with the current model when:
- The task is within the current model's sweet spot
- Context switching would lose important conversation state
- The task is simple enough that any model can handle it
- Privacy requirements prohibit sending data to other providers
- The cost of routing exceeds the benefit
