# Hosted workspace sign-in and revocation

## Retired scope

The upstream hosted identity exchange, hosted login start/callback routes,
enterprise readiness and public tenant fleet are retired. Their dedicated
hosted-access, email-sign-in, enterprise and fleet tests are removed. There is
no current hosted-login or revocation acceptance recipe and no equivalent
replacement is claimed. Gateway product accounts and desktop pairing are
separate contracts, not a restoration of the portal tenant service.

The existing `desktop/server/workspace-access.ts` and
`desktop/server/workspace-access.test.ts` cover current workspace access; they
are not evidence of the retired enterprise registration or hosted exchange.

## Preserved safety boundaries

Historical verification used isolated portal/license fixtures, temporary homes,
throwaway credentials and fake services. It did not prove a hosted deployment,
real tenant provisioning or production identity availability. Do not seed a
fixture with a real account, provider master key or customer data.

Authorization must fail closed: invalid/revoked credentials must not become the
local owner because the request is loopback. A user ID prefix or pairing token
alone must not bypass membership checks. Ordinary reachability is not proof of
identity support, entitlement or authorization readiness.

Any future identity protocol must reject unsupported versions without spending
one-use codes, avoid downgrade retries and remote-error leakage, and revalidate
sessions and active streams after revocation. Backchannels must use the exact
configured HTTPS origin, omit browser cookies, reject redirects and have a
bounded deadline. Capability metadata must come from the actual runtime, not a
wrapper manufacturing support. Credentials must remain scoped to the workspace;
never distribute the portal's master provider key. These remain security
requirements, not claims that the retired hosted protocol is registered.
