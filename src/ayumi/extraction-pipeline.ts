import type { BrokerClient, GmailMessage, GmailMessageFull, CalendarEvent } from '../broker-client.js';
import { shouldExclude, type ExclusionConfig } from './exclusions.js';
import type { TopicName } from '../life-context-setup.js';

export interface ExtractionOptions {
  timeMin: string;
  timeMax: string;
  batchSize?: number;
}

export interface ClassifiedItem {
  sourceId: string;
  source: 'gmail' | 'calendar';
  topic: TopicName;
  tier: 1 | 2 | 3;
  subject: string;
  date: string;
  from: string;
  snippet: string;
  body?: string;
}

const TOPIC_TIER_MAP: Record<TopicName, 1 | 2 | 3> = {
  work: 2,
  travel: 1,
  finance: 3,
  health: 3,
  social: 2,
  hobbies: 1,
};

const BATCH_SIZE = 100;

export async function extractAndClassify(
  client: BrokerClient,
  exclusions: ExclusionConfig,
  options: ExtractionOptions,
): Promise<ClassifiedItem[]> {
  const batchSize = options.batchSize ?? BATCH_SIZE;
  const items: ClassifiedItem[] = [];

  // Fetch Gmail messages (paginated)
  const allMessages = await fetchAllGmail(client, options.timeMin, options.timeMax, batchSize);

  // Filter exclusions
  const filteredMessages = allMessages.filter(
    (m) => !shouldExclude(exclusions, { from: m.from, labelIds: m.labelIds }),
  );

  // Fetch full bodies in batches
  const messageIds = new Set(filteredMessages.map((m) => m.id));
  const fullMessages = (await fetchFullMessages(client, [...messageIds], batchSize)).filter((m) =>
    messageIds.has(m.id),
  );

  // Classify Gmail messages
  for (const msg of fullMessages) {
    const topic = classifyTopic(msg.subject, msg.snippet, msg.from);
    items.push({
      sourceId: msg.id,
      source: 'gmail',
      topic,
      tier: TOPIC_TIER_MAP[topic],
      subject: msg.subject,
      date: msg.date,
      from: msg.from,
      snippet: msg.snippet,
      body: msg.body,
    });
  }

  // Fetch Calendar events
  const calResult = await client.calendarEvents(options.timeMin, options.timeMax);
  for (const evt of calResult.events) {
    const topic = classifyCalendarEvent(evt);
    items.push({
      sourceId: evt.id,
      source: 'calendar',
      topic,
      tier: TOPIC_TIER_MAP[topic],
      subject: evt.title,
      date: evt.start_at,
      from: evt.organizer_email ?? '',
      snippet: evt.description ?? '',
    });
  }

  return items;
}

async function fetchAllGmail(
  client: BrokerClient,
  timeMin: string,
  timeMax: string,
  batchSize: number,
): Promise<GmailMessage[]> {
  const all: GmailMessage[] = [];
  let pageToken: string | undefined;
  const afterDate = timeMin.split('T')[0].replace(/-/g, '/');
  const beforeDate = timeMax.split('T')[0].replace(/-/g, '/');
  const query = `after:${afterDate} before:${beforeDate}`;

  do {
    const result = await client.gmailSearch(query, batchSize, pageToken);
    all.push(...result.messages);
    pageToken = result.nextPageToken;
  } while (pageToken);

  return all;
}

async function fetchFullMessages(
  client: BrokerClient,
  messageIds: string[],
  batchSize: number,
): Promise<GmailMessageFull[]> {
  const all: GmailMessageFull[] = [];

  for (let i = 0; i < messageIds.length; i += batchSize) {
    const batch = messageIds.slice(i, i + batchSize);
    const result = await client.gmailMessages(batch);
    all.push(...result.messages);
  }

  return all;
}

/**
 * Keyword-based topic classifier for Gmail messages.
 * MVP heuristic — future versions will use Claude for nuanced classification.
 */
export function classifyTopic(subject: string, snippet: string, from: string): TopicName {
  const text = `${subject} ${snippet} ${from}`.toLowerCase();

  if (/\b(flight|hotel|airbnb|booking|itinerary|airport|travel|trip|destination)\b/.test(text)) return 'travel';
  if (/\b(invoice|payment|bank|tax|insurance|receipt|billing|subscription|refund)\b/.test(text)) return 'finance';
  if (/\b(doctor|appointment|prescription|medical|health|pharmacy|lab results|diagnosis)\b/.test(text)) return 'health';
  if (/\b(meetup|birthday|party|dinner|gathering|invitation|wedding|reunion)\b/.test(text)) return 'social';
  if (/\b(class|workshop|hobby|gym|yoga|running|hiking|cooking|photography|concert|ticket)\b/.test(text)) return 'hobbies';

  // Default: work (most common for professional email accounts)
  return 'work';
}

/**
 * Keyword-based topic classifier for Calendar events.
 */
export function classifyCalendarEvent(event: CalendarEvent): TopicName {
  const text = `${event.title} ${event.description ?? ''} ${event.location ?? ''}`.toLowerCase();

  if (/\b(flight|hotel|travel|trip|airport)\b/.test(text)) return 'travel';
  if (/\b(doctor|dentist|medical|health|therapy|checkup)\b/.test(text)) return 'health';
  if (/\b(dinner|party|birthday|gathering|social|meetup)\b/.test(text)) return 'social';
  if (/\b(gym|yoga|run|hike|class|hobby|concert)\b/.test(text)) return 'hobbies';
  if (/\b(tax|accountant|financial|bank)\b/.test(text)) return 'finance';

  return 'work';
}
