import { test } from "node:test";
import assert from "node:assert/strict";
import { prepareSpeech } from "../speech-text.mjs";
import { englishCardinal, englishOrdinal, englishYear, frenchCardinal, frenchOrdinal, numberWords } from "../number-words.mjs";
import { planNarration } from "../chunks.mjs";

const speak = (text, language = "en") => prepareSpeech(text, { language }).text;

test("reported pronunciation failures are spoken as intended", () => {
  assert.equal(speak("We need 2-3x more GPUs."), "We need two to three times more GPUs.");
  assert.equal(speak("Elle finit à la 10e place.", "fr"), "Elle finit à la dixième place.");
  assert.equal(speak("It answers in 16 ms."), "It answers in sixteen milliseconds.");
  assert.equal(speak("(as of Sep 30, 2026)"), "(as of September thirty, twenty twenty-six)");
  assert.equal(speak("Get it from https://github.com/acme/tool/releases?utm_source=news&id=42 today."),
    "Get it from github dot com today.");
  assert.equal(speak("Read the full report.\n\nhttps://www.example.org/reports/2026/q3.pdf?ref=abc\n\nNext topic."),
    "Read the full report.\n\n\n\nNext topic.");
  // Pocket TTS reads digit tokens one by one: "128K" was spoken "twelve eight K".
  assert.equal(speak("The Mini version comes in two variants 4K and 128K which is the context length (in tokens)."),
    "The Mini version comes in two variants four K and one hundred twenty-eight K which is the context length (in tokens).");
});

test("common variants of the reported cases", () => {
  assert.equal(speak("2–3x, 2-3×, 1.5-2x, 10x faster, 0.5x speed"),
    "two to three times, two to three times, one point five to two times, ten times faster, zero point five times speed");
  assert.equal(speak("2–3x plus de GPU, 1,5x plus vite", "fr"), "deux à trois fois plus de GPU, un virgule cinq fois plus vite");
  assert.equal(speak("10e, 10ème, 10ᵉ, 1er, 1re, 1ère, 1ᵉʳ, 2e, 21e, 80e, 99e, 200e", "fr"),
    "dixième, dixième, dixième, premier, première, première, premier, deuxième, vingt et unième, quatre-vingtième, quatre-vingt-dix-neuvième, deux centième");
  assert.equal(speak("16ms, 1 ms, 10–20 ms, 0.5 µs, 3 ns"),
    "sixteen milliseconds, one millisecond, ten to twenty milliseconds, zero point five microseconds, three nanoseconds");
  assert.equal(speak("21 ms", "fr"), "vingt et une millisecondes");
  assert.equal(speak("16 ms, 1 ms, 0,5 ms", "fr"), "seize millisecondes, une milliseconde, zéro virgule cinq milliseconde");
  assert.equal(speak("Sep. 30, Sept. 30, 2026, Sept 2026, 30 Sep 2026, Oct 1st and Dec. 12"),
    "September thirty, September thirty, twenty twenty-six, September twenty twenty-six, thirty September twenty twenty-six, October first and December twelve");
  // A dot that may also end the sentence stays.
  assert.equal(speak("It shipped on 30 Sep. Then it broke."), "It shipped on thirty September. Then it broke.");
  assert.equal(speak("Le 30 sept. 2026, le 1er sept. et en sept. 2026.", "fr"),
    "Le trente septembre deux mille vingt-six, le premier septembre et en septembre deux mille vingt-six.");
});

test("numbers are spoken as words, with years, decimals, ordinals, suffixes and currencies", () => {
  assert.equal(speak("She has 7 cats, 16 dogs, 42 hens and 99 rabbits; 2048 tokens, 32,768 or 1,000,000."),
    "She has seven cats, sixteen dogs, forty-two hens and ninety-nine rabbits; two thousand forty-eight tokens, thirty-two thousand seven hundred sixty-eight or one million.");
  assert.equal(speak("In 1999, since 2005, by mid-1990s, the 1980s and 2000s, in 1905, (2020) and 2020–2024."),
    "In nineteen ninety-nine, since two thousand five, by mid-nineteen nineties, the nineteen eighties and two thousands, in nineteen oh five, (twenty twenty) and twenty twenty–twenty twenty-four.");
  // Without a year context the cardinal is used: always a valid reading.
  assert.equal(speak("from 2048 to 4096 tokens"), "from two thousand forty-eight to four thousand ninety-six tokens");
  assert.equal(speak("3.5 GHz, 3.14, 0.05, 16GB, 75%, 128-bit, the 22nd, 101st and 3rd"),
    "three point five GHz, three point one four, zero point zero five, sixteen GB, seventy-five%, one hundred twenty-eight-bit, the twenty-second, one hundred first and third");
  assert.equal(speak("$50, $1, $1.5B, €2 million, £3.50 and 20€"),
    "fifty dollars, one dollar, one point five billion dollars, two million euros, three point five zero pounds and twenty euros");
  assert.equal(speak("En 1999, 42 poules, 128 000 jetons, 1,5 kilo, 3,14, 75 %, 16 Go, 50 €, 3 000 $, 2 M$, 2 millions.", "fr"),
    "En mille neuf cent quatre-vingt-dix-neuf, quarante-deux poules, cent vingt-huit mille jetons, un virgule cinq kilo, trois virgule quatorze, soixante-quinze %, seize Go, cinquante euros, trois mille dollars, deux M$, deux millions.");
  assert.equal(speak("$5 million and $2B", "fr"), "cinq millions de dollars and deux milliards de dollars");
});

test("identifiers, codes and unrelated text are left unchanged", () => {
  for (const text of ["d1-3B", "d1-300B", "Llama-3-8B", "Qwen2.5-72B", "GPT-4o", "Phi-3", "COVID-19", "H100", "RTX4090Ti",
    "0x1e", "4x4", "1920x1080", "x86", "v2x", "1.2.3x", "3.11.2", "2X", "1x speed", "1e-5", "10e3", "1080p", "5G", "3D",
    "2026-09-30", "30/09/2026", "192.168.1.1", "555-123-4567", "10:30", "16:9", "007", "#42", "@3", "3s",
    "MS-DOS", "Ms. Smith", "Sep is short for September.", "Mar-a-Lago", "Sept chats"]) {
    assert.equal(speak(text), text, text);
  }
  for (const text of ["d1-3B", "1e-5", "10e3", "2e-3", "0e", "01e", "10es", "1e", "Il a sept ans.", "Sept chats.",
    "XIXe siècle", "1 voiture", "2026-09-30", "10:30"]) {
    assert.equal(speak(text, "fr"), text, text);
  }
  // Rules follow the narration language only.
  assert.equal(speak("10e place"), "10e place");
  assert.equal(speak("Sep 30, 2026", "fr"), "Sep trente, deux mille vingt-six");
  assert.equal(speak("Jan said 2 things."), "Jan said two things.");
  // An unsupported language only loses reference URLs.
  assert.equal(speak("2-3x in 16 ms, see https://example.com/x\n\nhttps://example.com/ref", "de"), "2-3x in 16 ms, see https://example.com/x\n\n");
});

test("punctuation, paragraph boundaries and unit casing are preserved", () => {
  const text = "First: 2-3x!\n\n  Then, in 16 ms… (really?)\n\nLast; 16 MB.";
  assert.equal(speak(text), "First: two to three times!\n\n  Then, in sixteen milliseconds… (really?)\n\nLast; sixteen MB.");
});

test("URLs: keep link labels, mention inline domains, skip references, never narrate paths or queries", () => {
  assert.equal(speak("See [the 2 papers](https://arxiv.org/abs/2601.01234?utm_campaign=x) for details."), "See the two papers for details.");
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
  assert.doesNotMatch(speak("Try https://shop.example.com/p/123?utm_source=newsletter&fbclid=abc#top now."), /utm|fbclid|123|one hundred|https|\//);
  // Email addresses and bare domains are untouched.
  assert.equal(speak("Write to me@example.com or visit example.com."), "Write to me@example.com or visit example.com.");
});

test("number words follow English and traditional French spelling", () => {
  const english = { 0: "zero", 7: "seven", 15: "fifteen", 42: "forty-two", 100: "one hundred", 128: "one hundred twenty-eight",
    2048: "two thousand forty-eight", 128000: "one hundred twenty-eight thousand", 1000001: "one million one",
    2500000000: "two billion five hundred million" };
  for (const [n, word] of Object.entries(english)) assert.equal(englishCardinal(Number(n)), word);
  const ordinals = { 1: "first", 2: "second", 3: "third", 5: "fifth", 8: "eighth", 9: "ninth", 12: "twelfth", 20: "twentieth",
    22: "twenty-second", 101: "one hundred first", 1000: "one thousandth" };
  for (const [n, word] of Object.entries(ordinals)) assert.equal(englishOrdinal(Number(n)), word);
  const years = { 1100: "eleven hundred", 1905: "nineteen oh five", 1999: "nineteen ninety-nine", 2000: "two thousand",
    2005: "two thousand five", 2010: "twenty ten", 2026: "twenty twenty-six" };
  for (const [n, word] of Object.entries(years)) assert.equal(englishYear(Number(n)), word);
  const french = { 0: "zéro", 21: "vingt et un", 71: "soixante et onze", 80: "quatre-vingts", 81: "quatre-vingt-un",
    99: "quatre-vingt-dix-neuf", 200: "deux cents", 201: "deux cent un", 1999: "mille neuf cent quatre-vingt-dix-neuf",
    80000: "quatre-vingt mille", 200000: "deux cent mille", 1000000: "un million", 2000000: "deux millions",
    3200000000: "trois milliards deux cents millions" };
  for (const [n, word] of Object.entries(french)) assert.equal(frenchCardinal(Number(n)), word);
  const frenchOrdinals = { 2: "deuxième", 3: "troisième", 4: "quatrième", 5: "cinquième", 9: "neuvième", 11: "onzième",
    17: "dix-septième", 20: "vingtième", 21: "vingt et unième", 22: "vingt-deuxième", 70: "soixante-dixième",
    71: "soixante et onzième", 80: "quatre-vingtième", 81: "quatre-vingt-unième", 91: "quatre-vingt-onzième",
    100: "centième", 101: "cent unième", 300: "trois centième", 1000: "millième", 2000: "deux millième",
    2026: "deux mille vingt-sixième", 1000000: "un millionième" };
  for (const [n, word] of Object.entries(frenchOrdinals)) assert.equal(frenchOrdinal(Number(n)), word);
  assert.equal(numberWords("1,000.25", "en"), "one thousand point two five");
  assert.equal(numberWords("1 000,25", "fr"), "mille virgule vingt-cinq");
  assert.equal(numberWords("0,05", "fr"), "zéro virgule zéro cinq");
  for (const raw of ["007", "1,5", "1.000.000", "1000000000000"]) assert.equal(numberWords(raw, "en"), null, raw);
});

test("every spoken character maps to its original range; skipped text maps to nothing", () => {
  const text = "Use 2-3x more. See the docs (https://e.org/x). Done in 16 ms, or 128K.";
  const { text: speech, source } = prepareSpeech(text);
  assert.equal(speech, "Use two to three times more. See the docs. Done in sixteen milliseconds, or one hundred twenty-eight K.");
  const original = (spoken) => {
    const start = speech.indexOf(spoken);
    return text.slice(...source(start, start + spoken.length));
  };
  assert.equal(original("two to three times"), "2-3x");
  assert.equal(original("three"), "2-3x"); // Any part of an expansion highlights the whole expression.
  assert.equal(original("Use two to three times more."), "Use 2-3x more.");
  assert.equal(original("sixteen milliseconds,"), "16 ms,");
  assert.equal(original("docs. Done"), "docs (https://e.org/x). Done");
  assert.equal(original("twenty-eight K."), "128K.");
});

test("narration sentences highlight original text across expansions and skipped URLs", () => {
  const text = "We need 2-3x more GPUs (as of Sep 30, 2026). Latency is 16 ms (https://example.com/bench?utm=1).\n\n" +
    "https://example.com/reference\n\nThe sentence after the link. Elle est 10e. Final words.";
  const { sentences, chunks } = planNarration(text);
  const slices = sentences.map(({ start, end }) => text.slice(start, end));
  assert.deepEqual(slices, ["We need 2-3x more GPUs (as of Sep 30, 2026).", "Latency is 16 ms (https://example.com/bench?utm=1).",
    "The sentence after the link.", "Elle est 10e.", "Final words."]);
  assert.deepEqual(chunks.map(chunk => chunk.text), [
    "We need two to three times more GPUs (as of September thirty, twenty twenty-six). Latency is sixteen milliseconds.",
    "The sentence after the link. Elle est 10e. Final words."]);
  // Timing weights use the spoken length.
  assert.deepEqual(sentences.map(s => s.length), [81, 32, 28, 13, 12]);
  const french = planNarration("Il est 10e.\n\nhttps://a.fr/x\n\nIl est 1er. Fin.", { language: "fr" });
  assert.deepEqual(french.chunks.map(chunk => chunk.text), ["Il est dixième.", "Il est premier. Fin."]);
  assert.deepEqual(french.sentences.map(({ start, end }) => [start, end]), [[0, 11], [29, 40], [41, 45]]);
});

test("chunk limits hold after expansion, and speech-empty input has no chunks", () => {
  const sentence = "It is 2-3x faster in 16 ms, with 10–20 ms tails, since Sep. 30, 2026, at $1.5B, see www.example.com/a?b=c.";
  const text = Array.from({ length: 40 }, () => sentence).join(" ") + "\n\n" + "777777 ".repeat(200).trim();
  for (const language of ["en", "fr"]) {
    const { sentences, chunks } = planNarration(text, { language });
    assert.ok(chunks.length > 1);
    chunks.forEach((chunk, i) => assert.ok(chunk.text.length <= (i === 0 ? 220 : 500), `${language} chunk ${i}`));
    for (const { start, end } of sentences) assert.ok(start < end && end <= text.length);
    // Expanded speech is longer than its source, so a source-sized plan would have overflowed.
    assert.ok(chunks.reduce((sum, chunk) => sum + chunk.text.length, 0) > 3 * text.length);
  }
  for (const empty of ["https://example.com/a", "https://a.com\n\n- https://b.com/x?y=1\n\n(https://c.com)", "[https://a.com]"]) {
    assert.deepEqual(planNarration(empty), { sentences: [], chunks: [] }, empty);
  }
});
