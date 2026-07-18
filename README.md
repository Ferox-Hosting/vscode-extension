<p align="center">
  <img src="icon.png" alt="Ferox Hosting Logo" width="128" height="128">
</p>

# Ferox Hosting for VSCode

Browse and edit [Ferox Hosting](https://feroxhosting.nl) server files and access the server console directly from VS Code.

## Features

- Mount server files as a workspace folder over a virtual `ferox://` filesystem.
- Edit, create, rename, and delete files and directories remotely with native VS Code tooling.
- Attach to the live server console as an integrated terminal, with full output streaming and command input.
- View server state in the status bar and trigger power actions (start, stop, restart, kill).
- Open servers and consoles via deep links using the `ferox` URI handler.
- Secure, persistent sign-in backed by VS Code's secret storage.

## Commands

| Command | Description |
| --- | --- |
| `Ferox: Sign In` | Authenticate with your Ferox Hosting panel. |
| `Ferox: Sign Out` | Clear stored credentials. |
| `Ferox: Open Server Files` | Pick a server and mount its files as a workspace folder. |
| `Ferox: Open Server Console` | Pick a server and attach to its console. |
| `Ferox: Server Power Action` | Start, stop, restart, or kill the active server. |

## Deep links

The extension registers a `ferox` URI handler. Open a server (mounting its files as a workspace folder) with:

```
vscode://FeroxHosting.ferox/open?server=<server-uuid>
```

Deep links always target `https://panel.ferox.host`.

| Param | Description |
| --- | --- |
| `server` | Server UUID. Required. |
| `apiKey` | Optional API key for an ephemeral, non-persisted session. |
| `console` | When truthy (`1`/`true`), also attach to the server console. |
| `file` | Optional path (relative to the server root) to open in the editor after mounting. |

When the link opens into a fresh window, the file explorer is revealed automatically.

## Requirements

- VS Code `^1.120.0`
- A Ferox Hosting account with access to one or more servers

## Building

```bash
pnpm install
pnpm compile
```

To produce an installable `.vsix` and install it locally:

```bash
pnpm package
pnpm code:install
```

## Credits

This extension is a fork of [Calagopus for VSCode](https://github.com/calagopus/vscode-extension), originally created by the Calagopus authors ([Calagopus](https://github.com/calagopus) and [0x7d8](https://github.com/0x7d8)). Huge thanks to them for the original work, which is licensed under the MIT License. See [LICENSE](LICENSE) for details.
