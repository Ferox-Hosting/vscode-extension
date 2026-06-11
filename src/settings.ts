import type { PublicSettings } from './api/types.ts';
import { log } from './log.ts';
import type { Session } from './session.ts';

const TTL_MS = 5 * 60_000;

export class SettingsCache {
  private readonly cached = new Map<string, { at: number; value: PublicSettings }>();
  private readonly inflight = new Map<string, Promise<PublicSettings>>();

  constructor(private readonly session: Session) {
    session.onDidChange(() => {
      this.cached.clear();
      this.inflight.clear();
    });
  }

  async get(origin?: string): Promise<PublicSettings> {
    const client = await this.session.client(origin);
    const key = client.origin;

    const hit = this.cached.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) {
      return hit.value;
    }

    let pending = this.inflight.get(key);
    if (!pending) {
      pending = (async () => {
        try {
          const value = await client.getPublicSettings();
          this.cached.set(key, { at: Date.now(), value });
          return value;
        } finally {
          this.inflight.delete(key);
        }
      })();
      this.inflight.set(key, pending);
    }

    return pending;
  }

  async tryGet(origin?: string): Promise<PublicSettings | null> {
    try {
      return await this.get(origin);
    } catch (err) {
      log.warn(`failed to fetch panel settings: ${err}`);
      return null;
    }
  }
}
