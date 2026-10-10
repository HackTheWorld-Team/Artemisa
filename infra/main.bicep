// ============================================================================
// Artemisa — Azure Container Apps (backend only, Consumption plan)
//
// Cost target: ~USD 10/month. See infra/README.md for the full walkthrough.
//
// Two cost traps this template deliberately avoids:
//   1. workloadProfiles is OMITTED, not []. Omitting it (null) creates a
//      Consumption-only environment. An empty array creates a "workload
//      profiles" environment, which bills a $0.10/h management fee (~$73/month)
//      before a single container runs.
//   2. appInsightsConfiguration / logAnalyticsConfiguration are OMITTED, so no
//      Log Analytics workspace is attached. Attaching one bills per GB ingested.
// ============================================================================

targetScope = 'resourceGroup'

@description('Azure region. Pick one with availability zones and low latency for your users.')
param location string = resourceGroup().location

@description('ghcr.io image repository WITHOUT tag, e.g. vectorg99/artemisa-backend.')
param imageRepository string

@description('Immutable image tag produced by the deploy workflow (git SHA by default).')
param imageTag string

@description('Frontend origin allowed by CORS, e.g. https://artemisa-ai.netlify.app')
param corsAllowedOrigins string

@description('Public origin of THIS backend. Required: without it the origin is taken from request headers, which the client controls.')
param publicBaseUrl string

@minValue(1)
@maxValue(10)
@description('Minimum replicas. 1 keeps the API always warm (no cold start) at ~USD 4.29/month, which stays inside a USD 10/month budget with room to spare. 2 adds availability-zone spread but costs ~USD 10.21/month and consumes the whole budget. Either value gets automatic restart of a wedged process from the health probes.')
param minReplicas int = 1

@maxValue(25)
param maxReplicas int = 5

@description('vCPU per replica. 0.25 is enough for a stateless CPU-burst API.')
param cpu string = '0.25'

@description('Memory per replica.')
param memory string = '0.5Gi'

@secure()
@description('Comma-separated valid API keys (ARTEMISA_API_KEYS).')
param artemisaApiKeys string

@secure()
@description('Token guarding /api/metrics in production (METRICS_SECRET).')
param metricsSecret string

@secure()
@description('Emergency auth override (BYPASS_SECRET). Redacted from logs automatically.')
param bypassSecret string

@secure()
@description('ghcr.io username for image pull.')
param ghcrUsername string

@secure()
@description('ghcr.io token with packages:read (a classic PAT with read:packages).')
param ghcrToken string

var ghcrServer = 'ghcr.io'
var appName = 'artemisa-backend'
var envName = 'artemisa-env'

// --- Container Apps Environment (Consumption-only, no Log Analytics) --------
resource env 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: envName
  location: location
  properties: {
    // Intentionally absent: workloadProfiles stays null => Consumption-only.
    // zoneRedundant is not supported on Consumption-only environments.
    zoneRedundant: false
  }
}

// --- Container App ---------------------------------------------------------
resource backend 'Microsoft.App/containerApps@2024-03-01' = {
  name: appName
  location: location
  properties: {
    managedEnvironmentId: env.id
    configuration: {
      // Single mode: one active revision. Still keeps revision history, so a
      // bad deploy is one command away from being reverted.
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 3001
        transport: 'auto'
        allowInsecure: false
      }
      registries: [
        {
          server: ghcrServer
          username: ghcrUsername
          passwordSecretRef: 'ghcr-token'
        }
      ]
      secrets: [
        { name: 'ghcr-token', value: ghcrToken }
        { name: 'artemisa-api-keys', value: artemisaApiKeys }
        { name: 'metrics-secret', value: metricsSecret }
        { name: 'bypass-secret', value: bypassSecret }
      ]
    }
    template: {
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
        rules: [
          {
            name: 'http'
            http: {
              metadata: {
                concurrentRequests: '10'
              }
            }
          }
        ]
      }
      containers: [
        {
          name: 'backend'
          image: '${ghcrServer}/${imageRepository}:${imageTag}'
          resources: {
            // Bicep has no decimal literals, and its type definition for this
            // property says "int" — but the ARM API accepts a decimal string
            // ("0.25"), which is what the portal emits too. Suppress the
            // false-positive type warning rather than rounding up to 1 vCPU
            // (4x the cost for no reason).
            #disable-next-line BCP036
            cpu: cpu
            memory: memory
          }
          env: [
            { name: 'NODE_ENV', value: 'production' }
            { name: 'PORT', value: '3001' }
            { name: 'HOST', value: '0.0.0.0' }
            { name: 'LOG_LEVEL', value: 'info' }
            // TRUST_PROXY=1 is mandatory behind Container Apps: it terminates
            // TLS, so without it every request appears to come from one IP and
            // the per-IP rate limiter locks out all real users.
            { name: 'TRUST_PROXY', value: '1' }
            { name: 'PUBLIC_BASE_URL', value: publicBaseUrl }
            { name: 'CORS_ALLOWED_ORIGINS', value: corsAllowedOrigins }
            { name: 'AUTH_REQUIRED', value: 'true' }
            { name: 'REQUEST_TIMEOUT_MS', value: '120000' }
            { name: 'RATE_LIMIT_GLOBAL', value: '100' }
            { name: 'RATE_LIMIT_CREATOR', value: '120' }
            { name: 'RATE_LIMIT_AGENT', value: '30' }
            { name: 'ARTEMISA_API_KEYS', secretRef: 'artemisa-api-keys' }
            { name: 'METRICS_SECRET', secretRef: 'metrics-secret' }
            { name: 'BYPASS_SECRET', secretRef: 'bypass-secret' }
          ]
          // These two endpoints already exist in src/routes/health.ts. Wiring
          // them here is what makes Container Apps restart a wedged process on
          // its own — the single most important "don't fall over" control.
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/health/live'
                port: 3001
              }
              initialDelaySeconds: 15
              periodSeconds: 30
              timeoutSeconds: 5
              failureThreshold: 3
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/health/ready'
                port: 3001
              }
              initialDelaySeconds: 5
              periodSeconds: 10
              timeoutSeconds: 5
              failureThreshold: 3
            }
          ]
        }
      ]
    }
  }
}

output fqdn string = backend.properties.configuration.ingress.fqdn
output baseUrl string = 'https://${backend.properties.configuration.ingress.fqdn}'
