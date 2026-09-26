import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MS_PER_DAY } from '@devanalytics/core';
import type { Database } from '@devanalytics/db';
import { MetricEngine } from '@devanalytics/metrics';
import { AiService, type LlmClient } from '@devanalytics/ai';
import { generateDemoOrganization, type GenerateResult } from '@devanalytics/demo-data';
import { testDatabase } from '../helpers/db.js';

class ScriptedLlm implements LlmClient {
  readonly available = true;
  readonly model = 'scripted/test';
  calls: string[] = [];
  constructor(private readonly reply: string) {}
  async complete(messages: { role: string; content: string }[]): Promise<string> {
    this.calls.push(messages.map((m) => m.content).join('\n---\n'));
    return this.reply;
  }
}

describe('AI investigation grounded in real evidence', () => {
  let db: Database;
  let engine: MetricEngine;
  let demo: GenerateResult;

  beforeAll(async () => {
    db = await testDatabase();
    demo = await generateDemoOrganization(db, { days: 120, seed: 11 });
    engine = new MetricEngine(db);
  }, 300_000);

  afterAll(async () => {
    await db.close();
  });

  const asOf = () => new Date(new Date('2026-09-01T00:00:00Z').getTime() - 4 * MS_PER_DAY);

  it('answers a why-question with citations, without any model configured', async () => {
    const ai = new AiService(db, engine);
    const answer = await ai.ask(demo.orgId, 'Why did PR cycle time increase over the last 30 days?', asOf());

    expect(answer.generatedBy).toBe('deterministic');
    expect(answer.model).toBeNull();
    expect(answer.plan.metric).toBe('pr_cycle_time');
    expect(answer.citations.length).toBeGreaterThan(3);
    expect(answer.grounding.grounded).toBe(true);

    // Every citation names its scope, window and sample size.
    for (const c of answer.citations) {
      expect(c.window.from).toMatch(/^\d{4}-\d{2}-\d{2}/);
      expect(c.scope.length).toBeGreaterThan(0);
      expect(c.sampleSize).toBeGreaterThanOrEqual(0);
    }
    expect(answer.answer).toMatch(/arithmetic decomposition/);
    expect(answer.answer).toMatch(/association, not cause/);
  });

  it('cites the repository that actually moved', async () => {
    const ai = new AiService(db, engine);
    const answer = await ai.ask(demo.orgId, 'Which repositories contributed most to the cycle time increase in the last 30 days?', asOf());
    const contributions = answer.citations.filter((c) => c.kind === 'contribution');
    expect(contributions.length).toBeGreaterThan(0);
    expect(contributions[0]?.scope).toBe('northwind/checkout');
    expect(contributions[0]?.href).toMatch(/^\/repositories\//);
  });

  it('says so when the data is insufficient instead of estimating', async () => {
    const ai = new AiService(db, engine);
    // A one-day window at the very start of history has almost nothing in it.
    const answer = await ai.ask(demo.orgId, 'What is our reopened PR rate today?', new Date(demo.windowStart));
    expect(answer.insufficientData).toBe(true);
    expect(answer.answer).toMatch(/Insufficient data/);
    expect(answer.notes.some((n) => /observations/.test(n))).toBe(true);
  });

  it('declines questions about things it does not measure', async () => {
    const ai = new AiService(db, engine);
    const answer = await ai.ask(demo.orgId, 'Which engineer is the most productive?', asOf());
    expect(answer.plan.intent).toBe('unknown');
    expect(answer.answer).toMatch(/Unable to answer/);
    expect(answer.citations).toEqual([]);
  });

  it('discards a model answer that invents a statistic', async () => {
    const liar = new ScriptedLlm('Cycle time rose 87.4% and 512 pull requests were affected.');
    const ai = new AiService(db, engine, liar);
    const answer = await ai.ask(demo.orgId, 'Why did PR cycle time increase over the last 30 days?', asOf());

    expect(liar.calls.length).toBe(1);
    expect(answer.generatedBy).toBe('deterministic');
    expect(answer.modelRejected?.reason).toMatch(/figures absent from the evidence/);
    expect(answer.modelRejected?.unsupported.length).toBeGreaterThan(0);
    expect(answer.answer).not.toContain('87.4');
  });

  it('discards a model answer that claims causation', async () => {
    const ai0 = new AiService(db, engine);
    const grounded = await ai0.ask(demo.orgId, 'Why did PR cycle time increase over the last 30 days?', asOf());
    const realNumber = grounded.citations[0]?.values[0];
    expect(realNumber).toBeTypeOf('number');

    const causal = new ScriptedLlm(`Cycle time is ${realNumber} hours, which was caused by slower reviews.`);
    const ai = new AiService(db, engine, causal);
    const answer = await ai.ask(demo.orgId, 'Why did PR cycle time increase over the last 30 days?', asOf());
    expect(answer.generatedBy).toBe('deterministic');
    expect(answer.modelRejected?.reason).toMatch(/causal claim/);
  });

  it('accepts a model answer that only restates verified facts', async () => {
    const ai0 = new AiService(db, engine);
    const grounded = await ai0.ask(demo.orgId, 'Why did PR cycle time increase over the last 30 days?', asOf());
    const value = grounded.citations[0]?.values[0] as number;
    const sample = grounded.citations[0]?.sampleSize as number;

    const honest = new ScriptedLlm(`Cycle time is ${value.toFixed(1)} hours across ${sample} observations [F1]. northwind/checkout accounts for most of the change.`);
    const ai = new AiService(db, engine, honest);
    const answer = await ai.ask(demo.orgId, 'Why did PR cycle time increase over the last 30 days?', asOf());
    expect(answer.generatedBy).toBe('model');
    expect(answer.model).toBe('scripted/test');
    expect(answer.modelRejected).toBeNull();
    expect(answer.grounding.grounded).toBe(true);
  });

  it('never hands the model raw rows or a schema', async () => {
    const spy = new ScriptedLlm('ok');
    const ai = new AiService(db, engine, spy);
    await ai.ask(demo.orgId, 'Why did PR cycle time increase over the last 30 days?', asOf());
    const prompt = spy.calls[0] as string;
    expect(prompt).toMatch(/VERIFIED FACTS/);
    expect(prompt).not.toMatch(/create table|select .* from |org_id|pull_requests\./i);
    // Bounded: the evidence bundle is dozens of facts, not a data dump.
    expect(prompt.length).toBeLessThan(20_000);
  });

  it('describes failure patterns from real CI rows', async () => {
    const ai = new AiService(db, engine);
    const answer = await ai.ask(demo.orgId, 'What patterns do you see in our failed builds over the last 90 days?', asOf());
    expect(answer.plan.intent).toBe('failure_patterns');
    const records = answer.citations.filter((c) => c.kind === 'record');
    expect(records.length).toBeGreaterThan(0);
    expect(records[0]?.statement).toMatch(/failed \d+ of \d+ runs/);
  });
});
