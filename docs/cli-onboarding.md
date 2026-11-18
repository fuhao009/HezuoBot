# Terminal setup

Install [Node.js](https://nodejs.org/) 24 or newer, then choose either way to run Hezuo:

```sh
# Install once, then use the short command:
npm install -g hezuo
hezuo
```

Or, without a global install:

```sh
npx hezuo
```

Use the same command next time. The first launch guides you through setup; later launches reuse your saved AI connection and access configuration. `hezuo start` is the same as the bare command. If that workspace is already running, Hezuo opens it instead of starting a second server.

## First launch

The setup wizard uses Clack. Use ↑/↓ and Enter to select an option. Plain terminals show numbered choices instead.

1. Choose ChatGPT/Codex, Claude Code, or an API service. Existing supported connections are also listed.
2. Sign in with the provider, or paste an API key into the hidden prompt. Setup asks before installing a missing Codex or Claude CLI. Codex also offers device-code sign-in for a remote terminal. API choices include OpenAI, OpenRouter, Groq, and other OpenAI-compatible endpoints.
3. Choose a model and save. An API connection asks permission to send a short test message, which the provider may charge for. Native CLI setup confirms sign-in; it does not test the chosen model with a message. Model access is checked when you send one.
4. If the runtime still offers a phone setup step, choose **Skip for now**. This legacy prompt is outside the supported setup path; your AI setup is already saved.

The workspace then starts and opens its local address in a browser on this computer. On SSH or a computer without a graphical desktop, open the printed address using an appropriate connection instead. Automatic browser opening only uses the local address; `--no-open` disables it.

Keep the terminal open while using your bots. This runs a foreground server, not an installed background service. Ctrl-C stops the server without deleting saved work; closing the browser alone does not stop it. Bots keep working only while the computer and server are running.

Codex and Claude Code support agent tools. API-key connections currently support chat only. A ChatGPT or Claude subscription does not include separately billed API usage. Changing the saved default affects **new bots only**; existing bots and conversations keep their settings.

## Remote access scope

Native mobile setup is not part of the documented desktop/gateway product.
For the retained account-authenticated relay and certificate requirements,
see [local gateway operation](local-gateway.md#remote-companion-relay) and the
[device and relay API](gateway-client-devices.md). Legacy pairing commands or
prompts described below are runtime remnants, not a supported mobile setup path.

## Commands

The examples below assume a global install; prefix them with `npx` otherwise.

| Command | Use |
| --- | --- |
| `hezuo` | Set up once, then start with saved settings. |
| `hezuo setup` | Revisit AI setup and any retained legacy access prompts, save, and exit without starting. This is not a reset. |
| `hezuo --no-open` | Start without opening a browser. |
| `hezuo --local` | Ignore saved remote access for this launch; keep the saved choice for next time. |
| `hezuo --no-pair` | Suppress legacy phone setup prompts and pairing invitations. This does **not** turn off saved remote access; use `--local` for that. |
| `hezuo pair` | Legacy pairing invitation command; not a supported mobile installation path. |
| `hezuo sessions` | List paired devices; `hezuo sessions revoke ID` signs one out. |
| `hezuo serve` | Start without onboarding prompts or automatic browser opening; specify remote-access flags explicitly for a service. |
| `hezuo login` | Sign in to an Hezuo account for `--tunnel`; this does not sign in to an AI provider or start the tunnel. |

`start` accepts the same server options as `serve`, including `--port`, `--data-dir`, `--tailscale`, `--tunnel`, and `--public-url`. Keep using your custom data directory and port when starting or pairing:

```sh
hezuo setup --data-dir /path/to/hezuo-data --port 8799
hezuo --data-dir /path/to/hezuo-data --port 8799
```

Setup needs an interactive terminal. Later starts can run without one once setup is complete. Stop a running server before changing its setup or access mode: `--local` does not turn off a remote connection belonging to a server that is already running. You do not need to delete configuration, bots, or conversations to reconfigure it.

## Credentials and cancellation

API keys are hidden while typed or pasted. New API connections save their key in the data directory's `config.json` as **plaintext, not encrypted**, with owner-only permissions (`0600`) on Unix. Managed-access account credentials in `tunnel-account.json` are also plaintext with `0600` permissions on Unix. Keep these files and backups private. Native provider sign-in credentials are managed by the provider's own CLI.

Ctrl-C during AI setup leaves unsaved HezuoBot changes unapplied. Installations and provider sign-ins already completed remain available. Ctrl-C during a retained legacy pairing step keeps the AI setup you already saved, exits without starting a server, and does not undo an account sign-in already completed. Run `hezuo setup` to continue; no destructive reset is needed.

The former self-hosting and VPS deployment guides have been retired. They are not current setup instructions. For the separate account gateway, see [local gateway operation](local-gateway.md) and the [historical gateway 193 deployment record](gateway-deployment-193.md); neither documents a replacement remote bot-server mode.
