import { expect, test } from '@playwright/test';

/**
 * The journeys this product exists for, end to end against a real instance:
 * connect → ingest → compute → detect → investigate → ask.
 */

test.describe('dashboard', () => {
  test('overview shows computed metrics with sample sizes and labels demo data', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible();

    // Demo data must be labelled on every page, not hidden behind a settings toggle.
    await expect(page.getByText(/Demo data\./)).toBeVisible();
    await expect(page.getByText(/describes no real engineering activity/)).toBeVisible();

    // A metric tile shows a value and the number of observations behind it.
    const tile = page.locator('a[href="/metrics/pr_cycle_time"]').first();
    await expect(tile).toBeVisible();
    await expect(tile).toContainText(/\d/);
    await expect(tile).toContainText(/observations/);
  });

  test('never renders a bare zero where data is insufficient', async ({ page }) => {
    // A one-day window on a 90-day dataset leaves most metrics below their minimum.
    await page.goto('/?period=1d');
    await expect(page.getByText('Insufficient data').first()).toBeVisible();
    await expect(page.getByText(/observations needed/).first()).toBeVisible();
  });

  test('global filters change the numbers and stay in the URL', async ({ page }) => {
    await page.goto('/?period=90d');
    const tile = page.locator('a[href="/metrics/pr_cycle_time"]').first();
    const ninetyDays = await tile.innerText();

    await page.selectOption('select >> nth=0', '7d');
    await page.waitForURL(/period=7d/);
    await expect(page.locator('a[href="/metrics/pr_cycle_time"]').first()).not.toHaveText(ninetyDays);
  });

  test('metric page publishes the contract and drills down to observations', async ({ page }) => {
    await page.goto('/metrics/pr_cycle_time?period=90d');

    await expect(page.getByRole('heading', { name: 'PR cycle time', level: 1 })).toBeVisible();
    await expect(page.getByText(/pull_requests\.merged_at/)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'History' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Underlying observations' })).toBeVisible();

    // Gaps are reported, never filled.
    await expect(page.getByText(/periods have enough data to report/)).toBeVisible();
  });

  test('metric catalogue documents every metric', async ({ page }) => {
    await page.goto('/metrics');
    await expect(page.getByRole('heading', { name: 'Metrics', level: 1 })).toBeVisible();
    await expect(page.getByText('Formula').first()).toBeVisible();
    await expect(page.getByText('Caveats').first()).toBeVisible();
    // Fifteen metric cards.
    await expect(page.locator('a[href^="/metrics/"]')).toHaveCount(15);
  });

  test('repository health is named metrics, not one score', async ({ page }) => {
    await page.goto('/repositories?period=90d');
    await expect(page.getByRole('heading', { name: 'Repositories', level: 1 })).toBeVisible();

    await page.locator('a[href^="/repositories/"]').first().click();
    await expect(page.getByRole('heading', { name: 'Health' })).toBeVisible();
    await expect(page.getByText('PR cycle time').first()).toBeVisible();
    await expect(page.getByText('Build success rate').first()).toBeVisible();
    await expect(page.getByText(/^Score$|^Grade$/)).toHaveCount(0);
  });

  test('pull request page shows an ordered timeline', async ({ page }) => {
    await page.goto('/pull-requests?period=90d');
    await expect(page.getByRole('heading', { name: 'Pull requests', level: 1 })).toBeVisible();

    await page.locator('a[href^="/pull-requests/"]').first().click();
    await expect(page.getByRole('heading', { name: 'Timeline' })).toBeVisible();
    await expect(page.getByText('Cycle time')).toBeVisible();
    await expect(page.getByText('Time to first review')).toBeVisible();
  });

  test('shows GitLab merge requests alongside GitHub pull requests', async ({ page }) => {
    await page.goto('/pull-requests?period=30d');
    // Both providers appear in one list, under one set of metrics.
    await expect(page.getByText(/northwind-robotics\/ledger/).first()).toBeVisible();
    await expect(page.getByText(/northwind\/(checkout|catalog|identity|infra)/).first()).toBeVisible();
  });

  test('says "not reported" for sizes GitLab does not send, never zero', async ({ page }) => {
    await page.goto('/pull-requests?period=30d');
    const notReported = page.getByText('not reported').first();
    await expect(notReported).toBeVisible();

    // The row must not be showing a zero instead.
    const row = page.locator('tr', { has: page.getByText(/northwind-robotics\/ledger/) }).first();
    await expect(row).toBeVisible();
    await expect(row.getByText(/^0$/)).toHaveCount(0);
  });

  test('excludes unknown sizes from PR size and reports how many', async ({ page }) => {
    await page.goto('/metrics/pr_size?period=30d');
    await expect(page.getByRole('heading', { name: 'PR size', level: 1 })).toBeVisible();
    // The exclusion banner names the count rather than silently dropping them.
    // The same phrase also appears in the metric's caveats, so match the banner.
    await expect(page.getByText(/\d+ records excluded/)).toBeVisible();
    await expect(page.getByText(/did not report diff statistics/).first()).toBeVisible();
  });

  test('teams page explains why individuals are not ranked', async ({ page }) => {
    await page.goto('/teams?period=90d');
    await expect(page.getByRole('heading', { name: 'Why there are no individual rankings' })).toBeVisible();
  });

  test('anomalies carry severity, confidence and sample sizes', async ({ page }) => {
    await page.goto('/anomalies');
    await expect(page.getByRole('heading', { name: 'Anomalies', level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'How to read these columns' })).toBeVisible();
    await expect(page.getByText(/Severity.*is about size/)).toBeVisible();
  });

  test('investigation decomposes a change and labels associations', async ({ page }) => {
    await page.goto('/investigations?metric=pr_cycle_time&period=30d');

    await expect(page.getByText(/What accounts for the change, by repository/)).toBeVisible();
    // One decomposition table per dimension, so match the first.
    await expect(page.getByText(/Share of change/).first()).toBeVisible();
    await expect(page.getByText(/Own change/).first()).toBeVisible();
    await expect(page.getByText(/Volume shift/).first()).toBeVisible();

    await expect(page.getByRole('heading', { name: 'Associated metrics' })).toBeVisible();
    await expect(page.getByText(/not causes/).first()).toBeVisible();
    await expect(page.getByText(/correlation here is a reason to go/)).toBeVisible();

    // No causal language anywhere on the page.
    const body = (await page.locator('body').innerText()).toLowerCase();
    for (const phrase of ['caused by', 'because of', 'due to', 'led to', 'resulted in']) {
      expect(body, `investigation page contains causal phrase "${phrase}"`).not.toContain(phrase);
    }
  });

  test('data explorer exposes raw events and pipeline state', async ({ page }) => {
    await page.goto('/explorer');
    await expect(page.getByRole('heading', { name: 'Data explorer', level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Events by type' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Webhook deliveries' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Queue' })).toBeVisible();
  });

  test('command palette searches repositories and pull requests', async ({ page }) => {
    await page.goto('/');
    // Ensure the document has focus before sending the shortcut.
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('ControlOrMeta+k');

    const dialog = page.getByRole('dialog', { name: 'Command palette' });
    await expect(dialog).toBeVisible();

    await page.getByLabel('Search').fill('checkout');
    await expect(dialog.getByText('northwind/checkout').first()).toBeVisible();

    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/repositories\//);
  });

  test('ask answers from evidence with verified figures', async ({ page }) => {
    await page.goto('/ask');

    // The form is server-rendered and then hydrated. A value typed before
    // React attaches is discarded when it takes control of the textarea, so
    // retry until the value sticks — that is also the signal that the page is
    // interactive.
    const question = page.getByLabel('Question');
    const text = 'Why did PR cycle time increase over the last 30 days?';
    await expect(async () => {
      await question.fill(text);
      await expect(question).toHaveValue(text);
    }).toPass({ timeout: 30_000 });

    // Assert at the network level so a failure says whether the request was
    // never made, was rejected, or returned something the UI did not render.
    const [response] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/v1/ai/query'), { timeout: 60_000 }),
      page.getByRole('button', { name: 'Ask', exact: true }).click(),
    ]);
    expect(response.status(), await response.text()).toBe(200);

    const body = (await response.json()) as { data: { grounding: { grounded: boolean }; citations: unknown[] } };
    expect(body.data.grounding.grounded).toBe(true);
    expect(body.data.citations.length).toBeGreaterThan(0);

    await expect(page.getByRole('heading', { name: 'Answer' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/figures verified/)).toBeVisible();
    await expect(page.getByText('assembled from evidence')).toBeVisible();
    await expect(page.getByRole('heading', { name: /^Evidence \(\d+\)$/ })).toBeVisible();
    await expect(page.getByText(/^F1$/)).toBeVisible();
  });

  test('example prompts are offered', async ({ page }) => {
    await page.goto('/ask');
    await expect(page.getByRole('button', { name: 'What changed in CI reliability?' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'What patterns do you see in our failed builds?' })).toBeVisible();
  });

  test('ask declines questions about things it does not measure', async ({ page }) => {
    await page.goto('/ask');
    const question = page.getByLabel('Question');
    await expect(async () => {
      await question.fill('Which engineer is the most productive?');
      await expect(question).toHaveValue('Which engineer is the most productive?');
    }).toPass({ timeout: 30_000 });
    const [response] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/v1/ai/query'), { timeout: 60_000 }),
      page.getByRole('button', { name: 'Ask', exact: true }).click(),
    ]);
    expect(response.status(), await response.text()).toBe(200);
    await expect(page.getByText(/Unable to answer/)).toBeVisible({ timeout: 30_000 });
  });
});

test.describe('api', () => {
  test('health and openapi are public', async ({ request }) => {
    expect((await request.get('/api/v1/health')).status()).toBe(200);
    const doc = await (await request.get('/api/v1/openapi.json')).json();
    expect(doc.data.openapi).toBe('3.1.0');
    expect(Object.keys(doc.data.paths).length).toBeGreaterThan(20);
  });

  test('metric endpoints require credentials', async ({ playwright, baseURL }) => {
    // A context with no Authorization header, unlike the rest of the suite.
    // `extraHTTPHeaders` from the config's `use` block is inherited unless it
    // is explicitly cleared here.
    const anonymous = await playwright.request.newContext({ baseURL: baseURL as string, extraHTTPHeaders: {} });
    const res = await anonymous.get('/api/v1/metrics/pr_cycle_time/value');
    expect(res.status()).toBe(401);
    await anonymous.dispose();
  });

  test('an authenticated metric read returns a typed result', async ({ request }) => {
    const res = await request.get('/api/v1/metrics/pr_cycle_time/value?period=90d');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(['ok', 'insufficient_data']).toContain(body.data.result.status);
    expect(body.data.result.sampleSize).toBeGreaterThanOrEqual(0);
    expect(body.data.definition.formula.length).toBeGreaterThan(10);
  });

  test('a webhook with no signature is rejected', async ({ request }) => {
    const res = await request.post('/api/v1/webhooks/github/anything', {
      headers: { 'x-github-event': 'pull_request' },
      data: { action: 'opened' },
    });
    expect(res.status()).toBe(401);
  });
});

test.describe('accessibility', () => {
  test('pages are keyboard navigable and expose landmarks', async ({ page }) => {
    await page.goto('/');

    await expect(page.locator('main#main')).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Sections' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Global filters' })).toBeVisible();

    // A skip link is the first focusable element.
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  });

  test('the current section is marked for assistive technology', async ({ page }) => {
    await page.goto('/repositories');
    await expect(page.getByRole('link', { name: 'Repositories' })).toHaveAttribute('aria-current', 'page');
  });

  test('filter toggles expose their pressed state', async ({ page }) => {
    await page.goto('/');
    const bots = page.getByRole('button', { name: /Bots (excluded|included)/ });
    await expect(bots).toHaveAttribute('aria-pressed', 'true');
    await bots.click();
    await page.waitForURL(/excludeBots=false/);
    await expect(page.getByRole('button', { name: /Bots included/ })).toHaveAttribute('aria-pressed', 'false');
  });
});
