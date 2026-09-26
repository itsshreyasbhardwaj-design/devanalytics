import type { Database } from '@devanalytics/db';
import type { MetricEngine } from '@devanalytics/metrics';
import { Investigator } from '@devanalytics/investigations';
import { EvidenceCollector, type EvidenceBundle } from './evidence.js';
import { Explainer, type Answer } from './explain.js';
import { DisabledLlmClient, type LlmClient } from './llm.js';
import { planQuestion, type AnalyticsPlan, type PlannerContext } from './planner.js';

/**
 * The AI surface, end to end:
 *
 *   question -> plan -> analytics engine -> evidence -> answer
 *
 * Note what is absent: at no point is a schema, a table, or a row dump handed
 * to a model. The model, if configured, sees a numbered list of verified facts.
 */
export class AiService {
  private readonly collector: EvidenceCollector;
  private readonly explainer: Explainer;

  constructor(
    private readonly db: Database,
    private readonly engine: MetricEngine,
    llm: LlmClient = new DisabledLlmClient(),
    investigator?: Investigator,
  ) {
    this.collector = new EvidenceCollector(db, engine, investigator ?? new Investigator(db, engine));
    this.explainer = new Explainer(llm);
  }

  async plannerContext(orgId: string): Promise<PlannerContext> {
    return this.db.withOrg(orgId, async (sql) => {
      const repositories = await sql.many<{ id: string; full_name: string }>(`select id, full_name from repositories order by full_name`);
      const teams = await sql.many<{ id: string; name: string }>(`select id, name from teams order by name`);
      return {
        orgId,
        repositories: repositories.map((r) => ({ id: r.id, fullName: r.full_name })),
        teams,
      };
    }, 'readonly');
  }

  async ask(orgId: string, question: string, now?: Date): Promise<Answer & { plan: AnalyticsPlan; evidence: EvidenceBundle }> {
    const ctx = await this.plannerContext(orgId);
    const plan = planQuestion(question, now ? { ...ctx, now } : ctx);
    const evidence = await this.collector.collect(plan);
    const answer = await this.explainer.explain(question, evidence);
    return { ...answer, plan, evidence };
  }
}
