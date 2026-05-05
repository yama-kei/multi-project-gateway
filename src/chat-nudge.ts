/**
 * System-prompt nudge appended to every chat-routed Claude session. It tells
 * the model that menu-style tool prompts have no usable surface in chat
 * transports and that it should fall back to plain-text numbered lists.
 *
 * This is defense-in-depth alongside `--disallowed-tools AskUserQuestion
 * EnterPlanMode` — even if a tool slipped through the denylist, this
 * keeps the conversational UX usable.
 */
export const NON_INTERACTIVE_CHAT_NUDGE =
  'IMPORTANT: This session runs in a non-interactive chat context (Discord/Slack-routed). When you would ask the user to pick from a menu, present a numbered list in plain text and ask them to reply with the option number or text. Do not use menu-style tool prompts — the operator cannot respond to them.';

/**
 * Append the chat nudge to a system prompt, or return the nudge alone when
 * no system prompt is provided.
 */
export function applyChatNudge(systemPrompt: string | undefined): string {
  if (!systemPrompt) return NON_INTERACTIVE_CHAT_NUDGE;
  return `${systemPrompt}\n\n${NON_INTERACTIVE_CHAT_NUDGE}`;
}
