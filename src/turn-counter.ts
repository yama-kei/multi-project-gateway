// src/turn-counter.ts
export interface TurnCounter {
  increment(threadId: string): void;
  getTurns(threadId: string): number;
  isOverLimit(threadId: string, limit: number): boolean;
  reset(threadId: string): void;
}

export function createTurnCounter(): TurnCounter {
  const turns = new Map<string, number>();

  return {
    increment(threadId: string): void {
      turns.set(threadId, (turns.get(threadId) ?? 0) + 1);
    },

    getTurns(threadId: string): number {
      return turns.get(threadId) ?? 0;
    },

    isOverLimit(threadId: string, limit: number): boolean {
      return (turns.get(threadId) ?? 0) >= limit;
    },

    reset(threadId: string): void {
      turns.delete(threadId);
    },
  };
}
