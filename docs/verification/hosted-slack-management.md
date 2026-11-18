# Hosted Slack management entry point — retired

## Retired scope

The portal-managed Slack entry-point recipe is retired with the hosted
workspace authorization mode. Do not configure a portal, issue hosted sessions,
or run the former authorization fixture to obtain a management link.
Historical management URLs and UI captures are not active setup instructions.

## Remaining code and safety boundary

The remaining link helper and route have source and fixture coverage in
`desktop/server/hosted-slack.ts`, `desktop/server/hosted-slack.test.ts` and
`desktop/server/routes/hosted-slack.test.ts`. Their presence does not make the
retired hosted deployment supported. The current startup boundary is in
`desktop/server/workspace-access.ts` and
`desktop/server/workspace-access.test.ts`: retired hosted settings must be
rejected, not treated as standalone local access.

A management link must not disclose a portal URL to an unauthenticated caller
or grant a member administrative writes. UI link rendering is not evidence of
Slack installation, agent publishing, profile synchronization, message delivery
or authorization by a separately deployed service. Do not use a customer's
workspace, Slack token or live Admin service to recreate old screenshots.

No checks were run for this documentation update.
