import * as vscode from 'vscode';
import { authenticateViaBrowser, normalizeFilePath } from './auth.ts';
import type { PanelClient } from './api/client.ts';
import { serverUri } from './fs/fileSystemProvider.ts';
import { log } from './log.ts';
import { type MountedServer, mountWillReload, openServerFolder, shortId } from './servers.ts';
import type { Session } from './session.ts';

export const PENDING_CONSOLE_KEY = 'ferox.pendingConsole';
export const PENDING_EXPLORER_KEY = 'ferox.pendingExplorer';
export const PENDING_FILE_KEY = 'ferox.pendingFile';

function isTruthy(value: string | null): boolean {
  return value !== null && value !== '' && value !== '0' && value.toLowerCase() !== 'false';
}

export async function openFile(uri: vscode.Uri): Promise<void> {
  try {
    await vscode.commands.executeCommand('vscode.open', uri);
  } catch (err) {
    log.warn(`uri handler: could not open file ${uri.toString()}: ${err}`);
  }
}

export class FeroxUriHandler implements vscode.UriHandler {
  constructor(
    private readonly session: Session,
    private readonly globalState: vscode.Memento,
    private readonly openConsole: (server: MountedServer) => void,
  ) {}

  async handleUri(uri: vscode.Uri): Promise<void> {
    if (uri.path !== '/open') {
      return;
    }
    await this.handleOpen(uri, new URLSearchParams(uri.query));
  }

  private async handleOpen(uri: vscode.Uri, params: URLSearchParams): Promise<void> {
    const origin = params.get('origin');
    const server = params.get('server');
    const apiKey = params.get('apiKey');
    const createPath = params.get('create_path');
    const wantConsole = isTruthy(params.get('console'));
    const fileParam = params.get('file');

    if (!origin || !server) {
      log.error(`uri handler: malformed open link: ${uri.toString()}`);
      vscode.window.showErrorMessage('Ferox: malformed open link.');
      return;
    }

    log.info(
      `uri handler: open server ${server} from ${origin}${apiKey ? ' (key supplied)' : ''}${
        wantConsole ? ' (+console)' : ''
      }${fileParam ? ` (+file ${fileParam})` : ''}`,
    );

    const client = apiKey
      ? await this.session.ephemeralClient(origin, apiKey)
      : ((await this.session.clientIfSignedIn(origin)) ??
        (createPath
          ? await this.redirectToCreateKey(origin, createPath, params)
          : await this.session.promptSignIn(origin)));
    if (!client) {
      return;
    }

    await this.openServer(client, params);
  }

  private async openServer(client: PanelClient, params: URLSearchParams): Promise<void> {
    const server = params.get('server');
    if (!server) {
      return;
    }
    const wantConsole = isTruthy(params.get('console'));
    const fileParam = params.get('file');

    let name = shortId(server);
    try {
      name = (await client.getServer(server)).name || name;
    } catch (err) {
      log.warn(`uri handler: could not fetch name for server ${server}: ${err}`);
    }

    const target: MountedServer = { origin: client.origin, uuid: server, name };
    const fileUri = fileParam ? serverUri(target.origin, target.uuid, normalizeFilePath(fileParam)) : undefined;

    const willReload = mountWillReload(target);
    if (wantConsole) {
      await this.globalState.update(PENDING_CONSOLE_KEY, target);
    }
    if (fileUri) {
      await this.globalState.update(PENDING_FILE_KEY, fileUri.toString());
    }
    if (willReload) {
      await this.globalState.update(PENDING_EXPLORER_KEY, true);
    }

    await openServerFolder(target);

    if (willReload) {
      return;
    }

    await vscode.commands.executeCommand('workbench.view.explorer');
    if (fileUri) {
      await this.globalState.update(PENDING_FILE_KEY, undefined);
      await openFile(fileUri);
    }
    if (wantConsole) {
      await this.globalState.update(PENDING_CONSOLE_KEY, undefined);
      this.openConsole(target);
    }
  }

  private async redirectToCreateKey(
    origin: string,
    createPath: string,
    _params: URLSearchParams,
  ): Promise<PanelClient | null> {
    const key = await authenticateViaBrowser(origin, createPath);
    if (!key) {
      return null;
    }
    return this.session.signInWithKey(origin, key);
  }
}
