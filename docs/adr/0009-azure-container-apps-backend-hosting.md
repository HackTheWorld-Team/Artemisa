# ADR-0009: Host the backend on Azure Container Apps (Consumption)

## Status

Accepted

## Context

- The backend currently deploys to DigitalOcean App Platform via `.do/app.yaml` (`instance_count: 1`, `basic-xxs`). The frontend is a separate deploy on Netlify. Hosting was never recorded as an explicit decision, so the deploy path is documented per-provider rather than chosen.
- Per ADR-0008 the backend only generates configuration files: no database, no filesystem writes, no network calls during generation, no persistent disk. Every request is a pure function of its body. Cost is therefore dominated by CPU-seconds awake, not by state, storage or egress.
- `docker/Dockerfile.backend` already exists as a multi-stage build running as a non-root user with a `HEALTHCHECK`, and `src/routes/health.ts` already exposes `/api/health`, `/health/live` and `/health/ready`.
- `server.ts` already drains in-flight requests on `SIGTERM`/`SIGINT`, which is what a managed container platform sends when it recycles or scales a replica.
- Availability targets a single backend with no failover region. Multi-region is out of scope for this project's traffic.
- The image registry is a cost and supply-chain decision, not just a hosting one. Container Apps accepts arbitrary registries as an image source, and the deployment identity model differs sharply between them: a registry token has to be stored and rotated, a managed identity does not.

## Decision

- Deploy **only the backend** to Azure Container Apps on the Consumption plan, at about USD 9.29/month with `minReplicas: 1`. The frontend stays on Netlify and is not part of this deploy path. `agent-creator/` is not deployed at all (legacy, superseded by `frontend/agents/new`).
- `infra/main.bicep` owns the infrastructure. It creates one `Microsoft.ContainerRegistry`, one `Microsoft.App/managedEnvironments` and one `Microsoft.App/containerApps`, plus the `AcrPull` role assignment that connects them.
- `workloadProfiles` is **omitted** from the environment, not set to `[]`. Omitting it yields a Consumption-only environment. An empty array creates a workload profiles environment, which bills a USD 0.10/h management fee (~USD 73/month) before any container runs.
- No `logAnalyticsConfiguration` and no `appInsightsConfiguration` are attached, so console output is not billed per GB ingested.
- The container runs at 0.25 vCPU / 0.5 GiB with `minReplicas: 1`, `maxReplicas: 5`, and a built-in HTTP scale rule at `concurrentRequests: 10`. `minReplicas` defaults to 1 rather than 2 to stay inside a USD 10/month budget; see Revisit Conditions.
- Liveness and readiness probes point at the existing `/health/live` and `/health/ready`. This is what lets the platform restart a wedged process without human intervention.
- Images are built by GitHub Actions from `docker/Dockerfile.backend`, pushed to Azure Container Registry, and tagged with the short commit SHA so a tag is immutable and a rollback target always resolves to the content it named.
- The container app pulls the image with a **system-assigned managed identity** holding `AcrPull`. ACR admin credentials are disabled, so the role assignment is the only pull path. No registry secret exists in GitHub or in the Container App configuration.
- `.github/workflows/deploy-azure.yml` gates the deploy on `https://<fqdn>/api/health` returning 200 and reverts to the previous image when the gate fails. A broken release cannot stay live while reporting success.
- `TRUST_PROXY=1` and `PUBLIC_BASE_URL` are declared in the Bicep rather than left to defaults, because both are prerequisites for correct behavior behind a TLS-terminating proxy and both fail silently when absent.
- The frontend authenticates with the same `ARTEMISA_API_KEYS` value it already uses against DigitalOcean, delivered as Netlify's `NEXT_PUBLIC_API_KEY`.

## Alternatives Considered

- Azure Kubernetes Service (AKS): rejected. The control plane with Uptime SLA costs ~USD 72/month plus nodes (~USD 148/month for two `D2as v5`), roughly USD 220/month total, for three stateless containers and no database. It buys no availability property that Container Apps does not already provide, and adds version upgrades, ingress, cert-manager and RBAC as ongoing work.
- Azure App Service B1 Linux: rejected. B1 is ~USD 55/month in `eastus` and its scale-out and deployment slots only unlock at S1 (~USD 69/month). Container Apps includes both in the Consumption price.
- Azure Functions Consumption: rejected. Its free grant would cover the traffic, but it requires rewriting `src/app.ts` (helmet, CORS, compression, rate limiting, body limits) into the Functions programming model, and the in-memory rate limiter does not hold across instances.
- A single burstable VM running `docker/docker-compose.production.yml`: rejected as the primary path. It is comparably cheap (~USD 9/month) but makes the host a single point of failure and transfers OS patching, TLS renewal and process supervision to a maintainer. It remains a reasonable fallback if the Azure account is unavailable.
- `ghcr.io` over Azure Container Registry: **originally accepted, then reversed during migration.** GHCR has no registry fee, but Container Apps can only pull from it with a stored token. On this deployment the token had to be created interactively by a human, and it expires: an expired token stops scale-out and new deploys while existing replicas keep running, so the failure would be silent and late. Azure Container Registry Basic costs USD 0.1666/day (~USD 5.00/month) and lets the container app pull with a **system-assigned managed identity**, which has nothing to store and nothing to rotate. The USD 5.00 premium is bought deliberately; it fits inside the budget at `minReplicas: 1` (USD 9.29 total) and removes an entire class of operational failure. Returning to GHCR is a valid cost-cut if the budget ever tightens, at the price of owning a rotating credential again.
- Container Apps secret store over Azure Key Vault: accepted for now. Key Vault adds a resource and a managed identity for three secrets on a project with one backend. Revisit if the secret count grows or if policy requires customer-managed key custody.

## Consequences

- The deploy cost is about USD 9.29/month (ACR Basic USD 5.00 + Container Apps ~USD 4.29 at `minReplicas: 1`) and roughly USD 15/month worst case at `minReplicas: 2` with normal traffic. Raising `minReplicas` to 2 buys availability-zone spread for ~USD 5.92 more and breaks a USD 10/month budget, which is why it is not the default.
- Availability depends on probes and `minReplicas >= 1`, not on the process being supervised. A wedged Node process is restarted by the platform rather than noticed by a human.
- Container Apps guarantees 99.95% monthly uptime with service credits, which is about 22 minutes of allowed downtime per month. There is no failover region, so a full region outage takes the API down.
- **The deployment has a single replica and no availability-zone spread**, because `minReplicas: 2` costs about USD 15.21/month including the registry and the ceiling is USD 15. Losing the one replica means the API is down until Container Apps replaces it. This stopped being theoretical when the DigitalOcean account was cancelled: there is no second backend, so the ADR's earlier "keeps a fallback during the transition" note no longer applies.
- The deploy path is now split across two providers: backend on Azure, frontend on Netlify. A CORS or URL mismatch between them fails as `403 API_CORS_FORBIDDEN` with no other symptom, so `CORS_ALLOWED_ORIGINS` must track the Netlify origin exactly.
- `NEXT_PUBLIC_API_URL` is baked at build time, so repointing the frontend requires a Netlify rebuild, not just a variable change.
- Without `TRUST_PROXY=1` every request appears to originate from Container Apps' proxy, the per-IP rate limiter treats all users as one source, and real users are blocked after `RATE_LIMIT_GLOBAL` requests per minute. This is the most likely self-inflicted outage in this design and is why the value is pinned in the Bicep.
- The `AcrPull` role assignment is created **after** the container app, because it needs the app's identity. On a brand new environment the first revision can fail to pull for up to about a minute while the assignment propagates; Container Apps retries and recovers, and the deploy health gate waits for it. A failed first deploy is more likely to be propagation than a broken image.
- `.do/app.yaml` and its DigitalOcean deploy path remain in the repository during the transition and can be removed once the Azure path is confirmed in production.

## Revisit Conditions

- Monthly cost exceeds roughly USD 50 without a corresponding traffic increase; check for an accidentally attached workload profiles environment or Log Analytics workspace before scaling anything down.
- Backend traffic sustains more than ~10 concurrent requests, or a full Auto-largo Creator run needs more than `RATE_LIMIT_CREATOR` headroom; raise `maxReplicas` or move to a workload profile.
- A database, durable state or server-side accounts are introduced, which breaks the stateless premise this pricing rests on (see ADR-0008).
- Availability requirements exceed 99.95%, which implies a second region behind a global traffic manager.
- DigitalOcean is decommissioned and `.do/app.yaml` plus its section in `docs/deployment.md` and the DigitalOcean describe block in `test/deploy-security.test.mjs` are removed.
