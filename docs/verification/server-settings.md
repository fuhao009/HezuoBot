# Server provider sign-in and custom domain

Use an isolated fixture only. Never change the running user's provider account,
domain, or configuration to verify these controls.

## Automated checks

```sh
pnpm exec vitest run desktop/server/provider-auth-sessions.test.ts desktop/server/drivers/codex-device-auth.test.ts desktop/server/drivers/acp/grok-device-auth.test.ts desktop/server/grok-sign-in-api.test.ts desktop/server/request-auth.test.ts desktop/server/config.test.ts desktop/src/components/DeviceSignIn.test.ts desktop/src/components/EngineSetup.test.ts desktop/src/components/EnginesSettings.test.ts
pnpm typecheck
pnpm build
pnpm build:server
node scripts/smoke-packaged-server.mjs
```

The custom-domain helper and UI fixtures and their settings route are retired.
Their former DNS, HTTPS and one-time-proof checks are historical only; the
retained provider checks do not replace them or prove public DNS/TLS setup.

## Real Settings UI with an offline provider

1. Follow the [fixture launcher](README.md#launch), retaining its printed URL,
   temporary data directory and persistent log path. Run Doctor against that
   explicit URL.
2. Start Vite on a separate free port with `HEZUO_PORT` set to the printed harness
   port. Do not let it proxy to the default port or the user's live app.
3. Custom-domain setup is retired. The former domain form, synthetic DNS/IP
   response interception, copy controls and HTTPS validation are not current
   executable steps. Never point DNS at a synthetic fixture address or change
   the user's live domain to reproduce historical evidence.
   driver `codex`, CLI set to the absolute path of
   `desktop/server/testing/fake-codex-login-cli.ts`, environment
   `HEZUO_DEVICE_AUTH_FIXTURE=1`, `HOME` set to the fixture's temporary directory,
   and `CODEX_HOME` set to its `.codex` subdirectory. Reload that isolated
   provider registry and refresh the preview. Never substitute the real Codex
   executable. The fixture requires an explicit opt-in and makes no network
   requests.
5. Settings → Engines → Connect ChatGPT should display `TEST-12345`, the
   official link, expiry, and Cancel. **Do not enter the fake code at OpenAI.**
   Cancel and restart, then switch Settings sections and return; Connect should
   recover the same active flow without spawning a second login.
6. Create the empty `.hezuo-fake-codex-login-approved` marker in the fixture's
   temporary HOME. The offline process records a fake signed-in state. Confirm
   the real Settings UI changes to “ChatGPT connected on this server.”
7. Stop the Vite process and interrupt the foreground fixture launcher. Only
   its owned child and disposable data are removed; retain the printed log.

For deployment acceptance, separately test an actual public domain and an
owner-initiated real provider sign-in. A green offline run must not be reported
as a real OpenAI account login or proof of public DNS/TLS reachability.
