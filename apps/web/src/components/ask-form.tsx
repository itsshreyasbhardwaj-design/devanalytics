'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from '@devanalytics/ui';
import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';

interface Citation {
  id: string;
  kind: string;
  metric: string | null;
  scope: string;
  window: { from: string; to: string };
  statement: string;
  sampleSize: number;
  href: string | null;
}

interface Answer {
  interpretation: string;
  answer: string;
  citations: Citation[];
  generatedBy: 'deterministic' | 'model';
  model: string | null;
  grounding: { grounded: boolean; unsupported: number[]; checked: number };
  modelRejected: { reason: string; unsupported: number[] } | null;
  confidence: string;
  notes: string[];
  insufficientData: boolean;
}

const EXAMPLES = [
  'Why did PR cycle time increase over the last 30 days?',
  'Which repositories contributed most to the increase?',
  'What changed in CI reliability?',
  'What patterns do you see in our failed builds?',
  'What is our deployment frequency this quarter?',
];

export function AskForm() {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const ask = async (q: string) => {
    setLoading(true);
    setError(null);
    setAnswer(null);
    try {
      const res = await fetch('/api/v1/ai/query', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: q }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body?.error?.message ?? `Request failed with ${res.status}`);
        return;
      }
      setAnswer(body.data as Answer);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardContent>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (question.trim()) void ask(question.trim());
            }}
            className="flex flex-col gap-3"
          >
            <label htmlFor="question" className="text-xs font-medium uppercase tracking-wider text-slate-500">
              Question
            </label>
            <textarea
              id="question"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              rows={3}
              maxLength={1000}
              placeholder="Why did PR cycle time increase over the last 30 days?"
              className="w-full resize-y rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600"
            />
            <div className="flex items-center gap-2">
              <Button type="submit" disabled={loading || !question.trim()}>
                {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
                {loading ? 'Computing' : 'Ask'}
              </Button>
              <span className="text-[11px] text-slate-500">Answers are computed from ingested data, not generated from memory.</span>
            </div>
          </form>

          <div className="mt-4 flex flex-wrap gap-1.5">
            {EXAMPLES.map((ex) => (
              <button
                key={ex}
                type="button"
                onClick={() => { setQuestion(ex); void ask(ex); }}
                className="rounded-full border border-slate-800 px-2.5 py-1 text-[11px] text-slate-400 hover:border-slate-600 hover:text-slate-200"
              >
                {ex}
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {error && (
        <Card className="border-rose-900/60 bg-rose-950/20">
          <CardContent className="text-xs text-rose-200">{error}</CardContent>
        </Card>
      )}

      {answer && (
        <>
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle>Answer</CardTitle>
                <Badge tone={answer.generatedBy === 'model' ? 'info' : 'muted'}>
                  {answer.generatedBy === 'model' ? `phrased by ${answer.model}` : 'assembled from evidence'}
                </Badge>
                <Badge tone={answer.grounding.grounded ? 'good' : 'bad'}>
                  {answer.grounding.grounded ? (
                    <><CheckCircle2 className="h-3 w-3" aria-hidden /> {answer.grounding.checked} figures verified</>
                  ) : (
                    <><AlertTriangle className="h-3 w-3" aria-hidden /> unverified figures</>
                  )}
                </Badge>
                {answer.insufficientData && <Badge tone="warn">insufficient data</Badge>}
              </div>
              <p className="text-xs text-slate-500">Interpreted as: {answer.interpretation}</p>
            </CardHeader>
            <CardContent>
              <div className="prose-sm max-w-none whitespace-pre-wrap text-sm leading-relaxed text-slate-300">{answer.answer}</div>
            </CardContent>
          </Card>

          {answer.modelRejected && (
            <Card className="border-amber-900/60 bg-amber-950/20">
              <CardContent className="text-xs text-amber-200">
                <strong>A generated answer was discarded.</strong> {answer.modelRejected.reason}
                {answer.modelRejected.unsupported.length > 0 && (
                  <> Unsupported figures: {answer.modelRejected.unsupported.join(', ')}.</>
                )}{' '}
                The answer above was assembled directly from the evidence instead.
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Evidence ({answer.citations.length})</CardTitle>
              <p className="text-xs text-slate-500">Every fact the answer is allowed to use, with its scope, window and sample size.</p>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              {answer.citations.map((c, i) => (
                <div key={c.id} className="rounded-lg border border-slate-800 px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
                    <span className="font-mono text-slate-400">F{i + 1}</span>
                    <Badge tone="muted">{c.kind}</Badge>
                    <span className="truncate">{c.scope}</span>
                    <span className="font-mono">{c.window.from.slice(0, 10)} → {c.window.to.slice(0, 10)}</span>
                    <span>{c.sampleSize} obs</span>
                    {c.href && <Link href={c.href} className="ml-auto text-sky-400 hover:underline">open</Link>}
                  </div>
                  <p className="mt-1 text-xs text-slate-300">{c.statement}</p>
                </div>
              ))}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
