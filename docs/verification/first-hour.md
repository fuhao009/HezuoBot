# A new Cloud's first hour — retired

## Retired scope

The former personal Cloud home end-to-end scenario is retired. Its exclusive
fixture has been removed. There is no supported command here to launch a Cloud
home, provision trial credit, or connect a person's Google account. Historical
welcome messages and screenshots are not current acceptance evidence.

## Remaining local coverage and safety

The first-hour host logic still has local unit coverage in
`desktop/server/host/first-hour.test.ts`; its implementation is
`desktop/server/host/first-hour.ts`. This is not a replacement for the removed
Cloud deployment scenario or proof of live Gmail/Calendar integration.

Keep fixtures in disposable homes with fake providers. A first look must stay
read-and-draft: a connection or welcome card must not authorize sending or
deleting mail. The current relay boundary is covered by
`desktop/server/read-and-draft.test.ts`. Do not transfer live credentials,
contact Google, or enable a retired Cloud role to reproduce old evidence.

No checks were run for this documentation update.
