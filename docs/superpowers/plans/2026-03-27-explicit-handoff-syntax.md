# Explicit Handoff Syntax Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace bare `@agent` mention detection in agent responses with explicit `HANDOFF @agent: <task>` syntax, preventing accidental and false handoffs.

**Architecture:** Add `parseHandoffCommand` to `agent-dispatch.ts`, switch the handoff loop in `discord.ts` to use it instead of `parseAgentMention`, and update all persona prompts to use the new syntax.

**Tech Stack:** TypeScript, Vitest

**Closes:** #71

---

### Task 1: Add `parseHandoffCommand` function

**Files:**
- Modify: `src/agent-dispatch.ts`
- Modify: `tests/agent-dispatch.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `tests/agent-dispatch.test.ts`:

```typescript
import { parseAgentMention, parseAgentCommand, extractAskTarget, parseHandoffCommand, type AgentConfig } from '../src/agent-dispatch.js';

// ... existing tests ...

describe('parseHandoffCommand', () => {
  it('matches HANDOFF @agent: task', () => {
    const result = parseHandoffCommand('HANDOFF @engineer: implement the login feature', agents);
    expect(result).toEqual({
      agentName: 'engineer',
      agent: agents.engineer,
      prompt: 'implement the login feature',
    });
  });

  it('is case-insensitive for keyword', () => {
    const result = parseHandoffCommand('handoff @pm: review the spec', agents);
    expect(result).toEqual({
      agentName: 'pm',
      agent: agents.pm,
      prompt: 'review the spec',
    });
  });

  it('matches when HANDOFF is not on the first line', () => {
    const text = 'I have finished the spec.\n\nHANDOFF @engineer: implement it based on the spec above';
    const result = parseHandoffCommand(text, agents);
    expect(result).toEqual({
      agentName: 'engineer',
      agent: agents.engineer,
      prompt: 'implement it based on the spec above',
    });
  });

  it('returns null for bare @agent mentions (no HANDOFF keyword)', () => {
    expect(parseHandoffCommand('@engineer please implement this', agents)).toBeNull();
    expect(parseHandoffCommand('Hey @pm review this', agents)).toBeNull();
  });

  it('returns null for conversational references to agents', () => {
    expect(parseHandoffCommand("Once approved, I'll hand off to @engineer", agents)).toBeNull();
    expect(parseHandoffCommand('The engineer will handle this', agents)).toBeNull();
  });

  it('returns null for unknown agent', () => {
    expect(parseHandoffCommand('HANDOFF @tester: run the suite', agents)).toBeNull();
  });

  it('returns null when no agents configured', () => {
    expect(parseHandoffCommand('HANDOFF @pm: do it', {})).toBeNull();
  });

  it('handles extra whitespace around colon', () => {
    const result = parseHandoffCommand('HANDOFF @pm :  review this PR', agents);
    expect(result).toEqual({
      agentName: 'pm',
      agent: agents.pm,
      prompt: 'review this PR',
    });
  });

  it('captures rest of line as prompt (not multiline)', () => {
    const text = 'HANDOFF @engineer: implement login\nExtra context on next line';
    const result = parseHandoffCommand(text, agents);
    expect(result!.prompt).toBe('implement login');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/agent-dispatch.test.ts`
Expected: FAIL — `parseHandoffCommand` is not exported

- [ ] **Step 3: Implement parseHandoffCommand**

Add to `src/agent-dispatch.ts` after the `parseAgentMention` function:

```typescript
/**
 * Parse explicit `HANDOFF @agent: <task>` command in agent responses.
 * Only this syntax triggers auto-handoff — bare @agent mentions are ignored.
 */
export function parseHandoffCommand(
  text: string,
  agents: Record<string, AgentConfig>,
): AgentMention | null {
  const agentNames = Object.keys(agents);
  if (agentNames.length === 0) return null;

  const escaped = agentNames.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(`^HANDOFF\\s+@(${escaped.join('|')})\\s*:\\s*(.*)$`, 'im');
  const match = text.match(pattern);
  if (!match) return null;

  const matchedName = match[1].toLowerCase();
  const agent = agents[matchedName];
  if (!agent) return null;

  return { agentName: matchedName, agent, prompt: match[2].trim() };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/agent-dispatch.test.ts`
Expected: PASS — all tests including new `parseHandoffCommand` tests

- [ ] **Step 5: Commit**

```bash
git add src/agent-dispatch.ts tests/agent-dispatch.test.ts
git commit -m "feat: add parseHandoffCommand for explicit handoff syntax (#71)"
```

---

### Task 2: Switch handoff loop to use `parseHandoffCommand`

**Files:**
- Modify: `src/discord.ts:7,404`
- Modify: `tests/discord.test.ts:265-370`

- [ ] **Step 1: Update the import in discord.ts**

In `src/discord.ts`, change line 6:

```typescript
import { parseAgentMention } from './agent-dispatch.js';
```

to:

```typescript
import { parseAgentMention, parseHandoffCommand } from './agent-dispatch.js';
```

- [ ] **Step 2: Change the handoff loop detection**

In `src/discord.ts`, in the handoff loop (line 404), change:

```typescript
          const handoff = parseAgentMention(responseText, agents);
```

to:

```typescript
          const handoff = parseHandoffCommand(responseText, agents);
```

This is the ONLY change in the loop — everything else (turn counting, announcements, session dispatch) stays the same.

- [ ] **Step 3: Update handoff flow tests**

In `tests/discord.test.ts`, add the import:

```typescript
import { parseAgentMention, parseHandoffCommand } from '../src/agent-dispatch.js';
```

Update the `'simulates a full handoff chain with turn limit'` test to use `HANDOFF` syntax:

```typescript
  it('simulates a full handoff chain with turn limit', async () => {
    const turnCounter = createTurnCounter();
    const threadId = 'thread-handoff-test';
    const maxTurns = 3;

    // Simulate: PM uses HANDOFF to dispatch to engineer, engineer uses HANDOFF back
    const responses = [
      'Great analysis!\n\nHANDOFF @engineer: please implement the login feature.',
      'Done implementing.\n\nHANDOFF @pm: please review the PR.',
      'Looks good!\n\nHANDOFF @engineer: please add tests.',
      'Tests added.\n\nHANDOFF @pm: ready for merge.',
    ];

    turnCounter.reset(threadId);

    let responseIndex = 0;
    let currentAgent: string | undefined;
    let responseText = responses[responseIndex++];
    currentAgent = 'pm';

    const handoffLog: string[] = [];

    while (true) {
      const handoff = parseHandoffCommand(responseText, agents);
      if (!handoff || handoff.agentName === currentAgent) break;

      turnCounter.increment(threadId);
      if (turnCounter.isOverLimit(threadId, maxTurns)) {
        handoffLog.push(`limit-reached at turn ${turnCounter.getTurns(threadId)}`);
        break;
      }

      handoffLog.push(`${currentAgent ?? 'user'} → ${handoff.agentName}`);

      responseText = responses[responseIndex++] ?? 'No more responses.';
      currentAgent = handoff.agentName;
    }

    expect(handoffLog).toEqual([
      'pm → engineer',
      'engineer → pm',
      'limit-reached at turn 3',
    ]);
    expect(turnCounter.getTurns(threadId)).toBe(3);
    expect(turnCounter.isOverLimit(threadId, maxTurns)).toBe(true);
  });
```

Update the `'stops handoff when response does not mention another agent'` test:

```typescript
  it('stops handoff when response does not mention another agent', () => {
    const turnCounter = createTurnCounter();
    const threadId = 'thread-no-handoff';

    turnCounter.reset(threadId);
    const responseText = 'All done, no more handoffs needed.';
    const handoff = parseHandoffCommand(responseText, agents);

    expect(handoff).toBeNull();
    expect(turnCounter.getTurns(threadId)).toBe(0);
  });
```

Update the `'stops handoff when agent mentions itself'` test to verify bare `@agent` does NOT trigger handoff:

```typescript
  it('bare @agent mention does not trigger handoff', () => {
    const responseText = 'I told @engineer to think about this more...';
    const handoff = parseHandoffCommand(responseText, agents);
    expect(handoff).toBeNull();
  });
```

Add a new test verifying conversational `@agent` is ignored:

```typescript
  it('conversational @agent reference does not trigger handoff', () => {
    const responseText = "Once approved, I'll ask @engineer to implement it.";
    const handoff = parseHandoffCommand(responseText, agents);
    expect(handoff).toBeNull();
  });
```

Replace the `buildHandoffEmbed` import test with an updated one:

```typescript
  it('HANDOFF command triggers handoff detection', () => {
    const responseText = 'Analysis complete.\n\nHANDOFF @engineer: implement the feature';
    const handoff = parseHandoffCommand(responseText, agents);
    expect(handoff).not.toBeNull();
    expect(handoff!.agentName).toBe('engineer');
    expect(handoff!.prompt).toBe('implement the feature');
  });
```

- [ ] **Step 4: Run all tests**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/discord.ts tests/discord.test.ts
git commit -m "feat: switch handoff loop to parseHandoffCommand (#71)"
```

---

### Task 3: Update persona prompts

**Files:**
- Modify: `src/persona-presets.ts`
- Test: `tests/persona-presets.test.ts`

- [ ] **Step 1: Update PM preset**

Replace the entire PM prompt array in `src/persona-presets.ts`:

```typescript
  pm: {
    role: 'Product Manager',
    prompt: [
      'You are a Product Manager working in a multi-agent Discord thread.',
      'Your responsibilities:',
      '- Clarify requirements and acceptance criteria before handing work to engineers.',
      '- Break down features into concrete, actionable tasks.',
      '- Prioritize work based on user impact and feasibility.',
      '- Ask clarifying questions when requirements are ambiguous.',
      '- Summarize decisions and next steps clearly.',
      '',
      'Communication style: concise, structured, and action-oriented.',
      '',
      'CRITICAL — Handing off work to other agents:',
      '- To dispatch work, write HANDOFF @engineer: followed by the task description.',
      '- Only use HANDOFF when you are ready to dispatch work NOW, not when describing future plans.',
      '- The gateway routes your HANDOFF to that agent automatically.',
      '- Do NOT use the Agent tool to do engineering work yourself. You are a PM, not an engineer.',
      '- Do NOT implement code, run tests, or create PRs yourself.',
      '- After writing HANDOFF, END your response. The engineer will reply in the same thread.',
      '- Example: "HANDOFF @engineer: Please implement feature X. Requirements: ..."',
      '',
      'IMPORTANT — Referring to other agents without dispatching:',
      '- To reference another agent conversationally, say "the engineer" or "the PM" — never write @agent outside of a HANDOFF command.',
      '- Writing @engineer without HANDOFF will NOT dispatch work and the engineer will never see it.',
    ].join('\n'),
  },
```

- [ ] **Step 2: Update engineer preset**

Replace the entire engineer prompt array:

```typescript
  engineer: {
    role: 'Software Engineer',
    prompt: [
      'You are a Software Engineer working in a multi-agent Discord thread.',
      'Your responsibilities:',
      '- Write clean, well-tested code that meets the requirements.',
      '- Follow existing project conventions and patterns.',
      '- Consider edge cases, error handling, and performance.',
      '- Explain technical trade-offs when relevant.',
      '- Ask for clarification when requirements are unclear rather than guessing.',
      '',
      'Communication style: precise and technical, but accessible to non-engineers.',
      '',
      'When you finish your work, report what you did (files changed, tests, PR link if created).',
      'If you need the PM to review or approve, write HANDOFF @pm: followed by your update.',
      'Example: "HANDOFF @pm: Implementation complete. PR #42 is ready for review."',
      '',
      'IMPORTANT — Referring to other agents without dispatching:',
      '- To reference another agent conversationally, say "the PM" or "the designer" — never write @agent outside of a HANDOFF command.',
      '- Writing @pm without HANDOFF will NOT dispatch and the PM will never see it.',
    ].join('\n'),
  },
```

- [ ] **Step 3: Add dispatch guidance to qa, designer, devops presets**

Add these two lines to the end of each preset's prompt array (before the closing `].join('\n')`):

For `qa`:
```typescript
      '',
      'To dispatch work to another agent, write HANDOFF @agent: followed by the task.',
      'To reference another agent conversationally, say "the engineer" or "the PM" — never write @agent outside of a HANDOFF command.',
```

For `designer`:
```typescript
      '',
      'To dispatch work to another agent, write HANDOFF @agent: followed by the task.',
      'To reference another agent conversationally, say "the engineer" or "the PM" — never write @agent outside of a HANDOFF command.',
```

For `devops`:
```typescript
      '',
      'To dispatch work to another agent, write HANDOFF @agent: followed by the task.',
      'To reference another agent conversationally, say "the engineer" or "the PM" — never write @agent outside of a HANDOFF command.',
```

- [ ] **Step 4: Run all tests**

Run: `npx vitest run`
Expected: All tests PASS (persona-presets tests only check that role and prompt are truthy, so they'll pass)

- [ ] **Step 5: Commit**

```bash
git add src/persona-presets.ts
git commit -m "feat: update persona prompts to use HANDOFF dispatch syntax (#71)"
```
