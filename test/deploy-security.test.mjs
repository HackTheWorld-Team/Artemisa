import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

describe('DigitalOcean deployment security', () => {
  const appYaml = fs.readFileSync(path.resolve('.do/app.yaml'), 'utf8');

  it('.do/app.yaml sets AUTH_REQUIRED=true', () => {
    assert.match(appYaml, /AUTH_REQUIRED[\s\S]*?value:\s*["']?true["']?/);
  });

  it('.do/app.yaml marks ARTEMISA_API_KEYS as SECRET', () => {
    assert.match(appYaml, /ARTEMISA_API_KEYS[\s\S]*?type:\s*SECRET/);
  });

  it('.do/app.yaml sets NODE_ENV=production', () => {
    assert.match(appYaml, /NODE_ENV[\s\S]*?value:\s*production/);
  });

  it('.do/app.yaml marks METRICS_SECRET as SECRET', () => {
    assert.match(appYaml, /METRICS_SECRET[\s\S]*?type:\s*SECRET/);
  });

  it('frontend api.ts does NOT hardcode a production URL', () => {
    const apiTs = fs.readFileSync(path.resolve('frontend/src/lib/api.ts'), 'utf8');
    assert.doesNotMatch(apiTs, /onrender\.com/);
    assert.doesNotMatch(apiTs, /ondigitalocean\.app/);
    assert.doesNotMatch(apiTs, /https:\/\/artemisa\./);
  });

  it('frontend api.ts falls back to localhost (safe default)', () => {
    const apiTs = fs.readFileSync(path.resolve('frontend/src/lib/api.ts'), 'utf8');
    assert.match(apiTs, /process\.env\.NEXT_PUBLIC_API_URL \|\| ['"]http:\/\/localhost:3001['"]/);
  });
});

// These guard the two settings that silently break the cost or availability of
// the Azure deploy, plus the two that fail as a silent 403 for end users.
// They read infra/main.bicep as text on purpose: asserting on the compiled ARM
// would require a Bicep toolchain in CI for six regexes.
describe('Azure Container Apps deployment security (ADR-0009)', () => {
  const stripComments = (source) => source.replace(/^\s*\/\/.*$/gm, '');
  const bicep = stripComments(fs.readFileSync(path.resolve('infra/main.bicep'), 'utf8'));
  const workflow = fs.readFileSync(path.resolve('.github/workflows/deploy-azure.yml'), 'utf8');

  it('infra/main.bicep sets AUTH_REQUIRED=true', () => {
    assert.match(bicep, /name:\s*'AUTH_REQUIRED',\s*value:\s*'true'/);
  });

  it('infra/main.bicep enables NODE_ENV=production', () => {
    assert.match(bicep, /name:\s*'NODE_ENV',\s*value:\s*'production'/);
  });

  it('infra/main.bicep resolves ARTEMISA_API_KEYS from a secret, never inline', () => {
    assert.match(bicep, /name:\s*'ARTEMISA_API_KEYS',\s*secretRef:\s*'artemisa-api-keys'/);
    assert.doesNotMatch(bicep, /name:\s*'ARTEMISA_API_KEYS',\s*value:/);
  });

  it('infra/main.bicep marks METRICS_SECRET and BYPASS_SECRET @secure() and resolved by secretRef', () => {
    for (const [param, env] of [
      ['metricsSecret', 'METRICS_SECRET'],
      ['bypassSecret', 'BYPASS_SECRET'],
    ]) {
      assert.match(
        bicep,
        new RegExp(`@secure\\(\\)[\\s\\S]{0,200}param ${param}`),
        `${param} must be an @secure() parameter`,
      );
      assert.match(bicep, new RegExp(`name: '${env}',\\s*secretRef:`), `${env} must be resolved through secretRef`);
    }
  });

  it('infra/main.bicep sets TRUST_PROXY=1 so rate limiting keys on the real client IP', () => {
    // Container Apps terminates TLS. Without this, Express sees the proxy IP,
    // every user collapses onto one rate-limit bucket and real clients get
    // blocked after RATE_LIMIT_GLOBAL requests per minute.
    assert.match(bicep, /name:\s*'TRUST_PROXY',\s*value:\s*'1'/);
  });

  it('infra/main.bicep uses a CPU/memory pair Consumption actually accepts', () => {
    // Consumption only allows fixed pairs. Anything else is rejected at deploy
    // time with ContainerAppInvalidResourceTotal, which costs a failed deploy
    // rather than a config error anyone sees locally.
    const VALID_PAIRS = [
      [0.25, 0.5],
      [0.5, 1],
      [0.75, 1.5],
      [1, 2],
      [1.25, 2.5],
      [1.5, 3],
      [1.75, 3.5],
      [2, 4],
    ];
    const cpu = Number((bicep.match(/param cpu string = '([\d.]+)'/) || [])[1]);
    const gib = Number((bicep.match(/param memory string = '([\d.]+)Gi'/) || [])[1]);
    assert.ok(cpu > 0 && gib > 0, `could not read cpu/memory from the Bicep: cpu=${cpu} gib=${gib}`);
    assert.ok(
      VALID_PAIRS.some(([c, g]) => c === cpu && g === gib),
      `${cpu} vCPU / ${gib}Gi is not a valid Consumption pair; allowed: ` +
        VALID_PAIRS.map(([c, g]) => `${c}/${g}Gi`).join(', '),
    );
  });

  it('every container probe points at a route the backend actually registers', () => {
    // This is the invariant whose absence cost the most. The health router is
    // mounted at /api in src/app.ts and declares '/health/live' and
    // '/health/ready' relative to that mount, so the reachable paths are
    // /api/health/live and /api/health/ready. The Bicep originally probed
    // /health/live and /health/ready, which return 404, so Container Apps
    // never saw the replica as ready and reported the revision as
    // "Container crashing" while Node was running perfectly well. Nothing in
    // the repo checked that the probe path and the route agreed.
    const bicepPaths = [...bicep.matchAll(/path:\s*'(\/[^']*)'/g)].map((m) => m[1]);
    assert.ok(bicepPaths.length > 0, 'no probe paths found in the Bicep');

    const healthRoutes = fs.readFileSync('src/routes/health.ts', 'utf8').matchAll(/router\.get\(\s*'(\/[^']*)'/g);
    const registered = new Set([...healthRoutes].map((m) => m[1]));

    // The health router is mounted under /api; mirror that here so a future
    // change to the mount point fails this test instead of silently 404ing.
    const mount = fs.readFileSync('src/app.ts', 'utf8').match(/app\.use\(\s*'(\/[^']*)'\s*,\s*healthRouter/);
    const prefix = mount ? mount[1] : '/api';

    for (const probePath of bicepPaths) {
      const route = probePath.slice(prefix.length);
      assert.ok(
        registered.has(route),
        `probe '${probePath}' is not served: ${prefix} mounts healthRouter, which registers ${[...registered].join(', ')}`,
      );
    }
  });

  it('infra/main.bicep does not let the liveness probe restart a merely slow app', () => {
    // Observed: the platform edge adds ~700ms and spikes past 5s, and answers
    // `{"error":"App port is not ready"}` while the container is replaced. With
    // timeoutSeconds 5 and failureThreshold 3 the probe was killing a working
    // container, which turns a slow response into an outage. Liveness has to
    // tolerate degradation; it exists to catch a wedged process, not a busy one.
    const block = bicep.slice(bicep.indexOf("type: 'Liveness'"), bicep.indexOf("type: 'Readiness'"));
    const timeout = Number((block.match(/timeoutSeconds: (\d+)/) || [])[1]);
    const threshold = Number((block.match(/failureThreshold: (\d+)/) || [])[1]);
    assert.ok(timeout >= 10, `liveness timeoutSeconds should be >= 10, got ${timeout}`);
    assert.ok(threshold >= 6, `liveness failureThreshold should be >= 6, got ${threshold}`);
    // A restart fires only after `threshold` consecutive failures. Each probe
    // attempt is capped at `timeout` seconds and attempts are `period` apart,
    // so the window is threshold * (timeout + period), not threshold * timeout.
    const period = Number((block.match(/periodSeconds: (\d+)/) || [])[1]);
    const worstCaseSeconds = threshold * (timeout + period);
    assert.ok(
      worstCaseSeconds >= 180,
      `liveness gives up after only ${worstCaseSeconds}s of failures; that restarts a slow-but-working container`,
    );
  });

  it('infra/main.bicep scales out before a single replica drowns', () => {
    // Measured: at concurrency 10 the lone replica absorbed the whole burst and
    // stopped answering. 3 adds a replica earlier; scale-out is metered per
    // second, so this costs cents under a spike instead of a larger always-on
    // replica.
    const conc = Number((bicep.match(/concurrentRequests: '(\d+)'/) || [])[1]);
    assert.ok(conc > 0 && conc <= 5, `concurrentRequests should be <= 5, got ${conc}`);
  });

  it('infra/main.bicep takes PUBLIC_BASE_URL from a parameter, not a hardcoded host', () => {
    assert.match(bicep, /name:\s*'PUBLIC_BASE_URL',\s*value:\s*publicBaseUrl/);
    assert.doesNotMatch(bicep, /PUBLIC_BASE_URL[^}\n]*https?:\/\//);
  });

  it('infra/main.bicep omits workloadProfiles from the environment', () => {
    // Omitted = Consumption-only. An empty array creates a workload profiles
    // environment that bills USD 0.10/h (~USD 73/month) with nothing running.
    assert.doesNotMatch(bicep, /workloadProfiles/);
  });

  it('infra/main.bicep sends app logs to Log Analytics but adds no App Insights', () => {
    // This test said the opposite until the health probes were found to be
    // pointing at routes that do not exist. Every probe returned 404 for the
    // whole life of the deployment and Azure reported only "Container
    // crashing"; the console logs were the only place that named the real
    // cause. A workspace created ad hoc outside the template gets wiped from
    // the environment by the next deploy, which is exactly what happened, so
    // the destination has to be declared here.
    assert.match(bicep, /destination:\s*'log-analytics'/);
    assert.match(bicep, /customerId:\s*logs\.properties\.customerId/);
    assert.doesNotMatch(bicep, /appInsightsConfiguration/);
  });

  it('infra/main.bicep wires liveness and readiness to the existing health routes', () => {
    // These must be the full paths including the /api mount, not the bare
    // router-relative '/health/live'. The Bicep probed the bare form and every
    // probe returned 404 for the whole life of the deployment.
    assert.match(bicep, /path:\s*'\/api\/health\/live'/);
    assert.match(bicep, /path:\s*'\/api\/health\/ready'/);
    assert.doesNotMatch(bicep, /path:\s*'\/health\/(live|ready)'/);
    assert.match(bicep, /minReplicas:\s*minReplicas/);
  });

  it('infra/main.bicep keeps the ACR credential out of GitHub as a secure parameter', () => {
    // A managed identity would be cleaner, but express environments reject
    // registries[].identity outright (ExpressEnvironmentFeatureNotSupported),
    // and the only alternative that accepts it bills ~USD 73/month. So the
    // admin credential is the pull path, and the invariant worth keeping is
    // that it arrives as a @secure() parameter and lives only in the
    // Container App's secret store.
    assert.match(bicep, /passwordSecretRef:\s*'acr-password'/);
    assert.match(bicep, /name:\s*'acr-password',\s*value:\s*acrPassword/);
    assert.match(bicep, /@secure\(\)[\s\S]{0,200}param acrPassword/);
    assert.doesNotMatch(bicep, /ghcr/);
  });

  it('workflow reads the ACR credential at deploy time instead of storing it as a secret', () => {
    assert.match(workflow, /az acr credential show/);
    // The value must reach the template through the private params file, not
    // as a command-line argument where it would land in a process list.
    assert.match(workflow, /"acrPassword":\s*\{ "value": "\$ACR_PASS" \}/);
    assert.doesNotMatch(workflow, /ACR_PASS=\$\{\{ secrets/);
  });

  it('workflow gates the deploy on /api/health and rolls back when the gate fails', () => {
    assert.match(workflow, /Health gate/);
    assert.match(workflow, /\/api\/health/);
    assert.match(workflow, /Roll back to the previous image/);
    assert.match(workflow, /if: failure\(\)/);
  });

  it('workflow authenticates to Azure with OIDC, not a stored client secret', () => {
    assert.match(workflow, /azure\/login@v2/);
    assert.match(workflow, /client-id:/);
    assert.doesNotMatch(workflow, /client-secret/i);
  });

  it('workflow passes secrets through a private file, never as CLI arguments', () => {
    assert.match(workflow, /--parameters\s+"@\$params"/);
    assert.match(workflow, /chmod 600 "\$params"/);
  });
});
