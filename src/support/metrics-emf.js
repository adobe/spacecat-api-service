/*
 * Copyright 2025 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

/**
 * CloudWatch Embedded Metric Format (EMF) emitter.
 *
 * EMF is a pure-JSON log line that CloudWatch auto-extracts into metrics with
 * no PutMetricData calls and no extra IAM permissions. We write directly to
 * stdout (NOT the helix logger, which prefixes lines and would corrupt the EMF
 * envelope). Emission is best-effort: any error is swallowed so a metric
 * failure can never affect the request path.
 *
 * Reference: https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Embedded_Metric_Format_Specification.html
 */

const NAMESPACE = 'Mysticat/GitHubService';

// Module-scoped flag so we warn at most once per Lambda instance when the
// environment falls back to the default. Emitting per-request would flood the
// log for every invocation on a mis-configured deploy; once-per-instance is
// enough for ops to notice on the first cold start and still avoid confusing
// on-call with a warn spike that dwarfs the actual outcome events.
let envFallbackWarned = false;

/**
 * Resolves the deployment environment name from process/Lambda env vars.
 * Precedence: AWS_ENV > ENV > 'dev'.
 *
 * If neither variable is set the caller falls back to 'dev'. In prod that is a
 * silent mis-labeling — every metric routes to the dev dashboard while prod
 * dashboards read as zero traffic. Pass `log` to have this warned once per
 * Lambda instance (via `log.warn`) so a broken deploy manifest surfaces on the
 * very first invocation rather than staying invisible until someone spot-checks
 * the wrong-tier dashboard.
 *
 * @param {object} env - The env object (context.env or process.env)
 * @param {object} [opts] - Options
 * @param {object} [opts.log] - Optional logger for the default-fallback warning
 * @returns {string} Environment name
 */
export function resolveEnvironment(env = {}, { log } = {}) {
  if (env.AWS_ENV) {
    return env.AWS_ENV;
  }
  if (env.ENV) {
    return env.ENV;
  }
  // Defensive: some callers pass a partial logger (info/error only) — helix
  // and Lambda contexts historically only guarantee `log.info`, so `log.warn`
  // may be absent. Skip silently rather than crash the request path.
  if (log && typeof log.warn === 'function' && !envFallbackWarned) {
    envFallbackWarned = true;
    log.warn(
      '[metrics-emf] resolveEnvironment: neither AWS_ENV nor ENV is set — '
      + "defaulting to 'dev'. In a production deploy this mis-labels metrics; "
      + 'check the Lambda env-var manifest.',
    );
  }
  return 'dev';
}

/**
 * Test-only: reset the module-scoped warn-once latch so unit tests can verify
 * the first-call semantics without cross-test bleed. Exported (not prefixed
 * with an underscore, which lint forbids) but named to make its scope obvious
 * so no production caller reaches for it by mistake.
 */
// eslint-disable-next-line camelcase
export function resetEnvFallbackWarnedForTest() {
  envFallbackWarned = false;
}

/**
 * Emits a single CloudWatch EMF metric envelope.
 *
 * The default sink is console.log, which writes to stdout. In Lambda,
 * CloudWatch Logs Agent picks up stdout and the EMF agent extracts the
 * metric. No IAM PutMetricData permission is required.
 *
 * @param {object} metric - Metric descriptor
 * @param {string} metric.name - CloudWatch metric name
 * @param {number} [metric.value=1] - Metric value (default 1 for counters)
 * @param {string} [metric.unit='Count'] - CloudWatch unit (Count, Milliseconds, etc.)
 * @param {object} [metric.dimensions={}] - Additional dimension key/value pairs.
 *   Dimension keys MUST NOT equal the metric name: in the EMF envelope the metric
 *   value and the dimension values share one top-level namespace, so a collision
 *   would silently overwrite the dimension. Current PascalCase metric names never
 *   collide with the dimension keys (Environment, Event, Reason, Outcome, ...).
 * @param {object} [options] - Emission options
 * @param {string} [options.environment='dev'] - Environment dimension value
 * @param {Function} [options.sink=console.log] - Output function; receives the JSON string
 * @param {string} [options.namespace=NAMESPACE] - CloudWatch namespace. Defaults to the
 *   GitHub-service namespace; pass a domain-specific one (e.g. 'Mysticat/Brands') for
 *   metrics emitted from other subsystems.
 */
// eslint-disable-next-line no-console
const defaultSink = (line) => console.log(line);

export function emitMetric(
  {
    name, value = 1, unit = 'Count', dimensions = {},
  },
  { environment = 'dev', sink = defaultSink, namespace = NAMESPACE } = {},
) {
  try {
    // Always include Environment as the first dimension so every metric is
    // filterable by dev/stage/prod without needing a separate namespace.
    const dims = { Environment: environment };
    for (const [k, v] of Object.entries(dimensions)) {
      // Drop null/undefined values: they would produce a dimension key with
      // no value, which CloudWatch rejects and which silently breaks metrics.
      if (v !== undefined && v !== null) {
        dims[k] = String(v);
      }
    }
    const envelope = {
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [{
          Namespace: namespace,
          Dimensions: [Object.keys(dims)],
          Metrics: [{ Name: name, Unit: unit }],
        }],
      },
      ...dims,
      [name]: value,
    };
    sink(JSON.stringify(envelope));
  } catch {
    // best-effort: metrics must never break the request path
  }
}
