import { lookup } from 'node:dns/promises';
import { ArticleError, validateUrl, publicTarget } from './article.mjs';

// Fixed documented endpoint: never accept a user-configurable managed relay.
export const FIRECRAWL_ENDPOINT = 'https://api.firecrawl.dev/v2/scrape';
const fail = (message, code = 'FIRECRAWL_RESPONSE') => new ArticleError(message, code);

// DNS and body reads must obey the same deadline as the HTTP request.
function bounded(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export async function firecrawlArticleHtml(value, {
  apiKey = process.env.FIRECRAWL_API_KEY, signal, transport = fetch, resolve = lookup,
} = {}) {
  const deadline = AbortSignal.any([AbortSignal.timeout(28_000), ...(signal ? [signal] : [])]);
  deadline.throwIfAborted();
  const input = validateUrl(value);
  await bounded(publicTarget(input, resolve), deadline);
  deadline.throwIfAborted();
  let response;
  try {
    response = await bounded(transport(FIRECRAWL_ENDPOINT, {
      method: 'POST', redirect: 'error', signal: deadline,
      headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({ url: input.href, formats: ['html'], onlyMainContent: true, timeout: 25_000, storeInCache: false }),
    }), deadline);
  } catch (error) {
    deadline.throwIfAborted();
    throw fail('Firecrawl could not be reached. Check connectivity or paste the article text.', 'FIRECRAWL_TRANSPORT');
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    if ([401, 403].includes(response.status)) throw fail('Firecrawl access denied. Check the server-side FIRECRAWL_API_KEY and account permissions.', 'FIRECRAWL_AUTH');
    if (response.status === 402) throw fail('Firecrawl credits are exhausted. Check the account billing or paste the text.', 'FIRECRAWL_CREDITS');
    if (response.status === 429) throw fail('Firecrawl rate limit reached. Try later or paste the text.', 'FIRECRAWL_RATE_LIMIT');
    throw fail(`Firecrawl returned HTTP ${response.status}. Try later or paste the text.`, 'FIRECRAWL_HTTP');
  }
  if (!/^application\/json(?:;|$)/i.test(response.headers.get('content-type') || '') || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw fail('Firecrawl did not return JSON.');
  }
  const reader = response.body.getReader();
  const pieces = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await bounded(reader.read(), deadline);
      if (part.done) break;
      bytes += part.value.length;
      if (bytes > 6_100_000) throw fail('Firecrawl response exceeds the size limit.', 'FIRECRAWL_SIZE');
      pieces.push(part.value);
    }
  } catch (error) {
    deadline.throwIfAborted();
    if (error instanceof ArticleError) throw error;
    throw fail('Firecrawl response was interrupted. Try later or paste the text.', 'FIRECRAWL_TRANSPORT');
  } finally {
    // Abort cancels the fetch; cancel also releases a partially consumed body.
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  deadline.throwIfAborted();
  let result;
  try { result = JSON.parse(Buffer.concat(pieces).toString('utf8')); }
  catch { throw fail('Firecrawl returned invalid JSON.'); }
  const data = result?.data;
  const metadata = data?.metadata;
  if (result?.success !== true || !metadata) throw fail('Firecrawl could not scrape this page. Try another URL or paste the text.');
  if (!Number.isInteger(metadata.statusCode) || metadata.statusCode < 200 || metadata.statusCode >= 300) {
    throw fail(`Firecrawl source returned HTTP ${Number.isInteger(metadata.statusCode) ? metadata.statusCode : 'unknown'}. No article was accepted.`, 'FIRECRAWL_SOURCE');
  }
  if (metadata.error) throw fail('Firecrawl reported a source error. Try another URL or paste the text.', 'FIRECRAWL_SOURCE');
  if (typeof metadata.sourceURL !== 'string' || validateUrl(metadata.sourceURL).href !== input.href) throw fail('Firecrawl source URL does not match the requested page.');
  await bounded(publicTarget(validateUrl(metadata.sourceURL), resolve), deadline);
  const finalUrl = metadata.url === undefined ? input : validateUrl(metadata.url);
  await bounded(publicTarget(finalUrl, resolve), deadline);
  if (typeof data.html !== 'string') throw fail('Firecrawl did not return actual HTML.');
  if (Buffer.byteLength(data.html) > 3_000_000) throw fail('Firecrawl HTML exceeds the 3 MB limit.', 'FIRECRAWL_SIZE');
  if (metadata.title !== undefined && (typeof metadata.title !== 'string' || metadata.title.length > 1_000)) throw fail('Firecrawl returned an invalid title.');
  deadline.throwIfAborted();
  return { html: data.html, url: finalUrl.href, title: metadata.title || '', statusCode: metadata.statusCode };
}
