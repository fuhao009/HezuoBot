# The rail of Clouds and its ＋

## Retired scope

The upstream multi-Cloud rail, Cloud purchase/recolor flow and its preview and
verification scripts are retired. Their dedicated rail, purchase and place-card
UI tests are absent. There is no supported remote Cloud management recipe here
and no equivalent replacement is claimed. Retained workspace appearance or
desktop transport code does not establish that the Cloud rail is available.

## Preserved safety boundaries

Earlier UI fixtures used isolated previews and synthetic services, not real Cloud
accounts, payments or customer workspaces. They were not production acceptance.
Do not run old purchase steps against a live account or restore removed endpoints
to satisfy historical fixtures.

Privileged desktop state must remain main-process controlled: remote pages must
not receive the list of places or their addresses, credentials or pairing grants.
A page may learn only the minimal chrome state it needs. Switching or recoloring
must require an explicit user action and an ID main actually listed, with
privileged rail operations restricted to their own trusted page. A navigation,
reload, crash or unresponsive document must not strand the user behind hidden
navigation chrome. Desktop-only preferences must not mutate remote workspaces.

Remote appearance mutations require owner/admin authorization; a missing remote
capability must fail honestly, not silently claim success. Images must remain
bounded, decoded and re-encoded and checked server-side, without retaining
unneeded metadata. These constraints are not evidence that the retired purchase
or rail workflow still runs.
