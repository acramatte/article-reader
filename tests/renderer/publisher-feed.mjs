// Manual preparation only: parse a downloaded legitimate publisher RSS file.
// This is not part of the API renderer fallback and never fabricates URL success.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
const source = process.argv[2];
if (!source) throw new Error('Usage: node tests/renderer/publisher-feed.mjs /path/to/angular-feed.xml');
const xml = await readFile(source, 'utf8');
if (Buffer.byteLength(xml) > 3_000_000) throw new Error('Feed exceeds limit.');
const dom = new JSDOM(xml, { contentType: 'application/xml' });
try {
  const item = [...dom.window.document.querySelectorAll('item')].find(item => item.querySelector('link')?.textContent.includes('9619a35e2b0a'));
  if (!item) throw new Error('Requested Angular article is absent from the current publisher feed.');
  const body = item.getElementsByTagNameNS('http://purl.org/rss/1.0/modules/content/', 'encoded')[0]?.textContent;
  if (!body) throw new Error('Publisher feed has no full content field.');
  await mkdir('.ui-review/renderer', { recursive: true });
  await writeFile('.ui-review/renderer/publisher-feed.html', '<!doctype html><title>An update on Angular’s TypeScript 7-powered Compiler</title><article>' + body + '</article>');
  console.log(JSON.stringify({ source: 'https://blog.angular.dev/feed', link: item.querySelector('link').textContent, htmlCharacters: body.length, output: '.ui-review/renderer/publisher-feed.html' }));
} finally { dom.window.close(); }
