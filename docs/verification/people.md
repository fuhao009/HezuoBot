# Adding people to a hosted workspace — retired

## Retired scope

The hosted People invitation and email-code sign-in recipe is retired. Its
server fixtures have been removed. Do not use the former bootstrap, invite,
promote, domain allowlist or portal-management steps as an active workflow.
A surviving UI component does not establish a supported hosted deployment.

## Current boundary

`desktop/server/workspace-access.ts` rejects retired hosted settings rather
than falling back to local access. Any defined `HEZUO_ADMIN_URL`,
`HEZUO_ADMIN_WORKSPACE` or `HEZUO_ADMIN_MEMBERSHIP`, including an empty value
or membership set to `local`, must fail closed. A locally issued admin session
must not bypass that rejection. The current boundary is recorded in
`desktop/server/workspace-access.test.ts` and
`scripts/testing/verification-docs.test.ts`.

Account removal and independently paired-device revocation are different
security actions; historical People screenshots prove neither a current
invitation flow nor device revocation. Do not populate a live membership list
or use real email addresses or credentials to recreate them.

No checks were run for this documentation update.
