# Podman full-stack acceptance — retired

The former Compose-based full-stack recipe is retired. Its deployment assets
have been removed from this checkout; the old image build, Compose launch and
control commands are not an active verification procedure. Do not recreate the
missing deployment files or treat an older successful run as current acceptance.

For the current isolated fake-engine workflow, follow [Launch](README.md#launch)
and [Chat turns](chat-turns.md). The separate [Podman Firefox sandbox recipe](podman-firefox.md)
covers the managed desktop sandbox, not the removed full-stack deployment.

## Retained security and evidence boundaries

- Use a dedicated rootless user/machine, a fresh private data directory, unused
  ports and a unique project identity. Never mount live app data, reuse another
  fixture's data, substitute its URL, or supply production credentials.
- Engine-wide container management access remains privileged even when app data
  is isolated. Confirm fixture identity before any mutation; a fake engine does
  not prove model-driven GUI interaction or production readiness.
- A proxy must reject unpaired requests instead of treating them as the loopback
  owner. Browser access requires explicit pairing; deployment retirement does
  not waive authentication or workspace authorization.
- Any future replacement must demonstrate separate bot workspaces, correct
  rootless ownership, persistence after desktop recreation, and inability of one
  desktop to read another's workspace. Never repair a user's workspace to make
  a comparison pass.
- Keep candidate revision, runtime versions, image identity, ownership evidence,
  bounded results and screenshots private and tied to the exact disposable
  fixture. Historical evidence alone is not current acceptance.
- Cleanup must affect only recorded fixture desktops and their exact temporary
  directory. A Compose project did not own the separately managed bot desktops;
  broad process-name kills, broad temporary-root deletion and live-data cleanup
  remain prohibited. Retain local evidence until reviewed.
