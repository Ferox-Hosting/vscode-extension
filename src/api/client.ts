import type {
  DirectoryEntry,
  DirectoryListResponse,
  FileSearchFilters,
  FractalItem,
  FractalList,
  PowerAction,
  PublicSettings,
  Server,
  ServerAttributes,
  WebsocketCredentials,
} from './types.ts';

function toServer(item: FractalItem<ServerAttributes>): Server {
  const attributes = item.attributes;
  return {
    uuid: attributes.uuid,
    uuid_short: attributes.identifier,
    name: attributes.name,
    description: attributes.description,
    suspended: attributes.suspended === true,
  };
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function apiError(response: Response): Promise<ApiError> {
  let message = `${response.status} ${response.statusText}`;
  try {
    const body = (await response.json()) as { error?: unknown; errors?: unknown[] };
    if (typeof body.error === 'string') {
      message = body.error;
    } else if (Array.isArray(body.errors) && body.errors.length > 0) {
      const first = body.errors[0];
      if (typeof first === 'string') {
        message = first;
      } else if (first && typeof first === 'object' && typeof (first as { detail?: unknown }).detail === 'string') {
        // Pterodactyl renders API errors in JSON:API format: { errors: [{ detail }] }.
        message = (first as { detail: string }).detail;
      }
    }
  } catch {
    // not json
  }
  return new ApiError(response.status, message);
}

export interface Credentials {
  origin: string;
  apiKey: string;
}

export type ReauthHandler = (client: PanelClient) => Promise<boolean>;

export class PanelClient {
  readonly origin: string;
  private apiKey: string;

  constructor(
    credentials: Credentials,
    private readonly reauth?: ReauthHandler,
  ) {
    this.origin = credentials.origin;
    this.apiKey = credentials.apiKey;
  }

  setApiKey(apiKey: string): void {
    this.apiKey = apiKey;
  }

  private async request(path: string, init: RequestInit = {}, allowReauth = true): Promise<Response> {
    const response = await fetch(`${this.origin}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: 'application/json',
        ...init.headers,
      },
    });

    if (response.status === 401 && allowReauth && this.reauth && (await this.reauth(this))) {
      return this.request(path, init, false);
    }

    if (!response.ok) {
      throw await apiError(response);
    }

    return response;
  }

  private async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.request(path, init);
    return (await response.json()) as T;
  }

  async ping(): Promise<void> {
    await this.request('/api/client/servers?per_page=1');
  }

  async getPublicSettings(): Promise<PublicSettings> {
    return this.json<PublicSettings>('/api/settings');
  }

  async listServers(search?: string): Promise<Server[]> {
    // The 0.7.x client endpoint ignores a free-text search parameter, so any
    // filtering is left to the caller's quick-pick. We page through the Fractal
    // envelope until the reported page count is exhausted.
    const servers: Server[] = [];
    for (let page = 1; ; page++) {
      const params = new URLSearchParams({ page: `${page}` });
      if (search) params.set('search', search);

      const body = await this.json<FractalList<ServerAttributes>>(`/api/client/servers?${params}`);
      servers.push(...body.data.map(toServer));

      const pagination = body.meta?.pagination;
      if (!pagination || pagination.total_pages <= page || body.data.length === 0) {
        return servers;
      }
    }
  }

  async getServer(uuid: string): Promise<Server> {
    const body = await this.json<FractalItem<ServerAttributes>>(`/api/client/servers/${uuid}`);
    return toServer(body);
  }

  async listDirectory(server: string, directory: string): Promise<DirectoryEntry[]> {
    const params = new URLSearchParams({ directory });
    const body = await this.json<DirectoryListResponse>(`/api/client/servers/${server}/files/list?${params}`);
    return body.entries;
  }

  async readFile(server: string, file: string): Promise<Uint8Array> {
    // The panel's file-contents endpoint transports the body inside a JSON
    // string field, which can only hold valid UTF-8 and therefore silently
    // corrupts (or fails on) binary files. Instead we ask the panel for a
    // one-time raw-download URL and stream the file byte-for-byte from the
    // daemon, which works for any file type or size.
    const params = new URLSearchParams({ file });
    const { url } = await this.json<{ url: string }>(`/api/client/servers/${server}/files/download?${params}`);

    // The download URL targets the daemon directly and is authenticated by the
    // one-time token embedded in it, so it must be fetched without the panel
    // Authorization header.
    const response = await fetch(url);
    if (!response.ok) {
      throw new ApiError(response.status, `${response.status} ${response.statusText}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  async writeFile(server: string, file: string, content: Uint8Array): Promise<void> {
    const params = new URLSearchParams({ file });
    await this.request(`/api/client/servers/${server}/files/write?${params}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: Buffer.from(content),
    });
  }

  async createDirectory(server: string, root: string, name: string): Promise<void> {
    await this.request(`/api/client/servers/${server}/files/create-directory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root, name }),
    });
  }

  async rename(server: string, from: string, to: string): Promise<void> {
    await this.request(`/api/client/servers/${server}/files/rename`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root: '/', files: [{ from, to }] }),
    });
  }

  async delete(server: string, files: string[]): Promise<void> {
    await this.request(`/api/client/servers/${server}/files/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root: '/', files }),
    });
  }

  async searchFiles(server: string, filters: FileSearchFilters): Promise<DirectoryEntry[]> {
    const body = await this.json<{ entries: DirectoryEntry[] }>(`/api/client/servers/${server}/files/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(filters),
    });
    return body.entries;
  }

  async getWebsocketCredentials(server: string): Promise<WebsocketCredentials> {
    return this.json<WebsocketCredentials>(`/api/client/servers/${server}/websocket`);
  }

  async sendPowerAction(server: string, action: PowerAction): Promise<void> {
    await this.request(`/api/client/servers/${server}/power`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    });
  }
}
