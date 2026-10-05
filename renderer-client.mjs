import { ArticleError, validateUrl, publicTarget, fetchArticleHtml, extractArticle } from './article.mjs';

export async function renderArticleHtml(value, { endpoint, signal, transport = fetch } = {}) {
  validateUrl(value);
  const deadline = AbortSignal.any([AbortSignal.timeout(28_000), ...(signal ? [signal] : [])]);
  deadline.throwIfAborted();
  const response = await transport(endpoint, { method: 'POST', redirect: 'error',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: value }), signal: deadline });
  let bytes = 0;
  const pieces = [];
  for await (const piece of response.body) {
    bytes += piece.length;
    if (bytes > 6_100_000) { await response.body.cancel().catch(() => {}); throw new Error('Renderer response exceeds the size limit.'); }
    pieces.push(piece);
  }
  const result = JSON.parse(Buffer.concat(pieces).toString());
  if (!response.ok) throw new Error(result.error || `Renderer returned HTTP ${response.status}.`);
  if (typeof result.html !== 'string' || typeof result.url !== 'string' || Buffer.byteLength(result.html) > 3_000_000) throw new Error('Invalid renderer response.');
  await publicTarget(validateUrl(result.url));
  deadline.throwIfAborted();
  return result;
}

export async function loadArticle(value, { signal, fetchPage = fetchArticleHtml, renderPage } = {}) {
  const deadline = AbortSignal.any([AbortSignal.timeout(45_000), ...(signal ? [signal] : [])]);
  try {
    const page = await fetchPage(value, { signal: deadline });
    return extractArticle(page.html, page.url);
  } catch (error) {
    deadline.throwIfAborted();
    // Only explicitly classified publisher blocks or missing readable text.
    // No fallback on URL/DNS/redirect validation, sizes, MIME, auth or transport.
    if (!(error instanceof ArticleError) || !['HTTP_BLOCK', 'RENDER_NEEDED'].includes(error.code)) throw error;
    if (!renderPage) throw error;
    const page = await renderPage(value, { signal: deadline });
    deadline.throwIfAborted();
    return extractArticle(page.html, page.url);
  }
}
