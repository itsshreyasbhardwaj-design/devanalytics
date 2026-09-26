import { AskForm } from '@/components/ask-form';
import { PageHeader } from '@/components/page-header';
import { Card, CardContent, CardHeader, CardTitle, EmptyState } from '@devanalytics/ui';
import { getSession } from '@/lib/session';
import { getRuntime } from '@/lib/runtime';

export const dynamic = 'force-dynamic';

export default async function AskPage() {
  const session = await getSession();
  if (session.empty) return <EmptyState title="No organization yet" description="Connect a repository under Settings." />;

  const runtime = await getRuntime();
  const llmConfigured = Boolean(runtime.config.openRouterApiKey);

  return (
    <>
      <PageHeader
        title="Ask"
        description="Questions are turned into a structured analytics query over the metric registry, executed by the same engine as the dashboard, and answered from the values it computed. Every claim cites the metric, scope, window and sample size behind it."
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <AskForm />
        </div>

        <Card className="h-fit">
          <CardHeader><CardTitle>How this works</CardTitle></CardHeader>
          <CardContent className="flex flex-col gap-3 text-xs leading-relaxed text-slate-400">
            <ol className="ml-4 list-decimal space-y-1.5">
              <li>Your question is mapped to one of a fixed set of intents and a metric that exists in the registry.</li>
              <li>The analytics engine runs that query. No model writes a database query.</li>
              <li>The results become a numbered list of verified facts.</li>
              <li>The answer is assembled from those facts, and every number in it is checked against them.</li>
            </ol>
            <p>
              {llmConfigured
                ? 'A language model is configured and will phrase the answer. Its output is discarded if it contains a figure absent from the evidence or makes a causal claim, and the assembled answer is shown instead.'
                : 'No language model is configured, so answers are assembled directly from the evidence. This is the default and costs nothing; set OPENROUTER_API_KEY to add narration.'}
            </p>
            <p className="text-slate-400">
              The platform declines questions about things it does not measure rather than guessing.
            </p>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
