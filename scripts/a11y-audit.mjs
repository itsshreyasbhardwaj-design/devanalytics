/**
 * Contrast and semantics audit.
 *
 * Checks every rendered text style against WCAG 2.1 AA (4.5:1 for normal text,
 * 3:1 for large), plus landmarks, heading order and accessible names. Run
 * against a running instance:
 *
 *   node scripts/a11y-audit.mjs http://localhost:3117
 */
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';

const base = process.argv[2] ?? 'http://localhost:3117';
const paths = ['/', '/repositories', '/teams', '/pull-requests', '/ci', '/deployments', '/anomalies', '/investigations?metric=pr_cycle_time', '/metrics', '/metrics/pr_cycle_time', '/ask', '/explorer', '/settings'];

// A token is only needed when auditing an instance that requires one. A
// local-dev instance resolves its own session, and sending a token issued
// against a different database would just fail authentication.
let token = process.env.A11Y_TOKEN ?? '';
if (token === 'seeded') token = readFileSync('tests/e2e/.state/token', 'utf8').trim();

const AUDIT = () => {
  const lum = (rgb) => { const [r, g, b] = rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
  const parse = (s) => (s.match(/\d+/g) || [0, 0, 0]).slice(0, 3).map(Number);
  const bgOf = (el) => { let e = el; while (e) { const bg = getComputedStyle(e).backgroundColor; if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return parse(bg); e = e.parentElement; } return [2, 6, 23]; };

  const contrast = [];
  const seen = new Set();
  for (const el of document.querySelectorAll('body *')) {
    if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 2)) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    const size = parseFloat(cs.fontSize); const weight = Number(cs.fontWeight) || 400;
    const r = ratio(parse(cs.color), bgOf(el));
    const required = size >= 24 || (size >= 18.66 && weight >= 700) ? 3 : 4.5;
    const key = `${cs.color}|${size}|${weight}`;
    if (r < required && !seen.has(key)) { seen.add(key); contrast.push({ color: cs.color, size, weight, ratio: +r.toFixed(2), required, sample: el.textContent.trim().slice(0, 40) }); }
  }

  const levels = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((h) => Number(h.tagName[1]));
  const headingSkips = levels.filter((l, i) => i > 0 && l - levels[i - 1] > 1).length;

  return {
    contrast,
    headingSkips,
    h1Count: document.querySelectorAll('h1').length,
    mainLandmarks: document.querySelectorAll('main').length,
    imagesWithoutAlt: [...document.querySelectorAll('img')].filter((i) => !i.alt).length,
    decorativeSvgsUnmarked: [...document.querySelectorAll('svg')].filter((s) => !s.getAttribute('aria-hidden') && !s.getAttribute('aria-label') && !s.querySelector('title')).length,
    controlsWithoutNames: [...document.querySelectorAll('button,a,input,select,textarea')]
      .filter((el) => !el.textContent.trim() && !el.getAttribute('aria-label') && !el.labels?.length && !el.closest('label')).length,
  };
};

const browser = await chromium.launch();
const context = await browser.newContext(token ? { extraHTTPHeaders: { authorization: `Bearer ${token}` } } : {});
const page = await context.newPage();

let failures = 0;
for (const path of paths) {
  await page.goto(`${base}${path}`, { waitUntil: 'networkidle' });
  const r = await page.evaluate(AUDIT);
  const problems = [];
  if (r.contrast.length) problems.push(`${r.contrast.length} style(s) below contrast minimum`);
  if (r.headingSkips) problems.push(`${r.headingSkips} heading level skip(s)`);
  if (r.h1Count !== 1) problems.push(`${r.h1Count} h1 elements`);
  if (r.mainLandmarks !== 1) problems.push(`${r.mainLandmarks} main landmarks`);
  if (r.imagesWithoutAlt) problems.push(`${r.imagesWithoutAlt} image(s) without alt`);
  if (r.decorativeSvgsUnmarked) problems.push(`${r.decorativeSvgsUnmarked} unlabelled svg(s)`);
  if (r.controlsWithoutNames) problems.push(`${r.controlsWithoutNames} control(s) without an accessible name`);

  if (problems.length) {
    failures++;
    console.log(`FAIL ${path}`);
    for (const p of problems) console.log(`       ${p}`);
    for (const c of r.contrast) console.log(`       ${c.ratio}:1 (needs ${c.required}) ${c.color} ${c.size}px/${c.weight} — "${c.sample}"`);
  } else {
    console.log(`ok   ${path}`);
  }
}

await browser.close();
console.log(failures === 0 ? '\nno accessibility failures' : `\n${failures} page(s) with failures`);
process.exit(failures === 0 ? 0 : 1);
