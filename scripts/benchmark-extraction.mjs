// Public-network measurements only. Synthetic fixtures have a separate runner.
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fetchArticleHtml, extractArticle } from '../article.mjs';
import { renderArticleHtml } from '../renderer-client.mjs';
import { firecrawlArticleHtml } from '../firecrawl-client.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const cases = [
  { id: 'static', category: 'ordinary static article', url: 'https://www.paulgraham.com/greatwork.html', title: 'How to Do Great Work', anchors: ['work', 'curiosity'], minCharacters: 10000 },
  { id: 'react', category: 'framework blog (hydration; not proof of client-only content)', url: 'https://react.dev/blog/2024/12/05/react-19', title: 'React v19', anchors: ['Actions', 'useActionState'], minCharacters: 10000 },
  { id: 'client-rendered', category: 'public client-only demo, NOT a publisher article', url: 'https://quotes.toscrape.com/js/', title: 'Quotes to Scrape', anchors: ['Albert Einstein', 'Jane Austen'], minCharacters: 1000 },
  { id: 'chrome', category: 'developer article', url: 'https://developer.chrome.com/blog/new-in-chrome-131', title: 'Chrome 131', anchors: ['CSS', '131'], minCharacters: 1000 },
  { id: 'angular', category: 'publisher access block locally', url: 'https://blog.angular.dev/an-update-on-angulars-typescript-7-powered-compiler-9619a35e2b0a', title: 'TypeScript 7-powered Compiler', anchors: ['Alex Rickabaugh', 'oxc'], minCharacters: 8000 },
  { id: 'not-found', category: 'negative HTTP 404 control', url: 'https://developer.chrome.com/blog/chrome-131', title: '', anchors: [], minCharacters: 1, negative: true },
];
const args = process.argv.slice(2);
const output = resolve(args.find(a => a.startsWith('--output='))?.slice(9) || resolve(root, 'docs/benchmarks/local-extraction.json'));
const providers = args.includes('--firecrawl') ? ['firecrawl'] : ['direct', 'local-renderer'];
const endpoint = process.env.ARTICLE_RENDERER_URL || 'http://127.0.0.1:3002/render';
const lock = JSON.parse(await readFile(resolve(root, 'package-lock.json'), 'utf8'));
const report = { measuredAt: new Date().toISOString(), revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim(), workingTree: 'uncommitted benchmark revision; see accompanying diff', node: process.version,
  versions: Object.fromEntries(['@playwright/test', '@mozilla/readability', 'jsdom'].map(p => [p, lock.packages[`node_modules/${p}`].version])),
  rendererImage: process.env.RENDERER_IMAGE_ID || 'not supplied', note: 'Sequential single samples, no retries. Latency includes transport and Readability. Success requires source HTTP 2xx, title/content anchors and minimum length; not a human completeness assessment.', records: [] };
await mkdir(dirname(output), { recursive: true });
for (const item of cases) for (const provider of providers) {
  const record = { id: item.id, category: item.category, source: item.url, provider, providerVersion: provider === 'firecrawl' ? 'API v2; hosted backend version undisclosed' : provider === 'local-renderer' ? report.versions['@playwright/test'] : process.version,
    status: 'error', transportStatus: null, sourceStatus: null, title: null, characters: 0, validation: { expectedTitle: item.title, anchors: item.anchors, minCharacters: item.minCharacters, passed: false } };
  const start = performance.now();
  try {
    let page;
    if (provider === 'firecrawl') {
      record.authentication = process.env.FIRECRAWL_API_KEY ? 'environment key' : 'no key';
      page = await firecrawlArticleHtml(item.url, { transport: async (...args) => {
        const response = await fetch(...args); record.transportStatus = response.status; return response;
      } });
      record.sourceStatus = page.statusCode;
      record.providerTitle = page.title;
    } else if (provider === 'direct') {
      page = await fetchArticleHtml(item.url, { signal: AbortSignal.timeout(17000) });
      record.sourceStatus = '2xx (exact status not exposed)'; // fetchArticleHtml accepts only 2xx.
    } else {
      page = await renderArticleHtml(item.url, { endpoint, transport: async (...args) => {
        const response = await fetch(...args); record.transportStatus = response.status; return response;
      } });
      // Current renderer returns HTML only after a successful main response;
      // exact publisher status is not exposed by the API.
      record.sourceStatus = '2xx (exact status not exposed)';
    }
    const article = extractArticle(page.html, page.url, { title: page.title });
    record.title = article.title; record.characters = article.text.length;
    record.finalUrl = article.url; record.textSha256 = createHash('sha256').update(article.text).digest('hex');
    record.opening = article.text.slice(0, 300); record.closing = article.text.slice(-300);
    record.validation.titleMatched = article.title.toLowerCase().includes(item.title.toLowerCase());
    record.validation.anchorMatches = item.anchors.map(anchor => ({ anchor, found: article.text.toLowerCase().includes(anchor.toLowerCase()) }));
    record.validation.passed = !item.negative && record.validation.titleMatched && record.validation.anchorMatches.every(a => a.found) && article.text.length >= item.minCharacters;
    record.status = record.validation.passed ? 'validated-content' : 'content-validation-failed';
  } catch (error) {
    record.error = error.message;
    const status = error.message.match(/HTTP (\d{3})/); if (status) record.sourceStatus = Number(status[1]);
    if (item.negative && record.sourceStatus === 404) record.status = 'expected-not-found';
  }
  record.latencyMs = Math.round(performance.now() - start);
  report.records.push(record);
  // Save each completed case so an interrupted bounded run retains evidence.
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(record));
}
