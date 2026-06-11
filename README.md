![Calagopus Logo](https://calagopus.com/fulllogo.png)

# Calagopus for VSCode

Browse and edit [Calagopus](https://calagopus.com) server files and access the server console directly from VS Code.

## Features

- Mount server files as a workspace folder over a virtual `calagopus://` filesystem.
- Edit, create, rename, and delete files and directories remotely with native VS Code tooling.
- Search across server files by name and content (when the proposed search APIs are enabled).
- Attach to the live server console as an integrated terminal, with full output streaming and command input.
- View server state in the status bar and trigger power actions (start, stop, restart, kill).
- Open servers and consoles via deep links using the `calagopus` URI handler.
- Secure, persistent sign-in backed by VS Code's secret storage.

## Commands

| Command | Description |
| --- | --- |
| `Calagopus: Sign In` | Authenticate with your Calagopus panel. |
| `Calagopus: Sign Out` | Clear stored credentials. |
| `Calagopus: Open Server Files` | Pick a server and mount its files as a workspace folder. |
| `Calagopus: Open Server Console` | Pick a server and attach to its console. |
| `Calagopus: Server Power Action` | Start, stop, restart, or kill the active server. |

## Deep links

The extension registers a `calagopus` URI handler. Open a server (mounting its files as a workspace folder) with:

```
vscode://calagopus.calagopus/open?origin=<panel-url>&server=<server-uuid>
```

| Param | Description |
| --- | --- |
| `origin` | Panel base URL, e.g. `https://panel.example.com`. Required. |
| `server` | Server UUID. Required. |
| `apiKey` | Optional API key for an ephemeral, non-persisted session. |
| `console` | When truthy (`1`/`true`), also attach to the server console. |
| `file` | Optional path (relative to the server root) to open in the editor after mounting. |

When the link opens into a fresh window, the file explorer is revealed automatically.

## Requirements

- VS Code `^1.120.0`
- A Calagopus account with access to one or more servers

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
