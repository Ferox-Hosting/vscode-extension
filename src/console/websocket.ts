import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { WebsocketCredentials } from '../api/types.ts';
import { log } from '../log.ts';
import type { Session } from '../session.ts';

export class ConsoleSocket extends EventEmitter {
  private socket: WebSocket | null = null;
  private closed = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;

  private readonly minBackoffMs = 1_000;
  private readonly maxBackoffMs = 20_000;

  constructor(
    private readonly session: Session,
    private readonly origin: string,
    private readonly server: string,
  ) {
    super();
  }

  async connect(): Promise<void> {
    this.closed = false;
    await this.createSocket();
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close(1000, 'client closing');
    this.socket = null;
  }

  send(event: string, args: string[] = []): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ event, args }));
    }
  }

  sendCommand(command: string): void {
    this.send('send command', [command]);
  }

  private async createSocket(): Promise<void> {
    let credentials: WebsocketCredentials;
    try {
      const client = await this.session.client(this.origin);
      credentials = await client.getWebsocketCredentials(this.server);
    } catch (err) {
      this.emit('CONNECTION_ERROR', err instanceof Error ? err : new Error(String(err)));
      this.scheduleReconnect();
      return;
    }

    this.emit('CONNECTION_STATE', this.reconnectAttempts === 0 ? 'connecting' : 'reconnecting');

    const socket = new WebSocket(credentials.url, {
      origin: new URL(credentials.url).origin,
    });
    this.socket = socket;

    socket.on('open', () => {
      log.debug(`ws [${this.server}] connected`);
      this.reconnectAttempts = 0;
      this.emit('CONNECTION_STATE', 'connected');
      socket.send(JSON.stringify({ event: 'auth', args: [credentials.token] }));
    });

    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        return;
      }

      let event: string;
      let args: string[];
      try {
        ({ event, args } = JSON.parse(data.toString()) as { event: string; args: string[] });
      } catch {
        return;
      }

      switch (event) {
        case 'token expiring':
        case 'token expired':
          void this.refreshToken();
          break;
        case 'jwt error':
          this.emit('CONNECTION_ERROR', new Error(`JWT error from daemon: ${args?.[0]}`));
          break;
      }

      this.emit(event, ...(args ?? []));
    });

    socket.on('close', (code, reason) => {
      log.debug(`ws [${this.server}] closed: ${code} ${reason}`);
      if (this.socket === socket) {
        this.socket = null;
      }
      if (this.closed) {
        return;
      }

      this.emit('CONNECTION_STATE', 'disconnected');
      if (reason.toString() === 'permission revoked') {
        this.emit('CONNECTION_ERROR', new Error('Websocket permission revoked.'));
        this.closed = true;
        return;
      }

      this.scheduleReconnect();
    });

    socket.on('error', (err) => {
      this.emit('CONNECTION_ERROR', err);
    });
  }

  private async refreshToken(): Promise<void> {
    try {
      const client = await this.session.client(this.origin);
      const credentials = await client.getWebsocketCredentials(this.server);
      this.send('auth', [credentials.token]);
    } catch (err) {
      this.emit('CONNECTION_ERROR', err instanceof Error ? err : new Error(String(err)));
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) {
      return;
    }

    const delay = Math.min(this.minBackoffMs * 2 ** this.reconnectAttempts, this.maxBackoffMs);
    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.createSocket();
    }, delay);
  }
}
