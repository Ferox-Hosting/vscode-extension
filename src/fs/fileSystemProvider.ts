import * as vscode from 'vscode';
import { ApiError } from '../api/client.ts';
import type { DirectoryEntry } from '../api/types.ts';
import { log } from '../log.ts';
import type { Session } from '../session.ts';

export interface ServerRef {
  origin: string;
  server: string;
}

// ferox://<hex(origin)>.<server-uuid>/<path...>
export function serverUri(origin: string, server: string, path = '/'): vscode.Uri {
  const authority = `${encodeOrigin(origin)}.${server.toLowerCase()}`;
  return vscode.Uri.from({ scheme: 'ferox', authority, path });
}

export function refOf(uri: vscode.Uri): ServerRef {
  return decodeAuthority(uri.authority);
}

function encodeOrigin(origin: string): string {
  return Buffer.from(new URL(origin).origin, 'utf8').toString('hex');
}

export function decodeAuthority(authority: string): ServerRef {
  const dot = authority.indexOf('.');
  if (dot < 0) {
    return { origin: '', server: authority };
  }
  let origin = '';
  try {
    origin = Buffer.from(authority.slice(0, dot), 'hex').toString('utf8');
  } catch {
    origin = '';
  }
  return { origin, server: authority.slice(dot + 1) };
}

const CACHE_TTL_MS = 2_500;

interface CachedListing {
  at: number;
  entries: DirectoryEntry[];
}

function parentOf(path: string): { parent: string; name: string } {
  const trimmed = path.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return {
    parent: idx <= 0 ? '/' : trimmed.slice(0, idx),
    name: trimmed.slice(idx + 1),
  };
}

function toFileType(entry: DirectoryEntry): vscode.FileType {
  let type = entry.directory ? vscode.FileType.Directory : vscode.FileType.File;
  if (entry.symlink) {
    type |= vscode.FileType.SymbolicLink;
  }
  return type;
}

function translateError(err: unknown, uri: vscode.Uri): Error {
  if (err instanceof ApiError) {
    switch (err.status) {
      case 404:
        return vscode.FileSystemError.FileNotFound(uri);
      case 401:
      case 403:
        return vscode.FileSystemError.NoPermissions(uri);
      case 413:
        return vscode.FileSystemError.Unavailable(`${uri.path}: file exceeds the panel's maximum viewable size`);
    }
  }
  return err instanceof Error ? err : new Error(String(err));
}

export class FeroxFileSystem implements vscode.FileSystemProvider {
  private readonly cache = new Map<string, CachedListing>();

  private readonly didChangeEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.didChangeEmitter.event;

  constructor(private readonly session: Session) {}

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => null);
  }

  private cacheKey(ref: ServerRef, directory: string): string {
    return `${ref.origin}\0${ref.server}\0${directory}`;
  }

  private async listCached(ref: ServerRef, directory: string): Promise<DirectoryEntry[]> {
    const key = this.cacheKey(ref, directory);
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      return hit.entries;
    }

    log.trace(`fs list ${key}`);
    const client = await this.session.client(ref.origin);
    const entries = await client.listDirectory(ref.server, directory);
    this.cache.set(key, { at: Date.now(), entries });
    return entries;
  }

  private invalidate(ref: ServerRef, directory: string) {
    this.cache.delete(this.cacheKey(ref, directory));
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    if (uri.path === '/' || uri.path === '') {
      return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
    }

    const { parent, name } = parentOf(uri.path);
    try {
      const entries = await this.listCached(refOf(uri), parent);
      const entry = entries.find((e) => e.name === name);
      if (!entry) {
        throw vscode.FileSystemError.FileNotFound(uri);
      }

      const mtime = entry.modified ? Date.parse(entry.modified) || 0 : 0;
      return {
        type: toFileType(entry),
        // The legacy daemon does not report a creation time separately, so we
        // fall back to the modification time for ctime.
        ctime: mtime,
        mtime,
        size: entry.size,
      };
    } catch (err) {
      throw translateError(err, uri);
    }
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    try {
      const entries = await this.listCached(refOf(uri), uri.path || '/');
      return entries.map((entry) => [entry.name, toFileType(entry)]);
    } catch (err) {
      throw translateError(err, uri);
    }
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    log.trace(`fs read ${uri.toString()}`);

    const { origin, server } = refOf(uri);
    try {
      const client = await this.session.client(origin);
      return await client.readFile(server, uri.path);
    } catch (err) {
      log.error(`fs read ${uri.toString()} failed: ${err}`);
      throw translateError(err, uri);
    }
  }

  async writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    options: { create: boolean; overwrite: boolean },
  ): Promise<void> {
    const ref = refOf(uri);
    const { parent, name } = parentOf(uri.path);

    let exists = false;
    try {
      const entries = await this.listCached(ref, parent);
      exists = entries.some((e) => e.name === name);
    } catch {
      // parent unknown
    }

    if (exists && !options.overwrite) {
      throw vscode.FileSystemError.FileExists(uri);
    }
    if (!exists && !options.create) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }

    try {
      const client = await this.session.client(ref.origin);
      await client.writeFile(ref.server, uri.path, content);
    } catch (err) {
      log.error(`fs write ${uri.toString()} failed: ${err}`);
      throw translateError(err, uri);
    }

    this.invalidate(ref, parent);
    this.didChangeEmitter.fire([
      {
        type: exists ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created,
        uri,
      },
    ]);
  }

  async createDirectory(uri: vscode.Uri): Promise<void> {
    const ref = refOf(uri);
    const { parent, name } = parentOf(uri.path);
    try {
      const client = await this.session.client(ref.origin);
      await client.createDirectory(ref.server, parent, name);
    } catch (err) {
      throw translateError(err, uri);
    }

    this.invalidate(ref, parent);
    this.didChangeEmitter.fire([{ type: vscode.FileChangeType.Created, uri }]);
  }

  async delete(uri: vscode.Uri): Promise<void> {
    const ref = refOf(uri);
    const { parent } = parentOf(uri.path);
    try {
      const client = await this.session.client(ref.origin);
      await client.delete(ref.server, [uri.path]);
    } catch (err) {
      throw translateError(err, uri);
    }

    this.invalidate(ref, parent);
    this.invalidate(ref, uri.path);
    this.didChangeEmitter.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
  }

  async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): Promise<void> {
    const oldRef = refOf(oldUri);
    const newRef = refOf(newUri);
    if (oldUri.authority !== newUri.authority) {
      throw vscode.FileSystemError.Unavailable('Cannot rename across servers.');
    }

    if (!options.overwrite) {
      const { parent, name } = parentOf(newUri.path);
      try {
        const entries = await this.listCached(newRef, parent);
        if (entries.some((e) => e.name === name)) {
          throw vscode.FileSystemError.FileExists(newUri);
        }
      } catch (err) {
        if (err instanceof vscode.FileSystemError && err.code === 'FileExists') {
          throw err;
        }
      }
    }

    try {
      const client = await this.session.client(oldRef.origin);
      await client.rename(oldRef.server, oldUri.path, newUri.path);
    } catch (err) {
      throw translateError(err, oldUri);
    }

    this.invalidate(oldRef, parentOf(oldUri.path).parent);
    this.invalidate(newRef, parentOf(newUri.path).parent);
    this.didChangeEmitter.fire([
      { type: vscode.FileChangeType.Deleted, uri: oldUri },
      { type: vscode.FileChangeType.Created, uri: newUri },
    ]);
  }

  // Copy is intentionally not implemented for Phase 1. Without a copy method,
  // VS Code emulates copy operations via read + write, which is sufficient for
  // same-server copies against the legacy daemon. A native copy endpoint can be
  // added later (see VSCODE_EXTENSION_PLAN.md Phase 4).
}
