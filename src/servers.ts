import * as vscode from 'vscode';
import type { PanelClient } from './api/client.ts';
import type { Server } from './api/types.ts';
import { decodeAuthority, type ServerRef, serverUri } from './fs/fileSystemProvider.ts';
import { log } from './log.ts';
import type { Session } from './session.ts';

export interface MountedServer {
  origin: string;
  uuid: string;
  name: string;
}

export function shortId(uuid: string): string {
  return uuid.slice(0, 8);
}

export async function pickServer(session: Session): Promise<{ origin: string; server: Server } | null> {
  const client = await pickPanel(session);
  if (!client) {
    return null;
  }

  const server = await searchServer(client);
  return server ? { origin: client.origin, server } : null;
}

async function pickPanel(session: Session): Promise<PanelClient | null> {
  const origins = await session.origins();

  if (origins.length <= 1) {
    return session.client(origins[0]);
  }

  const ADD = '$(add) Sign in to another panel...';
  const picked = await vscode.window.showQuickPick([...origins, ADD], {
    title: 'Calagopus: select a panel',
  });
  if (!picked) {
    return null;
  }
  return picked === ADD ? session.promptSignIn() : session.client(picked);
}

interface ServerPick extends vscode.QuickPickItem {
  server: Server;
}

function searchServer(client: PanelClient): Promise<Server | null> {
  return new Promise((resolve) => {
    const qp = vscode.window.createQuickPick<ServerPick>();
    qp.title = `Calagopus: select a server (${client.origin})`;
    qp.placeholder = 'Search servers by name...';
    qp.matchOnDescription = true;
    qp.matchOnDetail = true;

    let seq = 0;
    let debounce: NodeJS.Timeout | undefined;

    const load = async (search: string) => {
      const mine = ++seq;
      qp.busy = true;
      try {
        const servers = await client.listServers(search.trim() || undefined);
        if (mine !== seq) {
          return;
        }
        qp.items = servers.map((server) => ({
          label: server.name,
          description: server.uuid_short,
          detail: server.description ?? undefined,
          server,
        }));
      } catch (err) {
        if (mine === seq) {
          log.warn(`failed to list servers for ${client.origin}: ${err}`);
          qp.items = [];
        }
      } finally {
        if (mine === seq) {
          qp.busy = false;
        }
      }
    };

    qp.onDidChangeValue((value) => {
      if (debounce) {
        clearTimeout(debounce);
      }
      debounce = setTimeout(() => void load(value), 250);
    });
    qp.onDidAccept(() => {
      resolve(qp.selectedItems[0]?.server ?? null);
      qp.hide();
    });
    qp.onDidHide(() => {
      if (debounce) {
        clearTimeout(debounce);
      }
      qp.dispose();
      resolve(null);
    });

    void load('');
    qp.show();
  });
}

export function mountedServers(): MountedServer[] {
  return (vscode.workspace.workspaceFolders ?? [])
    .filter((folder) => folder.uri.scheme === 'calagopus')
    .map((folder) => {
      const { origin, server } = decodeAuthority(folder.uri.authority);
      return { origin, uuid: server, name: folder.name || shortId(server) };
    });
}

export async function pickMountedServer(session: Session): Promise<MountedServer | null> {
  const mounted = mountedServers();

  if (mounted.length === 0) {
    const picked = await pickServer(session);
    return picked ? { origin: picked.origin, uuid: picked.server.uuid, name: picked.server.name } : null;
  }

  if (mounted.length === 1) {
    return mounted[0];
  }

  const picked = await vscode.window.showQuickPick(
    mounted.map((server) => ({
      label: server.name,
      description: server.uuid,
      detail: server.origin,
      server,
    })),
    { title: 'Calagopus: select a mounted server', matchOnDescription: true, matchOnDetail: true },
  );
  return picked?.server ?? null;
}

export function isMounted(server: MountedServer): boolean {
  const uri = serverUri(server.origin, server.uuid);
  return (vscode.workspace.workspaceFolders ?? []).some((folder) => folder.uri.toString() === uri.toString());
}

export function mountWillReload(server: MountedServer): boolean {
  if (isMounted(server)) {
    return false;
  }
  return (vscode.workspace.workspaceFolders ?? []).length <= 1;
}

export async function openServerFolder(server: MountedServer): Promise<void> {
  const uri = serverUri(server.origin, server.uuid);
  const existing = vscode.workspace.workspaceFolders ?? [];

  if (isMounted(server)) {
    log.debug(`mount ${uri.toString()}: already a workspace folder`);
    return;
  }

  log.info(`mount ${uri.toString()}: adding "${server.name}" at index ${existing.length}`);
  const ok = vscode.workspace.updateWorkspaceFolders(existing.length, 0, {
    uri,
    name: server.name,
  });

  if (ok) {
    return;
  }

  if (existing.length === 0) {
    log.warn(`mount ${uri.toString()}: updateWorkspaceFolders refused; falling back to vscode.openFolder`);
    await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: false });
    return;
  }

  log.error(`mount ${uri.toString()}: updateWorkspaceFolders returned false`);
  vscode.window.showErrorMessage(
    `Calagopus: could not add ${server.name} to the workspace. Check the Calagopus output channel for details.`,
  );
}

export function workspaceServers(): ServerRef[] {
  return mountedServers().map((s) => ({ origin: s.origin, server: s.uuid }));
}
