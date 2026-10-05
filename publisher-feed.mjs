import { JSDOM } from 'jsdom';
import { validateUrl, publicTarget, requestPage, extractArticle } from './article.mjs';

const FEED = 'https://blog.angular.dev/feed';
const MAX_BYTES = 3_000_000;
export function publisherFeed(value) {
  const url = validateUrl(value);
  return url.origin === 'https://blog.angular.dev' && url.pathname !== '/' && url.pathname !== '/feed' && !url.search && !url.hash ? FEED : undefined;
}

// Race even DNS and injected transports against the deadline; remove listeners
// on both success and failure. The real HTTP transport also destroys its socket.
async function bounded(work, signal) {
  signal.throwIfAborted();
  let abort;
  try {
    return await Promise.race([work(), new Promise((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    })]);
  } finally { if (abort) signal.removeEventListener('abort', abort); }
}

export function articleFromFeed(xml, value) {
  if (Buffer.byteLength(xml) > MAX_BYTES) throw new Error('Publisher feed exceeds the 3 MB limit.');
  // No DTDs or entities of any kind: XML parsing never fetches resources, and
  // explicit rejection also precludes internal entity expansion attacks.
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Publisher feed DTD/entities are forbidden.');
  let dom;
  try {
    dom = new JSDOM(xml, { contentType: 'application/xml' });
    const document = dom.window.document;
    if (document.getElementsByTagName('*').length > 50_000) throw new Error('Publisher feed element limit exceeded.');
    if (document.documentElement.localName !== 'rss') throw new Error('Publisher feed must be RSS.');
    const items = [...document.querySelectorAll('rss > channel > item')];
    // Medium's Angular publication appends this observed, fixed RSS attribution
    // suffix. Strip only that exact publisher token, never arbitrary query keys.
    const canonicalLink = text => text.trim().replace(/\?source=rss----447683c3d9a3---4$/, '');
    const matches = items.filter(item => [...item.children].some(node => node.tagName === 'link' && canonicalLink(node.textContent) === value));
    if (matches.length !== 1) throw new Error('Requested article is absent or ambiguous in the publisher feed.');
    const item = matches[0];
    const contents = item.getElementsByTagNameNS('http://purl.org/rss/1.0/modules/content/', 'encoded');
    if (contents.length !== 1 || !contents[0].textContent.trim()) throw new Error('Publisher feed item has no full content.');
    const html = new JSDOM('<!doctype html><title></title><article></article>', { url: value });
    try {
      html.window.document.querySelector('title').textContent = [...item.children].find(node => node.tagName === 'title')?.textContent || '';
      html.window.document.querySelector('article').innerHTML = contents[0].textContent;
      return { ...extractArticle(html.serialize(), value), source: 'publisher-rss' };
    } finally { html.window.close(); }
  } catch (error) {
    throw new Error(`Publisher feed failed: ${error.message}`);
  } finally { dom?.window.close(); }
}

export async function fetchPublisherArticle(value, { signal, resolve, request = requestPage, deadlineMs = 10_000 } = {}) {
  const feed = publisherFeed(value);
  if (!feed) throw new Error('No allowlisted publisher feed for this URL.');
  const deadline = AbortSignal.any([AbortSignal.timeout(deadlineMs), ...(signal ? [signal] : [])]);
  let url = validateUrl(feed);
  for (let redirects = 0; redirects <= 5; redirects++) {
    // Strict URL and public-IP checks apply before every connection, including
    // redirects. Feed redirects additionally cannot leave the publisher origin.
    const target = await bounded(() => publicTarget(url, resolve), deadline);
    const result = await bounded(() => request(url, target, deadline, MAX_BYTES, {
      accept: 'application/rss+xml,application/xml,text/xml',
      mime: /^(application\/(rss\+xml|xml)|text\/xml)(;|$)/i,
    }), deadline);
    deadline.throwIfAborted();
    if (result.html !== undefined) return articleFromFeed(result.html, value);
    if (!result.redirect) throw new Error('Publisher feed returned an invalid redirect.');
    url = validateUrl(new URL(result.redirect, url).href);
    if (url.origin !== new URL(FEED).origin) throw new Error('Publisher feed redirect left the allowlisted origin.');
  }
  throw new Error('Publisher feed redirected too many times.');
}
