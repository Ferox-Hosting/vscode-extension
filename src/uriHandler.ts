import * as vscode from 'vscode';
import type { PanelClient } from './api/client.ts';
import { authenticateViaBrowser, DEFAULT_CREATE_PATH, normalizeFilePath } from './auth.ts';
import { serverUri } from './fs/fileSystemProvider.ts';
import { log } from './log.ts';
import { type MountedServer, mountWillReload, openServerFolder, shortId } from './servers.ts';
import { DEFAULT_PANEL_ORIGIN, type Session } from './session.ts';

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
    try {
      await this.handleOpen(uri, new URLSearchParams(uri.query));
    } catch (err) {
      // Without this the handler dies silently and the link just appears to do nothing.
      log.error(`uri handler: failed to open ${uri.toString()}: ${err}`);
      vscode.window.showErrorMessage(`Ferox: could not open that link: ${err}`);
    }
  }

  private async handleOpen(uri: vscode.Uri, params: URLSearchParams): Promise<void> {
    const origin = DEFAULT_PANEL_ORIGIN;
    const server = params.get('server');
    const apiKey = params.get('apiKey');
    const createPath = params.get('create_path');
    const wantConsole = isTruthy(params.get('console'));
    const fileParam = params.get('file');

    if (!server) {
      log.error(`uri handler: malformed open link: ${uri.toString()}`);
      vscode.window.showErrorMessage('Ferox: malformed open link.');
      return;
    }

    log.info(
      `uri handler: open server ${server} from ${origin}${apiKey ? ' (key supplied)' : ''}${
        wantConsole ? ' (+console)' : ''
      }${fileParam ? ` (+file ${fileParam})` : ''}`,
    );

    // The origin is fixed for these links, so never ask which panel to use — go straight to
    // browser approval for the panel the link already implies.
    const client = apiKey
      ? await this.session.ephemeralClient(origin, apiKey)
      : ((await this.session.clientIfSignedIn(origin)) ??
        (await this.redirectToCreateKey(origin, createPath ?? DEFAULT_CREATE_PATH, params)));
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

    // The link may carry either the short identifier or the full UUID. Mounts are keyed by full
    // UUID, so normalize via the fetch below — otherwise the folder we add never matches the one
    // the server list mounts, and the server appears to open into a second, empty copy.
    let name = shortId(server);
    let uuid = server;
    try {
      const fetched = await client.getServer(server);
      name = fetched.name || name;
      uuid = fetched.uuid || uuid;
      if (fetched.suspended) {
        log.info(`uri handler: refusing to open suspended server ${server}`);
        vscode.window.showWarningMessage(`Ferox: "${name}" is suspended and cannot be opened.`);
        return;
      }
    } catch (err) {
      log.warn(`uri handler: could not fetch name for server ${server}: ${err}`);
    }

    const target: MountedServer = { origin: client.origin, uuid, name };
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
