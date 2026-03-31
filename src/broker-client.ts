/**
 * Typed HTTP client for the HouseholdOS credential broker API.
 * Used by Ayumi agents to access Gmail, Calendar, and Drive
 * without handling raw OAuth tokens.
 */

export interface BrokerConfig {
  brokerUrl: string;
  apiSecret: string;
  tenantId: string;
  actorId: string;
}

export class BrokerError extends Error {
  constructor(
    public status: number,
    public body: unknown,
  ) {
    super(`Broker API error (${status})`);
    this.name = 'BrokerError';
  }
}

// --- Response types ---

export interface GmailMessage {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  snippet: string;
  date: string;
  labelIds: string[];
  hasAttachments: boolean;
}

export interface GmailMessageFull extends GmailMessage {
  body: string;
  bodyHtml: string;
}

export interface GmailSearchResult {
  messages: GmailMessage[];
  nextPageToken?: string;
}

export interface GmailMessagesResult {
  messages: GmailMessageFull[];
}

export interface CalendarEvent {
  id: string;
  title: string;
  description: string | null;
  start_at: string;
  end_at: string;
  all_day: boolean;
  location: string | null;
  organizer_email: string | null;
  status: string;
}

export interface CalendarEventsResult {
  events: CalendarEvent[];
}

export interface DriveFile {
  file_id: string;
  name: string;
  mime_type: string;
  size_bytes: number | null;
  modified_at: string;
  web_view_link: string | null;
}

export interface DriveReadResult {
  name: string;
  mime_type: string;
  content: string;
}

export interface DriveWriteResult {
  file_id: string;
  name: string;
  mime_type: string;
  web_view_link: string | null;
}

export interface DriveSearchResult {
  files: DriveFile[];
}

export interface DriveCreateFolderResult {
  folder_id: string;
  name: string;
  web_view_link: string | null;
}

export interface DriveListResult {
  files: DriveFile[];
}

export interface BrokerClient {
  health(): Promise<{ ok: boolean }>;
  gmailSearch(q: string, maxResults?: number, pageToken?: string): Promise<GmailSearchResult>;
  gmailMessages(messageIds: string[]): Promise<GmailMessagesResult>;
  calendarEvents(timeMin: string, timeMax: string, limit?: number): Promise<CalendarEventsResult>;
  driveRead(fileId: string): Promise<DriveReadResult>;
  driveWrite(name: string, content: string, format?: string): Promise<DriveWriteResult>;
  driveSearch(query: string): Promise<DriveSearchResult>;
  driveCreateFolder(name: string, parentId?: string): Promise<DriveCreateFolderResult>;
  driveList(folderId: string, query?: string): Promise<DriveListResult>;
}

export function createBrokerClient(config: BrokerConfig): BrokerClient {
  const { brokerUrl, apiSecret, tenantId, actorId } = config;
  const base = brokerUrl.replace(/\/$/, '');

  async function request<T>(method: string, path: string, body?: Record<string, unknown>): Promise<T> {
    const url = `${base}/broker${path}`;
    const headers: Record<string, string> = {
      'X-Broker-Secret': apiSecret,
    };
    const init: RequestInit = { method, headers };

    if (body) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify({ tenantId, actorId, ...body });
    }

    const res = await fetch(url, init);
    const json = await res.json();

    if (!res.ok) {
      throw new BrokerError(res.status, json);
    }

    return json as T;
  }

  return {
    health: () => request('GET', '/health'),
    gmailSearch: (q, maxResults, pageToken) =>
      request('POST', '/gmail/search', { q, maxResults, pageToken }),
    gmailMessages: (messageIds) =>
      request('POST', '/gmail/messages', { messageIds }),
    calendarEvents: (timeMin, timeMax, limit) =>
      request('POST', '/calendar/events', { timeMin, timeMax, limit }),
    driveRead: (fileId) =>
      request('POST', '/drive/read', { fileId }),
    driveWrite: (name, content, format) =>
      request('POST', '/drive/write', { name, content, format }),
    driveSearch: (query) =>
      request('POST', '/drive/search', { query }),
    driveCreateFolder: (name, parentId) =>
      request('POST', '/drive/create-folder', { name, parentId }),
    driveList: (folderId, query) =>
      request('POST', '/drive/list', { folderId, query }),
  };
}

/**
 * Create a broker client from environment variables.
 * Required: BROKER_URL, BROKER_API_SECRET, BROKER_TENANT_ID, BROKER_ACTOR_ID
 */
export function createBrokerClientFromEnv(): BrokerClient {
  const brokerUrl = process.env.BROKER_URL;
  const apiSecret = process.env.BROKER_API_SECRET;
  const tenantId = process.env.BROKER_TENANT_ID;
  const actorId = process.env.BROKER_ACTOR_ID;

  if (!brokerUrl || !apiSecret || !tenantId || !actorId) {
    throw new Error(
      'Missing broker env vars. Required: BROKER_URL, BROKER_API_SECRET, BROKER_TENANT_ID, BROKER_ACTOR_ID',
    );
  }

  return createBrokerClient({ brokerUrl, apiSecret, tenantId, actorId });
}
