import { test } from "node:test";
import assert from "node:assert/strict";
import { frenchOrdinal, prepareSpeech } from "../speech-text.mjs";
import { planNarration } from "../chunks.mjs";

const speak = (text, language = "en") => prepareSpeech(text, { language }).text;

test("reported pronunciation failures are spoken as intended", () => {
  assert.equal(speak("We need 2-3x more GPUs."), "We need 2 to 3 times more GPUs.");
  assert.equal(speak("Elle finit à la 10e place.", "fr"), "Elle finit à la dixième place.");
  assert.equal(speak("It answers in 16 ms."), "It answers in 16 milliseconds.");
  assert.equal(speak("(as of Sep 30, 2026)"), "(as of September 30, 2026)");
  assert.equal(speak("Get it from https://github.com/acme/tool/releases?utm_source=news&id=42 today."),
    "Get it from github dot com today.");
  assert.equal(speak("Read the full report.\n\nhttps://www.example.org/reports/2026/q3.pdf?ref=abc\n\nNext topic."),
    "Read the full report.\n\n\n\nNext topic.");
});

test("common variants of the reported cases", () => {
  assert.equal(speak("2–3x, 2-3×, 1.5-2x, 10x faster, 0.5x speed"), "2 to 3 times, 2 to 3 times, 1.5 to 2 times, 10 times faster, 0.5 times speed");
  assert.equal(speak("2–3x plus de GPU, 1,5x plus vite", "fr"), "2 à 3 fois plus de GPU, 1,5 fois plus vite");
  assert.equal(speak("10e, 10ème, 10ᵉ, 1er, 1re, 1ère, 1ᵉʳ, 2e, 21e, 80e, 99e, 200e", "fr"),
    "dixième, dixième, dixième, premier, première, première, premier, deuxième, vingt et unième, quatre-vingtième, quatre-vingt-dix-neuvième, deux centième");
  assert.equal(speak("16ms, 1 ms, 10–20 ms, 0.5 µs, 3 ns"), "16 milliseconds, 1 millisecond, 10 to 20 milliseconds, 0.5 microseconds, 3 nanoseconds");
  assert.equal(speak("16 ms, 1 ms, 0,5 ms", "fr"), "16 millisecondes, 1 milliseconde, 0,5 milliseconde");
  assert.equal(speak("Sep. 30, Sept. 30, 2026, Sept 2026, 30 Sep 2026, Oct 1 and Dec. 12"),
    "September 30, September 30, 2026, September 2026, 30 September 2026, October 1 and December 12");
  // A dot that may also end the sentence stays.
  assert.equal(speak("It shipped on 30 Sep. Then it broke."), "It shipped on 30 September. Then it broke.");
  assert.equal(speak("Le 30 sept. 2026, le 1er sept. et en sept. 2026.", "fr"), "Le 30 septembre 2026, le premier septembre et en septembre 2026.");
});

test("identifiers, ambiguous numbers and unrelated text are left unchanged", () => {
  for (const text of ["d1-3B", "Llama-3-8B", "0x1e", "4x4", "1920x1080", "x86", "v2x", "1.2.3x", "2X", "1x speed",
    "2020-2024", "a 3-2 win", "1e-5", "10e3", "16 MB", "16 Ms", "MS-DOS", "Ms. Smith", "16 msec",
    "Sep is short for September.", "Jan said 2 things.", "Mar-a-Lago", "Sept chats", "30 sept 2026", "10e"]) {
    assert.equal(speak(text), text, text);
  }
  for (const text of ["d1-3B", "1e-5", "10e3", "2e-3", "0e", "01e", "10es", "1e", "Il a sept ans.", "Sept chats.",
    "XIXe siècle", "sept. 30", "16 Ms"]) {
    assert.equal(speak(text, "fr"), text, text);
  }
  // Rules follow the narration language only: French ordinals are not touched in English and vice versa.
  assert.equal(speak("10e place"), "10e place");
  assert.equal(speak("Sep 30, 2026", "fr"), "Sep 30, 2026");
  // An unsupported language only loses standalone reference URLs.
  assert.equal(speak("2-3x in 16 ms, see https://example.com/x\n\nhttps://example.com/ref", "de"), "2-3x in 16 ms, see https://example.com/x\n\n");
});

test("punctuation, paragraph boundaries and unit casing are preserved", () => {
  const text = "First: 2-3x!\n\n  Then, in 16 ms… (really?)\n\nLast; 16 MB.";
  assert.equal(speak(text), "First: 2 to 3 times!\n\n  Then, in 16 milliseconds… (really?)\n\nLast; 16 MB.");
});

test("URLs: keep link labels, mention inline domains, skip references, never narrate paths or queries", () => {
  assert.equal(speak("See [the paper](https://arxiv.org/abs/2601.01234?utm_campaign=x) for details."), "See the paper for details.");
  assert.equal(speak("Source: [https://www.bbc.co.uk/news/a-1](https://www.bbc.co.uk/news/a-1)"), "Source: bbc dot co dot uk");
  assert.equal(speak("Visit www.example.com. Or https://docs.python.org/3/library/re.html, or (https://x.com)."),
    "Visit example dot com. Or docs dot python dot org, or (x dot com).");
  assert.equal(speak("Le site https://www.lemonde.fr/article?xtor=RSS est fiable.", "fr"), "Le site lemonde point fr est fiable.");
  // Citations after the sentence's own words are skipped with their brackets and leading space.
  assert.equal(speak("See the docs (https://example.org/a/b). Then go on."), "See the docs. Then go on.");
  assert.equal(speak("See (https://example.org/a/b)."), "See (example dot org).");
  assert.equal(speak("As reported [https://example.org/x], it works."), "As reported, it works.");
  // Lines holding only URLs (bullets allowed) are skipped.
  assert.equal(speak("Links:\n- https://a.com/1 https://b.com/2\n- https://c.com/3"), "Links:\n-  \n- ");
  assert.equal(speak("Admin at http://192.168.1.1/admin."), "Admin at a link.");
  // Wikipedia-style parentheses stay part of the URL; a closing bracket the URL did not open does not.
  assert.equal(speak("Read https://en.wikipedia.org/wiki/Foo_(bar), then stop."), "Read en dot wikipedia dot org, then stop.");
  // Speech never contains URL internals.
  assert.doesNotMatch(speak("Try https://shop.example.com/p/123?utm_source=newsletter&fbclid=abc#top now."), /utm|fbclid|123|https|\//);
  // Email addresses and bare domains are untouched.
  assert.equal(speak("Write to me@example.com or visit example.com."), "Write to me@example.com or visit example.com.");
});

test("French ordinal words follow the traditional spelling", () => {
  const expected = { 2: "deuxième", 3: "troisième", 4: "quatrième", 5: "cinquième", 9: "neuvième", 11: "onzième",
    17: "dix-septième", 20: "vingtième", 21: "vingt et unième", 22: "vingt-deuxième", 70: "soixante-dixième",
    71: "soixante et onzième", 80: "quatre-vingtième", 81: "quatre-vingt-unième", 91: "quatre-vingt-onzième",
    100: "centième", 101: "cent unième", 300: "trois centième", 1000: "millième", 2000: "deux millième",
    2026: "deux mille vingt-sixième" };
  for (const [n, word] of Object.entries(expected)) assert.equal(frenchOrdinal(Number(n)), word);
});

test("every spoken character maps to its original range; skipped text maps to nothing", () => {
  const text = "Use 2-3x more. See the docs (https://e.org/x). Done in 16 ms.";
  const { text: speech, source } = prepareSpeech(text);
  assert.equal(speech, "Use 2 to 3 times more. See the docs. Done in 16 milliseconds.");
  const original = (spoken) => {
    const start = speech.indexOf(spoken);
    return text.slice(...source(start, start + spoken.length));
  };
  assert.equal(original("2 to 3 times"), "2-3x");
  assert.equal(original("to"), "2-3x"); // Any part of an expansion highlights the whole expression.
  assert.equal(original("Use 2 to 3 times more."), "Use 2-3x more.");
  assert.equal(original("16 milliseconds."), "16 ms.");
  assert.equal(original("docs. Done"), "docs (https://e.org/x). Done");
  assert.equal(original("Done in 16 milliseconds."), "Done in 16 ms.");
});

test("narration sentences highlight original text across expansions and skipped URLs", () => {
  const text = "We need 2-3x more GPUs (as of Sep 30, 2026). Latency is 16 ms (https://example.com/bench?utm=1).\n\n" +
    "https://example.com/reference\n\nThe sentence after the link. Elle est 10e. Final words.";
  const { sentences, chunks } = planNarration(text);
  const slices = sentences.map(({ start, end }) => text.slice(start, end));
  assert.deepEqual(slices, ["We need 2-3x more GPUs (as of Sep 30, 2026).", "Latency is 16 ms (https://example.com/bench?utm=1).",
    "The sentence after the link.", "Elle est 10e.", "Final words."]);
  assert.deepEqual(chunks.map(chunk => chunk.text), [
    "We need 2 to 3 times more GPUs (as of September 30, 2026). Latency is 16 milliseconds.",
    "The sentence after the link. Elle est 10e. Final words."]);
  // Timing weights use the spoken length.
  assert.deepEqual(sentences.map(s => s.length), [58, 27, 28, 13, 12]);
  const french = planNarration("Il est 10e.\n\nhttps://a.fr/x\n\nIl est 1er. Fin.", { language: "fr" });
  assert.deepEqual(french.chunks.map(chunk => chunk.text), ["Il est dixième.", "Il est premier. Fin."]);
  assert.deepEqual(french.sentences.map(({ start, end }) => [start, end]), [[0, 11], [29, 40], [41, 45]]);
});

test("chunk limits hold after expansion, and speech-empty input has no chunks", () => {
  const sentence = "It is 2-3x faster in 16 ms, with 10–20 ms tails, since Sep. 30, 2026, see www.example.com/a?b=c.";
  const text = Array.from({ length: 40 }, () => sentence).join(" ") + "\n\n" + "1ms ".repeat(200).trim();
  for (const language of ["en", "fr"]) {
    const { sentences, chunks } = planNarration(text, { language });
    assert.ok(chunks.length > 1);
    chunks.forEach((chunk, i) => assert.ok(chunk.text.length <= (i === 0 ? 220 : 500), `${language} chunk ${i}`));
    for (const { start, end } of sentences) assert.ok(start < end && end <= text.length);
    // Expanded speech is longer than its source, so a source-sized plan would have overflowed.
    assert.ok(chunks.reduce((sum, chunk) => sum + chunk.text.length, 0) > text.length);
  }
  for (const empty of ["https://example.com/a", "https://a.com\n\n- https://b.com/x?y=1\n\n(https://c.com)", "[https://a.com]"]) {
    assert.deepEqual(planNarration(empty), { sentences: [], chunks: [] }, empty);
  }
});
