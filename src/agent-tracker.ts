export interface AgentTracker {
  track(messageId: string): void;
  isAgentMessage(messageId: string): boolean;
  trackCrossPost(messageId: string): void;
  isCrossPost(messageId: string): boolean;
}

export function createAgentTracker(): AgentTracker {
  const agentMessages = new Set<string>();
  const crossPosts = new Set<string>();

  return {
    track(messageId: string): void {
      agentMessages.add(messageId);
    },

    isAgentMessage(messageId: string): boolean {
      const found = agentMessages.has(messageId);
      if (found) agentMessages.delete(messageId);
      return found;
    },

    trackCrossPost(messageId: string): void {
      crossPosts.add(messageId);
    },

    isCrossPost(messageId: string): boolean {
      const found = crossPosts.has(messageId);
      if (found) crossPosts.delete(messageId);
      return found;
    },
  };
}
