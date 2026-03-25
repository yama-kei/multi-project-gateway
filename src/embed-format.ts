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
