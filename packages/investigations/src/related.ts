/**
 * Candidate explanations per metric.
 *
 * This is domain knowledge, written down: when cycle time moves, these are the
 * things worth looking at, in roughly the order a good engineering lead would
 * look at them. It exists so the investigation examines a fixed, auditable set
 * of hypotheses rather than whatever happened to correlate — which is how you
 * end up "discovering" that deployments rise on Tuesdays.
 *
 * Every candidate is examined and reported, including the ones that turn out
 * to be flat. Reporting only the movers would turn an investigation into a
 * search for a story.
 */
export const RELATED_METRICS: Record<string, string[]> = {
  pr_cycle_time: ['time_to_first_review', 'review_turnaround_time', 'merge_time', 'pr_size', 'review_participation', 'build_duration', 'ci_queue_time'],
  pr_cycle_time_mean: ['time_to_first_review', 'review_turnaround_time', 'merge_time', 'pr_size'],
  time_to_first_review: ['review_participation', 'pr_size', 'review_turnaround_time', 'commit_frequency'],
  review_turnaround_time: ['review_participation', 'pr_size', 'time_to_first_review'],
  merge_time: ['build_duration', 'ci_queue_time', 'build_success_rate', 'review_participation'],
  pr_size: ['commit_frequency', 'pr_cycle_time'],
  build_success_rate: ['build_duration', 'ci_queue_time', 'pr_size', 'commit_frequency'],
  build_duration: ['ci_queue_time', 'build_success_rate', 'pr_size'],
  ci_queue_time: ['build_duration', 'commit_frequency', 'build_success_rate'],
  deployment_frequency: ['pr_cycle_time', 'build_success_rate', 'failed_deployment_rate', 'merge_time'],
  failed_deployment_rate: ['build_success_rate', 'deployment_frequency', 'pr_size', 'lead_time_for_changes'],
  lead_time_for_changes: ['pr_cycle_time', 'deployment_frequency', 'merge_time', 'build_duration'],
  reopened_pr_rate: ['pr_size', 'review_participation', 'time_to_first_review'],
  review_participation: ['time_to_first_review', 'review_turnaround_time', 'pr_cycle_time'],
  commit_frequency: ['pr_size', 'pr_cycle_time'],
};

export function relatedMetrics(metric: string): string[] {
  return RELATED_METRICS[metric] ?? [];
}
