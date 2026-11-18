# Fleet: many workspaces on one server

## Retired scope

The upstream fleet CLI, privileged tenant agent and operator workspace UI are
retired, along with their dedicated tests. There is no supported fleet init,
create, recovery or deployment recipe here and no equivalent replacement is
claimed. Do not run historical root commands against an existing machine or
restore removed production modes to satisfy old fixtures.

## Preserved safety boundaries

Historical tests used disposable filesystem roots, sockets, ledgers and recording
machines. They did not qualify Linux isolation, root transitions, power-loss
recovery or cleanup after interruption. Any future implementation must preserve
these constraints; this list does not claim a current fleet service exists:

- Serialize mutations; do not assume direct CLI calls have cross-process locking.
- Reserve names and ports durably before external effects. Partial provisioning
  requires explicit operator reconciliation, not shortcut retries or a claim
  that an error state means the service stopped.
- Keeping tenant data must retain its account and UID ownership, name and ports;
  retained homes must not be silently reused. Full deletion is destructive and
  must remain explicit.
- Refuse residual paths and broken symlinks. Tenant filesystem access must drop
  supplementary groups, gid and uid, bound reads and execution time, reject
  links and special files, and use same-directory atomic replacement for writes.
- Parse usage in the unprivileged child and return only bounded aggregates to
  root. Unsafe or failed reads are unavailable/null, never false-zero totals;
  tenant-controlled ledgers are not trusted billing records.
- Use exact HTTPS gateway origins and scoped credentials, never a portal master
  key. Root-owned environment files do not prevent a tenant process reading its
  own environment. Audit actions without secrets.

Do not use a live tenant, real customer ledger or the user's home as a fixture.
