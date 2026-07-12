import { agentOfTurn, type Turn } from '../../shared/types.ts';

/**
 * What a conversation *shows* — the three scopes, nested inside one another.
 *
 * The server does the merge (`server/conversation.ts`); this only chooses how much of it to read.
 * Every turn already carries the three things a scope can ask about — which orchestrator, which
 * agent, which task — so this is a filter and never a second derivation. A client that re-decided
 * who was talking to whom would be a second implementation of the trap the whole feature is about.
 *
 * The scopes are the gestures the tool is made of, and they nest:
 *
 * 1. **One orchestrator** — the default, and everything it and its agents ever said.
 * 2. **One agent inside it** — the rail's central gesture, and the same click that dims the canvas
 *    to that agent's tasks.
 * 3. **One task** — what the node inspector shows: the prompt it was dispatched with, what the
 *    agent said back, the question it raised, and the report it filed.
 *
 * Pure, and free of React, because the evidence is a *database*: the suite asserts this against a
 * real snapshot of the live-shaped corpus (`test/server/conversation.test.ts`), not against a
 * hand-written array that could agree with it by construction.
 */

export type TurnScope = {
  /**
   * The orchestrator, or **null for every turn there is**.
   *
   * Null is the "All" scope, and it is not a convenience — it is where a turn the server could not
   * place has to live. There are no foreign keys in this schema and a message can name handles no
   * run claims, so `runId` is honestly null for some of them (SPEC §4.4, rule 3). They appear here
   * and nowhere else: **an unattributable message still appears, attached to nobody**, rather than
   * being guessed into somebody's conversation.
   */
  runId: string | null;
  /** One agent's half of it — every turn to or from them. Null ⇒ the whole cast. */
  agentHandle?: string | null;
  /** One task's exchange, end to end. Null ⇒ every task. */
  taskId?: string | null;
};

export function selectTurns(turns: readonly Turn[], scope: TurnScope): Turn[] {
  return turns.filter((turn) => {
    if (scope.runId !== null && turn.runId !== scope.runId) return false;
    if (scope.agentHandle != null && agentOfTurn(turn) !== scope.agentHandle) return false;
    if (scope.taskId != null && turn.taskId !== scope.taskId) return false;
    return true;
  });
}

/** How many exchanges a scope holds — the count in the panel header, and never the heartbeats. */
export function exchangeCount(turns: readonly Turn[]): number {
  // A collapsed heartbeat row stands in for 302 messages that all say "alive". Counting it as an
  // exchange would tell a reader an orchestrator said far more than it did.
  return turns.filter((turn) => turn.kind !== 'heartbeats').length;
}
