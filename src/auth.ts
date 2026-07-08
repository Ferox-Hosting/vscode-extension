import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as vscode from 'vscode';
import { log } from './log.ts';

// The panel endpoint that renders the consent screen and mints a key. This is the default used
// for plain in-editor sign-in; deep links may override it via the `create_path` parameter.
export const DEFAULT_CREATE_PATH = '/account/api/authorize';

const CREATE_KEY_NAME = 'VS Code';
const CREATE_KEY_ADMIN_PERMISSIONS = ['servers.read'];
const CREATE_KEY_USER_PERMISSIONS = ['servers.read'];
const CREATE_KEY_SERVER_PERMISSIONS = [
  'control.read-console',
  'control.console',
  'control.start',
  'control.stop',
  'control.restart',
  'files.create',
  'files.read',
  'files.read-content',
  'files.update',
  'files.write',
  'files.delete',
  'files.archive',
];

function callbackPage(message: string, autoClose = false): string {
  // Browsers only honour window.close() on tabs that were opened by script
  // (window.open). The OAuth callback tab is a normal top-level navigation, so
  // close() is silently ignored in most browsers. Attempt it anyway, and if the
  // tab is still around a moment later, swap in a message the user can act on.
  const script = autoClose
    ? `<script>
        window.close();
        setTimeout(() => {
          document.getElementById('msg').textContent = 'You can now close this tab and return to your editor.';
        }, 500);
      </script>`
    : '';
  return `<!doctype html><html><head><meta charset="utf-8"><title>Ferox</title></head><body style="font-family: system-ui, sans-serif; text-align: center; padding: 4rem;"><h2>Ferox</h2><p id="msg">${message}</p>${script}</body></html>`;
}

const CALLBACK_OK_PAGE = callbackPage('Signed in. Closing this tab…', true);
const CALLBACK_BAD_PAGE = callbackPage('No API key was provided. Please return to your editor and try again.');

export function normalizeFilePath(path: string): string {
  const trimmed = path.trim();
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

// Open the panel's consent screen in the browser and wait for it to hand an API key back to a
// short-lived loopback server. Resolves to the key (identifier + token), or null if the user
// cancelled, the round-trip timed out, or no key was delivered. A manual paste is offered as a
// fallback for the duration of the wait.
export async function authenticateViaBrowser(origin: string, createPath: string): Promise<string | null> {
  // A loopback HTTP server gives us a plain http(s) callback that works across editors
  // (VSCodium and other forks don't reliably register a custom URI scheme). asExternalUri
  // forwards the port when running in Remote/Codespaces; on plain desktop it is a no-op.
  const callback = await startCallbackServer();
  try {
    const external = await vscode.env.asExternalUri(vscode.Uri.parse(callback.url));

    const target = new URL(normalizeFilePath(createPath), origin);
    target.searchParams.set('name', CREATE_KEY_NAME);
    target.searchParams.set('admin_permissions', CREATE_KEY_ADMIN_PERMISSIONS.join(','));
    target.searchParams.set('user_permissions', CREATE_KEY_USER_PERMISSIONS.join(','));
    target.searchParams.set('server_permissions', CREATE_KEY_SERVER_PERMISSIONS.join(','));
    target.searchParams.set('callback_url', external.toString());

    log.info(`auth: redirecting to ${target.origin}${target.pathname} to create an API key`);
    await vscode.env.openExternal(vscode.Uri.parse(target.toString()));

    const key = await awaitKey(origin, callback.key);
    if (!key) {
      log.info(`auth: authentication for ${origin} was cancelled or timed out`);
      return null;
    }
    return key;
  } finally {
    callback.dispose();
  }
}

// Show a progress indicator while the browser round-trip happens, with a password input as a
// manual fallback in case the callback never arrives. Resolves to the first key we obtain.
async function awaitKey(origin: string, fromCallback: Promise<string | null>): Promise<string | null> {
  const tokenSource = new vscode.CancellationTokenSource();
  void fromCallback.then((key) => {
    if (key) {
      tokenSource.cancel(); // dismiss the manual prompt once the callback lands
    }
  });

  const manual = vscode.window.withProgress<string | undefined>(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Ferox: waiting for authentication from ${origin}…`,
      cancellable: true,
    },
    (_progress, progressToken) => {
      progressToken.onCancellationRequested(() => tokenSource.cancel());
      return Promise.resolve(
        vscode.window.showInputBox(
          {
            title: 'Ferox: finish signing in',
            prompt: 'Approve in your browser to finish automatically, or paste an API key here.',
            password: true,
            ignoreFocusOut: true,
          },
          tokenSource.token,
        ),
      );
    },
  );

  const key = await Promise.race([fromCallback, manual.then((value) => value ?? null)]);
  tokenSource.dispose();
  const trimmed = key?.trim();
  return trimmed ? trimmed : null;
}

function startCallbackServer(): Promise<{ url: string; key: Promise<string | null>; dispose: () => void }> {
  return new Promise((resolve, reject) => {
    let deliverKey!: (key: string | null) => void;
    const key = new Promise<string | null>((res) => {
      deliverKey = res;
    });

    const server = http.createServer((req, res) => {
      const received = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('key');
      res.writeHead(received ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(received ? CALLBACK_OK_PAGE : CALLBACK_BAD_PAGE);
      if (received) {
        deliverKey(received);
      }
    });

    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/`,
        key,
        dispose: () => {
          deliverKey(null);
          server.close();
        },
      });
    });
  });
}
