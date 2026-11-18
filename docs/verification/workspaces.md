# Workspaces screen and the fleet agent

## Retired scope

The upstream operator fleet agent, fleet CLI, fleet API and Settings →
Installations management flow are retired. Their dedicated server, filesystem
and renderer tests are removed. There is no current recipe for creating,
suspending, upgrading or deleting hosted workspaces, and no equivalent
replacement is claimed. Provider instance grouping is not a tenant fleet agent.

Historical fixtures used temporary sockets, recording machines and disposable
filesystem roots and ledgers. They did not prove root deployment or actual
root-to-tenant transitions. Do not run the old root/systemd/Caddy/nftables
instructions or restore removed production modes to satisfy those fixtures.

## Preserved safety boundaries

Any future operator service must restrict its control socket and authorization,
audit actions without keys, and avoid leaking command output or ledger contents.
Unsafe usage input must not become false-zero totals or compromise other rows.
Use disposable homes and filesystems, never a live tenant or the user's data.
These are safety requirements, not evidence that the retired service exists.
