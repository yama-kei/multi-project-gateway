export interface ThreadLink {
  sourceThread: string;
  targetThread: string;
  sourceChannel: string;
  turnCount: number;
}

export interface ThreadLinkRegistry {
  link(sourceThread: string, targetThread: string, sourceChannel: string): ThreadLink;
  getLinkedThread(threadId: string): ThreadLink | null;
  recordTurn(sourceThread: string, targetThread: string): number;
  isOverLimit(sourceThread: string, targetThread: string, max: number): boolean;
  resetPair(sourceThread: string, targetThread: string): void;
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

export function createThreadLinkRegistry(): ThreadLinkRegistry {
  const links = new Map<string, ThreadLink>();
  const threadIndex = new Map<string, string>();

  return {
    link(sourceThread: string, targetThread: string, sourceChannel: string): ThreadLink {
      const key = pairKey(sourceThread, targetThread);
      const existing = links.get(key);
      if (existing) return existing;

      const link: ThreadLink = { sourceThread, targetThread, sourceChannel, turnCount: 0 };
      links.set(key, link);
      threadIndex.set(sourceThread, key);
      threadIndex.set(targetThread, key);
      return link;
    },

    getLinkedThread(threadId: string): ThreadLink | null {
      const key = threadIndex.get(threadId);
      if (!key) return null;
      return links.get(key) ?? null;
    },

    recordTurn(sourceThread: string, targetThread: string): number {
      const key = pairKey(sourceThread, targetThread);
      const link = links.get(key);
      if (!link) return 0;
      link.turnCount++;
      return link.turnCount;
    },

    isOverLimit(sourceThread: string, targetThread: string, max: number): boolean {
      const key = pairKey(sourceThread, targetThread);
      const link = links.get(key);
      if (!link) return false;
      return link.turnCount >= max;
    },

    resetPair(sourceThread: string, targetThread: string): void {
      const key = pairKey(sourceThread, targetThread);
      const link = links.get(key);
      if (link) link.turnCount = 0;
    },
  };
}
