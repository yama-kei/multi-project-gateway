// src/embed-format.ts
import { EmbedBuilder, type TextChannel, type ThreadChannel } from 'discord.js';
import { chunkMessage } from './discord.js';

/** 10 high-contrast colors for light and dark Discord themes. */
export const PALETTE: readonly number[] = [
  0x3498db, // blue
  0xe74c3c, // red
  0x2ecc71, // green
  0x9b59b6, // purple
  0xf39c12, // orange
  0x1abc9c, // teal
  0xe91e63, // pink
  0xff9800, // amber
  0x00bcd4, // cyan
  0x8bc34a, // lime
];

/** Deterministic color for an agent key (djb2 hash mod palette length). */
export function agentColor(agentKey: string): number {
  let hash = 0;
  for (const ch of agentKey) hash = ((hash << 5) - hash + ch.charCodeAt(0)) | 0;
  return PALETTE[Math.abs(hash) % PALETTE.length];
}

const EMBED_DESCRIPTION_LIMIT = 4096;

/** Build Discord embeds for an agent response, chunking at 4096 chars. */
export function buildAgentEmbeds(text: string, agentName: string, agentRole: string): EmbedBuilder[] {
  const color = agentColor(agentName);
  const chunks = chunkMessage(text, EMBED_DESCRIPTION_LIMIT);

  return chunks.map((chunk, i) => {
    const authorName = i === 0 ? agentRole : `${agentRole} (cont.)`;
    const embed = new EmbedBuilder()
      .setAuthor({ name: authorName })
      .setColor(color);
    if (chunk) {
      embed.setDescription(chunk);
    } else {
      embed.data.description = '';
    }
    return embed;
  });
}

/** Build a small embed announcing an agent handoff. */
export function buildHandoffEmbed(agentName: string, agentRole: string): EmbedBuilder {
  return new EmbedBuilder()
    .setAuthor({ name: agentRole })
    .setDescription(`Handing off to **@${agentName}**...`)
    .setColor(agentColor(agentName));
}

/** Build an embed announcing parallel fan-out to multiple agents. */
export function buildFanOutEmbed(agentNames: string[]): EmbedBuilder {
  const list = agentNames.map(n => `**@${n}**`).join(', ');
  return new EmbedBuilder()
    .setAuthor({ name: 'Life Context Router' })
    .setDescription(`Dispatching to ${agentNames.length} agents: ${list}...`)
    .setColor(PALETTE[0]);
}

const PLAIN_TEXT_LIMIT = 2000;

/** Send a message as embeds (if agent) or plain text (if not). */
export async function sendAgentMessage(
  channel: { send(content: unknown): Promise<unknown> },
  text: string,
  agentName?: string,
  agentRole?: string,
): Promise<void> {
  if (agentName && agentRole) {
    const embeds = buildAgentEmbeds(text, agentName, agentRole);
    for (const embed of embeds) {
      await channel.send({ embeds: [embed] });
    }
  } else {
    const chunks = chunkMessage(text, PLAIN_TEXT_LIMIT);
    for (const chunk of chunks) {
      await channel.send(chunk);
    }
  }
}
