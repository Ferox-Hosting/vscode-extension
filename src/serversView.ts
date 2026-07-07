import * as vscode from 'vscode';
import type { Server } from './api/types.ts';
import { log } from './log.ts';
import type { Session } from './session.ts';

// A signed-in panel; only shown as a grouping node when more than one panel is
// connected. With a single panel we flatten straight to its servers.
interface PanelNode {
  kind: 'panel';
  origin: string;
}

// A single server row. Carries everything the interaction commands need.
export interface ServerNode {
  kind: 'server';
  origin: string;
  server: Server;
}

type Node = PanelNode | ServerNode;

export class ServersViewProvider implements vscode.TreeDataProvider<Node> {
  private readonly didChange = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.didChange.event;

  // Servers per panel origin, so expanding/collapsing does not refetch. Cleared
  // on refresh() and whenever the session changes.
  private readonly cache = new Map<string, Server[]>();

  constructor(private readonly session: Session) {}

  refresh(): void {
    this.cache.clear();
    this.didChange.fire(undefined);
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'panel') {
      const item = new vscode.TreeItem(new URL(node.origin).host, vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = new vscode.ThemeIcon('server');
      item.tooltip = node.origin;
      item.contextValue = 'feroxPanel';
      return item;
    }

    const item = new vscode.TreeItem(node.server.name, vscode.TreeItemCollapsibleState.None);
    item.description = node.server.uuid_short;
    item.tooltip = node.server.description ?? node.server.name;
    item.iconPath = new vscode.ThemeIcon('server-environment');
    item.contextValue = 'feroxServer';
    // Clicking the row opens (mounts) the server's files — the common action.
    item.command = {
      command: 'ferox.serverOpenFiles',
      title: 'Open Files',
      arguments: [node],
    };
    return item;
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (!node) {
      const origins = await this.session.origins();
      if (origins.length === 0) {
        return [];
      }
      if (origins.length === 1) {
        return this.serversFor(origins[0]);
      }
      return origins.map((origin) => ({ kind: 'panel', origin }));
    }

    return node.kind === 'panel' ? this.serversFor(node.origin) : [];
  }

  private async serversFor(origin: string): Promise<Node[]> {
    const cached = this.cache.get(origin);
    const servers = cached ?? (await this.loadServers(origin));
    return servers.map((server) => ({ kind: 'server', origin, server }));
  }

  private async loadServers(origin: string): Promise<Server[]> {
    try {
      const client = await this.session.clientIfSignedIn(origin);
      if (!client) {
        return [];
      }
      const servers = await client.listServers();
      this.cache.set(origin, servers);
      return servers;
    } catch (err) {
      log.warn(`servers view: failed to list servers for ${origin}: ${err}`);
      vscode.window.showErrorMessage(`Ferox: could not list servers for ${origin} (${err}).`);
      return [];
    }
  }
}
