# Optional personal HezuoBot Cloud account

## Retired scope

The upstream personal Cloud account, device-approval endpoints, entitlement UI
and rendered account verifier are retired. Their former settings test and
verification script are absent. There is no supported authorize/poll/session
recipe here and no equivalent replacement is claimed. The product account and
managed gateway are separate contracts, not the old personal Cloud service.

## Preserved safety boundaries

Historical client fixtures used loopback HTTP, temporary encrypted-record files,
substitute encryption and isolated Electron HOME/profile directories. Browser
approval, entitlements and credential storage were synthetic; they did not prove
real OTP, billing activation, keychain persistence or a shipped desktop build.
Do not use installed-app profiles, real customer accounts or live sign-in as
fixtures, and do not restore retired endpoints to satisfy old recipes.

Any future account workflow must keep credentials out of renderer JavaScript,
engines, logs and unrelated organization services. The renderer must not choose
the origin, callback, checkout destination or paid entitlement. Only an
explicit isolated fixture may inject HTTP loopback. Remote/child frames must
not cross the privileged account IPC boundary.

A browser dashboard or checkout result is not proof of paid access. Verified
identity, expiry and server-authoritative service enforcement are required;
settings text is not an access-control gate. Failure must not silently retain
verified entitlement, and sign-out must disclose failed remote revocation or
failed durable cleanup. Optional-account failure must not block free local use.
