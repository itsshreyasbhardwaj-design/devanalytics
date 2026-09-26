import { describe, it, expect } from 'vitest';
import { planQuestion, type PlannerContext } from '@devanalytics/ai';

const ctx: PlannerContext = {
  orgId: 'org1',
  repositories: [
    { id: 'r1', fullName: 'northwind/checkout' },
    { id: 'r2', fullName: 'northwind/catalog' },
  ],
  teams: [{ id: 't1', name: 'Payments' }],
  now: new Date('2026-09-01T00:00:00Z'),
};

describe('question planning', () => {
  it('maps a why-question to an investigation of the right metric', () => {
    const p = planQuestion('Why did PR cycle time increase?', ctx);
    expect(p.metric).toBe('pr_cycle_time');
    expect(p.intent).toBe('investigate');
    expect(p.scopeType).toBe('org');
    expect(p.confidence).toBe('high');
  });

  it('maps a which-question to contributors along the named dimension', () => {
    const p = planQuestion('Which repositories contributed most to the increase in cycle time?', ctx);
    expect(p.intent).toBe('contributors');
    expect(p.dimension).toBe('repository');

    const byTeam = planQuestion('Which team contributed most to the cycle time increase?', ctx);
    expect(byTeam.dimension).toBe('team');
  });

  it('resolves a repository named in the question', () => {
    const p = planQuestion('What changed in build success rate for northwind/checkout?', ctx);
    expect(p.scopeType).toBe('repository');
    expect(p.scopeId).toBe('r1');
    expect(p.metric).toBe('build_success_rate');
  });

  it('resolves a repository by its short name', () => {
    const p = planQuestion('why is catalog cycle time up', ctx);
    expect(p.scopeId).toBe('r2');
  });

  it('resolves a team named in the question', () => {
    const p = planQuestion('How is cycle time for Payments?', ctx);
    expect(p.scopeType).toBe('team');
    expect(p.scopeId).toBe('t1');
  });

  it('understands CI reliability as build success rate', () => {
    expect(planQuestion('What changed in CI reliability?', ctx).metric).toBe('build_success_rate');
  });

  it('recognises failure-pattern questions', () => {
    const p = planQuestion('What patterns do you see in our failed builds?', ctx);
    expect(p.intent).toBe('failure_patterns');
    expect(p.metric).toBe('build_success_rate');
  });

  it('parses periods from natural phrasing', () => {
    expect(planQuestion('deployment frequency over the last 7 days', ctx).period).toBe('7d');
    expect(planQuestion('deployment frequency last quarter', ctx).period).toBe('90d');
    expect(planQuestion('deployment frequency in the last 45 days', ctx).period).toBe('30d');
    expect(planQuestion('deployment frequency', ctx).period).toBe('30d');
  });

  it('prefers the longest matching metric phrase', () => {
    expect(planQuestion('what is our time to first review', ctx).metric).toBe('time_to_first_review');
    expect(planQuestion('what is our review turnaround', ctx).metric).toBe('review_turnaround_time');
  });

  it('refuses to guess a metric it does not have', () => {
    const p = planQuestion('How happy is the team this sprint?', ctx);
    expect(p.metric).toBeNull();
    expect(p.intent).toBe('unknown');
    expect(p.confidence).toBe('low');
    expect(p.unresolved).toContain('metric');
  });

  it('produces a window that ends at the reference time', () => {
    const p = planQuestion('cycle time last 7 days', ctx);
    expect(p.window.to).toBe('2026-09-01T00:00:00.000Z');
    expect(p.window.from).toBe('2026-08-25T00:00:00.000Z');
  });
});
