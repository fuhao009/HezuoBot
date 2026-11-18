# Shared-workspace governance: bot visibility and admin activity

## Retired scope

The former portal-backed shared-workspace acceptance scenario and its service
trust fixture are retired. Historical local runs and screenshots do not qualify
a current hosted deployment. There is no active portal setup or hosted CLI
command in this recipe.

## Remaining local access-control coverage

Bot visibility and audit records remain separate local security concerns.
Current references are `desktop/server/bot-visibility.ts`,
`desktop/server/bot-visibility.test.ts`, `desktop/server/request-auth.test.ts`
and `desktop/server/admin-activity.test.ts`. These are not substitutes for the
removed hosted end-to-end scenario.

Retain these boundaries when reviewing local behavior:

- Hidden bots must not leak through direct reads, lists, search, attachments,
  rooms or live-stream replay. Denial must not reveal whether a hidden object
  exists. Members must not gain authority to change audience lists.
- Narrowing visibility must apply to existing streams and delegated work;
  stale sessions or a room containing a hidden bot must not bypass it.
- Audit records must identify the actor and redact secrets. Members must not
  gain admin-log access through read or download surfaces.
- Local CLI or loopback access is not proof of a hosted administrator's identity.

`desktop/server/workspace-access.ts` and
`desktop/server/workspace-access.test.ts` describe the current fail-closed
startup boundary: retired hosted environment settings are rejected, even if
an admin session already exists. Never remove that rejection to reproduce a
historical governance fixture.

## Not proven here

No current portal membership, licence revalidation, service trust or hosted
stream-revocation scenario is established by this guide. Use disposable homes
and synthetic identities for any future local fixture work; do not change
customer bot visibility or collect production audit data.

No checks were run for this documentation update.
