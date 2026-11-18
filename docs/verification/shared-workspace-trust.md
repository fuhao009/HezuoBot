# Shared-workspace trust: loopback, card answerers, decision log

## Retired scope

The portal-backed shared-workspace trust recipe is retired. Its service-trust,
hosted authorization and hosted-model API fixtures have been removed. The old
CLI pairing scenario and historical local results are not current acceptance
evidence. There is no supported hosted setup or executable portal route here.

## Current references and boundaries

- `desktop/server/workspace-access.ts` and
  `desktop/server/workspace-access.test.ts`: retired hosted settings must fail
  closed, not silently enable standalone local access. Empty settings and a
  pre-existing admin session do not relax this boundary.
- `desktop/server/request-auth.test.ts`: review the current request boundary.
  A loopback address or forged Origin must not be presented as proof of remote
  identity, portal membership, or permission to elevate a task.
- `desktop/server/card-answerers.e2e.test.ts`: remaining card-answerer coverage
  is separate from the deleted hosted authorization scenario. A card's presence
  is not a grant for an arbitrary caller to answer it.
- `desktop/server/decision-log-wiring.test.ts`: decision records are security
  evidence, not authorization. Keep secrets out of them and do not treat a
  historical log as proof that a current provider or deployment passed.
- `desktop/server/cli-pairing.ts`: surviving local pairing code is not a
  replacement for the removed hosted pairing acceptance fixture.

## Not proven here

This guide does not establish current hosted model access, portal entitlement
revalidation, service trust, production audit completeness or end-to-end
pairing coverage. Do not inject live credentials or weaken authorization to
reproduce old screenshots. Future fixture work must use disposable homes,
fake providers and synthetic identities.

No checks were run for this documentation update.
