import * as vscode from 'vscode';
import { createConsoleTerminal } from './console/pseudoterminal.ts';
import { FeroxFileSystem } from './fs/fileSystemProvider.ts';
import { log } from './log.ts';
import {
  type MountedServer,
  mountedServers,
  mountWillReload,
  openServerFolder,
  pickServer,
  workspaceServers,
} from './servers.ts';
import { type ServerNode, ServersViewProvider } from './serversView.ts';
import { DEFAULT_PANEL_ORIGIN, Session } from './session.ts';
import { SettingsCache } from './settings.ts';
import { ServerStatusBar } from './statusBar.ts';
import {
  FeroxUriHandler,
  openFile,
  PENDING_CONSOLE_KEY,
  PENDING_EXPLORER_KEY,
  PENDING_FILE_KEY,
} from './uriHandler.ts';

export function activate(context: vscode.ExtensionContext): void {
  log.info(
    `activating (workspace folders: ${
      (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.toString()).join(', ') || 'none'
    })`,
  );

  const session = new Session(context.secrets);
  const settings = new SettingsCache(session);
  const statusBar = new ServerStatusBar(session);
  const serversView = new ServersViewProvider(session);

  // Resolve the server a view command should act on. Invoked from the tree it
  // arrives as a ServerNode; invoked from the palette/title it is undefined, so
  // fall back to the quick-pick.
  const resolveServer = async (node?: ServerNode): Promise<MountedServer | null> => {
    if (node) {
      return { origin: node.origin, uuid: node.server.uuid, name: node.server.name };
    }
    const picked = await pickServer(session);
    return picked ? { origin: picked.origin, uuid: picked.server.uuid, name: picked.server.name } : null;
  };

  const openConsoleFor = (server: MountedServer): vscode.Terminal => {
    const { terminal } = createConsoleTerminal(session, settings, server.origin, server.uuid, server.name);
    statusBar.pin(server.origin, server.uuid, server.name);
    terminal.show();
    return terminal;
  };

  context.subscriptions.push(
    log,
    statusBar,

    vscode.workspace.registerFileSystemProvider('ferox', new FeroxFileSystem(session), {
      isCaseSensitive: true,
    }),

    vscode.window.registerUriHandler(new FeroxUriHandler(session, context.globalState, openConsoleFor)),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('ferox.signIn', () => session.signIn(DEFAULT_PANEL_ORIGIN)),

    vscode.commands.registerCommand('ferox.signInOther', () => session.promptSignIn()),

    vscode.commands.registerCommand('ferox.signOut', async () => {
      const origins = await session.origins();
      if (origins.length === 0) {
        vscode.window.showInformationMessage('Ferox: not signed in.');
        return;
      }

      const ALL = 'All panels';
      const picked =
        origins.length === 1
          ? origins[0]
          : await vscode.window.showQuickPick([...origins, ALL], {
              title: 'Ferox: sign out of which panel?',
            });
      if (!picked) {
        return;
      }

      await session.signOut(picked === ALL ? undefined : picked);
      vscode.window.showInformationMessage(
        picked === ALL ? 'Ferox: signed out of all panels.' : `Ferox: signed out of ${picked}.`,
      );
    }),

    vscode.commands.registerCommand('ferox.openServer', async () => {
      const picked = await pickServer(session);
      if (picked) {
        const server = { origin: picked.origin, uuid: picked.server.uuid, name: picked.server.name };
        statusBar.pin(server.origin, server.uuid, server.name);
        await openServerFolder(server);
      }
    }),

    vscode.commands.registerCommand('ferox.powerAction', () => statusBar.showPowerActions()),
  );

  context.subscriptions.push(
    vscode.window.createTreeView('ferox.servers', { treeDataProvider: serversView }),

    vscode.commands.registerCommand('ferox.refreshServers', () => serversView.refresh()),

    vscode.commands.registerCommand('ferox.serverOpenFiles', async (node?: ServerNode) => {
      const server = await resolveServer(node);
      if (!server) {
        return;
      }
      statusBar.pin(server.origin, server.uuid, server.name);
      // Mounting a fresh server as the first workspace folder reloads the window;
      // stash the intent so the explorer is revealed once we come back up.
      const willReload = mountWillReload(server);
      if (willReload) {
        await context.globalState.update(PENDING_EXPLORER_KEY, true);
      }
      await openServerFolder(server);
      if (!willReload) {
        await vscode.commands.executeCommand('workbench.view.explorer');
      }
    }),

    vscode.commands.registerCommand('ferox.serverPower', async (node?: ServerNode) => {
      const server = await resolveServer(node);
      if (!server) {
        return;
      }
      statusBar.pin(server.origin, server.uuid, server.name);
      await statusBar.showPowerActions();
    }),
  );

  // Drive the view's welcome/actions off sign-in state, and repopulate the
  // server list whenever the session changes (sign in/out, key refresh).
  const syncSignedIn = async () => {
    const origins = await session.origins();
    await vscode.commands.executeCommand('setContext', 'ferox.signedIn', origins.length > 0);
  };
  context.subscriptions.push(
    session.onDidChange(() => {
      void syncSignedIn();
      serversView.refresh();
    }),
  );
  void syncSignedIn();

  const restored = workspaceServers()[0];
  if (restored) {
    log.info(`restored ferox workspace for server ${restored.server} on ${restored.origin}`);
  }

  void (async () => {
    await resumePendingExplorer(context);
    await resumePendingFile(context);
    await resumePendingConsole(context, openConsoleFor);
  })();

  log.info('activated');
}

async function resumePendingExplorer(context: vscode.ExtensionContext): Promise<void> {
  if (!context.globalState.get<boolean>(PENDING_EXPLORER_KEY)) {
    return;
  }
  await context.globalState.update(PENDING_EXPLORER_KEY, undefined);
  log.info('revealing explorer for freshly opened workspace');
  await vscode.commands.executeCommand('workbench.view.explorer');
}

async function resumePendingFile(context: vscode.ExtensionContext): Promise<void> {
  const stored = context.globalState.get<string>(PENDING_FILE_KEY);
  if (!stored) {
    return;
  }
  await context.globalState.update(PENDING_FILE_KEY, undefined);

  const uri = vscode.Uri.parse(stored);
  const mounted = (vscode.workspace.workspaceFolders ?? []).some(
    (folder) => folder.uri.scheme === 'ferox' && folder.uri.authority === uri.authority,
  );
  if (!mounted) {
    log.warn(`pending file ${stored}: owning server is not mounted; skipping`);
    return;
  }

  log.info(`opening pending file ${stored}`);
  await openFile(uri);
}

async function resumePendingConsole(
  context: vscode.ExtensionContext,
  openConsoleFor: (server: MountedServer) => void,
): Promise<void> {
  const pending = context.globalState.get<MountedServer>(PENDING_CONSOLE_KEY);
  if (!pending) {
    return;
  }

  const isMounted = mountedServers().some(
    (s) => s.origin === pending.origin && s.uuid.toLowerCase() === pending.uuid.toLowerCase(),
  );
  if (!isMounted) {
    return;
  }

  await context.globalState.update(PENDING_CONSOLE_KEY, undefined);
  log.info(`resuming console for ${pending.uuid} on ${pending.origin}`);
  openConsoleFor(pending);
}

export function deactivate(): void {
  log.info('deactivated');
}
