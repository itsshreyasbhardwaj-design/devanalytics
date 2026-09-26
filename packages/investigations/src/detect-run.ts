import { MS_PER_DAY, bucketStart, stableId, type Granularity, type ScopeType, type TimeWindow } from '@devanalytics/core';
import type { Database } from '@devanalytics/db';
import { METRIC_IDS, requireMetricDefinition, type MetricEngine } from '@devanalytics/metrics';
import { detect, type BucketObservation, type Detection } from '@devanalytics/anomaly-detection';

/**
 * Scheduled detection.
 *
 * For each metric and scope, build a baseline from the preceding buckets and
 * test the most recent complete bucket. Non-detections are returned too, so
 * "we looked and nothing was unusual" is a reportable answer rather than an
 * empty screen.
 */

export interface DetectionRunRequest {
  orgId: string;
  scopes: { scopeType: ScopeType; scopeId: string }[];
  metrics?: string[];
  granularity?: Granularity;
  /** Bucket under test; defaults to the most recently completed one. */
  asOf?: Date;
  baselineBuckets?: number;
}

export interface DetectionResult extends Detection {
  scopeType: ScopeType;
  scopeId: string;
  window: TimeWindow;
}

export async function runDetection(
  db: Database,
  engine: MetricEngine,
  req: DetectionRunRequest,
): Promise<DetectionResult[]> {
  const granularity = req.granularity ?? 'day';
  const baselineBuckets = req.baselineBuckets ?? 30;
  const asOf = req.asOf ?? new Date();
  const metrics = req.metrics ?? METRIC_IDS;

  const bucketMs = granularity === 'day' ? MS_PER_DAY : granularity === 'week' ? 7 * MS_PER_DAY : 30 * MS_PER_DAY;
  // Test the last *complete* bucket: a partial day always looks like a drop.
  const currentStart = new Date(bucketStart(asOf, granularity).getTime() - bucketMs);
  const currentWindow: TimeWindow = {
    from: currentStart.toISOString(),
    to: new Date(currentStart.getTime() + bucketMs).toISOString(),
  };
  const historyWindow: TimeWindow = {
    from: new Date(currentStart.getTime() - baselineBuckets * bucketMs).toISOString(),
    to: currentStart.toISOString(),
  };

  const out: DetectionResult[] = [];
  for (const scope of req.scopes) {
    for (const metric of metrics) {
      const def = requireMetricDefinition(metric);
      if (!def.supportedScopes.includes(scope.scopeType)) continue;

      const base = { orgId: req.orgId, metric, scopeType: scope.scopeType, scopeId: scope.scopeId };
      const history = await engine.series({ ...base, window: historyWindow, granularity });
      const currentSeries = await engine.series({ ...base, window: currentWindow, granularity });
      const currentPoint = currentSeries[0];
      if (!currentPoint) continue;

      const toObs = (p: (typeof history)[number]): BucketObservation => ({
        bucketStart: p.bucketStart,
        value: p.result.status === 'ok' ? p.result.value : bucketValue(p),
        sampleSize: p.result.sampleSize,
        numerator: p.numerator,
        denominator: p.denominator,
      });

      const detection = detect({
        metric,
        aggregation: def.aggregation,
        direction: def.direction,
        history: history.map(toObs),
        current: toObs(currentPoint),
      });
      if (detection) out.push({ ...detection, scopeType: scope.scopeType, scopeId: scope.scopeId, window: currentWindow });
    }
  }
  return out;
}

/**
 * A bucket below a metric's reporting minimum still carries information for a
 * baseline: the underlying ratio exists even when we decline to publish it as
 * a headline. The detector weighs it by its sample size.
 */
function bucketValue(p: { numerator: number | null; denominator: number | null }): number | null {
  if (p.numerator === null || !p.denominator) return null;
  return p.numerator / p.denominator;
}

export async function persistDetections(db: Database, orgId: string, detections: DetectionResult[]): Promise<number> {
  const anomalies = detections.filter((d) => d.isAnomaly);
  if (anomalies.length === 0) return 0;
  await db.withOrg(orgId, async (sql) => {
    for (const d of anomalies) {
      await sql.query(
        `insert into anomalies (id, org_id, metric, scope_type, scope_id, window_start, window_end,
            observed_value, baseline_value, score, direction, severity, confidence, sample_size, baseline_sample_size)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         on conflict (org_id, metric, scope_type, scope_id, window_start, window_end)
         do update set observed_value = excluded.observed_value,
                       baseline_value = excluded.baseline_value,
                       score = excluded.score,
                       severity = excluded.severity,
                       confidence = excluded.confidence,
                       sample_size = excluded.sample_size,
                       baseline_sample_size = excluded.baseline_sample_size`,
        [
          stableId('anomaly', orgId, d.metric, d.scopeType, d.scopeId, d.window.from),
          orgId, d.metric, d.scopeType, d.scopeId, d.window.from, d.window.to,
          d.observedValue, d.baselineValue, d.score, d.direction, d.severity, d.confidence,
          d.sampleSize, d.baselineSampleSize,
        ],
      );
    }
  });
  return anomalies.length;
}
