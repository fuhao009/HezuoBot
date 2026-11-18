# HezuoBot

HezuoBot is a desktop AI-agent workspace backed by a separately operated gateway. The desktop runs the local agent tools and browser integration; the gateway handles accounts, access, billing and the gateway-owned companion relay. Native mobile clients are not part of the documented product surface.

## Repository layout

- `desktop/`: desktop UI, Electron integration and local harness server.
- `gateway/`: gateway services and operator/deployment tooling.
- `packages/`, `scripts/`, `skills/`: shared code, development/release tooling and agent skills.
- `docs/`: architecture, development instructions and historical records.

Start with [architecture](docs/architecture.md), [backend development](docs/backend-development.md) and the [current batch](docs/current-batch.md). Older documentation and screenshots may describe removed upstream functionality; they are not evidence that it is supported in the current product.

## Desktop development

Use Node.js 24 or newer and pnpm. Install dependencies from the repository root:

```sh
pnpm install
pnpm dev
```

`pnpm dev` starts the Vite desktop UI development server, not a packaged Electron application or a gateway deployment. Desktop behavior that needs Electron, native helpers or a gateway must be exercised in the corresponding desktop/runtime environment; the UI server alone does not establish that those integrations work.

Compile the desktop UI and server with:

```sh
pnpm build
```

For packaging, use the single product entry point, `pnpm package`. Configure the gateway origin for the target deployment. For the private-network gateway, supply its public certificate, never its private key:

```sh
HEZUO_PRODUCT_SERVICE_URL=https://192.168.66.193:18487 \
  pnpm package -- --lan-origin --gateway-ca /path/to/gateway-public-cert.pem
```

The origin and port must match the operator's actual gateway configuration. Public DNS deployments use their configured HTTPS origin without the private-network exception. Platform toolchains, native resources and signing requirements still apply; see [product release](docs/product-release.md). Packaging produces a desktop artifact, not a gateway deployment. The retired upstream npm CLI, open-source packaging variants and upstream cloud-hosting workflows are not the product installation path.

## Gateway development and deployment

The gateway runs separately from the desktop. Its local lifecycle entry points are:

```sh
pnpm gateway:init
pnpm gateway:start
pnpm gateway:status
pnpm gateway:stop
```

Read [local gateway](docs/local-gateway.md) before initialization: it creates local configuration and secrets. Operator/service commands are documented there; do not point development or mutation fixtures at a live gateway or user data.

Use the [193 gateway deployment runbook](docs/gateway-deployment-193.md) for the managed LAN deployment, including service configuration, certificates and operational procedures. Do not deploy the desktop harness as the removed upstream VPS/cloud service. Remote companion connections use the gateway-owned relay and desktop tunnel, not upstream account infrastructure. See the [device and relay contract](docs/gateway-client-devices.md) for authentication boundaries; its retained transport and push interfaces do not establish a supported native mobile client.

## Security and privacy

Agents can invoke real tools with the user's privileges. Review permissions, credentials and gateway exposure before use. Do not publish secrets or sensitive workspace data in issues or diagnostic output.

## Documentation and evidence

The [verification guide](docs/verification/README.md) describes isolated verification procedures. Historical acceptance reports establish only what they recorded at the time, not the state of renamed commands, removed services or the current build. This documentation update does not establish that any build, installation, test or deployment has occurred.

## License and attribution

See [LICENSE](LICENSE) and [NOTICE](NOTICE) for the repository's license and attribution terms. Original ownership and third-party license notices are retained as required attribution, not renamed to imply new ownership. Bundled third-party components retain their own terms and notices, including those under [`third_party/cua-driver/`](third_party/cua-driver/).
