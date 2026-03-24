export interface Directive {
  action: 'POST_TO';
  targetChannel: string;
  content: string;
}

export interface ParseResult {
  cleanText: string;
  directive: Directive | null;
}

const OPEN_DELIM = '---mpg-directive\n';
const CLOSE_DELIM = '\n---';

export function parseDirective(text: string): ParseResult {
  const trimmed = text.trimEnd();

  if (!trimmed.endsWith('---')) {
    return { cleanText: text, directive: null };
  }

  const openIdx = trimmed.lastIndexOf(OPEN_DELIM);
  if (openIdx === -1) {
    return { cleanText: text, directive: null };
  }

  const blockBody = trimmed.slice(openIdx + OPEN_DELIM.length);

  const closeIdx = blockBody.lastIndexOf(CLOSE_DELIM);
  if (closeIdx === -1) {
    if (!blockBody.endsWith('---')) {
      return { cleanText: text, directive: null };
    }
    return { cleanText: text, directive: null };
  }

  const afterClose = blockBody.slice(closeIdx + CLOSE_DELIM.length);
  if (afterClose.length > 0) {
    return { cleanText: text, directive: null };
  }

  const innerContent = blockBody.slice(0, closeIdx);
  const lines = innerContent.split('\n');
  const actionLine = lines[0]?.trim();

  if (!actionLine) {
    return { cleanText: text, directive: null };
  }

  const postToMatch = actionLine.match(/^POST_TO:\s*#?(.+)$/);
  if (!postToMatch) {
    return { cleanText: text, directive: null };
  }

  const targetChannel = postToMatch[1].trim();
  const content = lines.slice(1).join('\n').trim();

  const cleanText = text.slice(0, openIdx).trimEnd();

  return {
    cleanText,
    directive: {
      action: 'POST_TO',
      targetChannel,
      content,
    },
  };
}
