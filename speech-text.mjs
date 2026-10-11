// Speech-only text preparation. Narrow, deterministic rewrites for expressions that speech models
// misread (multiplier ranges, a few units, abbreviated months, French ordinals, URLs), applied in
// the narration language. The original text is never changed: the result maps every spoken
// character back to the source range it stands for, so highlights address the displayed text.

const alnum = String.raw`[\p{L}\p{N}_]`;
// A number must start a token: not "d1-3B", "v2", "1.2.3x", "0x1e" or a range continuation.
const before = String.raw`(?<![\p{L}\p{N}_.,\-–/])`;
const number = String.raw`\d+(?:[.,]\d+)?`;
const space = String.raw`[ \u00a0\u202f]`;

const words = {
  en: { to: "to", times: "times", dot: "dot", link: "a link",
    units: { ms: ["millisecond", "milliseconds"], ns: ["nanosecond", "nanoseconds"], µs: ["microsecond", "microseconds"] } },
  fr: { to: "à", times: "fois", dot: "point", link: "un lien",
    units: { ms: ["milliseconde", "millisecondes"], ns: ["nanoseconde", "nanosecondes"], µs: ["microseconde", "microsecondes"] } },
};

const englishMonths = { Jan: "January", Feb: "February", Mar: "March", Apr: "April", Jun: "June", Jul: "July", Aug: "August",
  Sep: "September", Sept: "September", Oct: "October", Nov: "November", Dec: "December" };
// Only dotted forms: bare "sept" is the number seven.
const frenchMonths = { janv: "janvier", févr: "février", fév: "février", avr: "avril", juil: "juillet", sept: "septembre",
  oct: "octobre", nov: "novembre", déc: "décembre" };

const frenchUnits = ["zéro", "un", "deux", "trois", "quatre", "cinq", "six", "sept", "huit", "neuf", "dix", "onze", "douze",
  "treize", "quatorze", "quinze", "seize", "dix-sept", "dix-huit", "dix-neuf"];
const frenchTens = ["", "", "vingt", "trente", "quarante", "cinquante", "soixante", "soixante", "quatre-vingt", "quatre-vingt"];

function frenchBelow100(n) {
  if (n < 20) return frenchUnits[n];
  const ten = Math.floor(n / 10);
  const rest = ten === 7 || ten === 9 ? n % 10 + 10 : n % 10;
  if (!rest) return ten === 8 ? "quatre-vingts" : frenchTens[ten];
  return `${frenchTens[ten]}${(rest === 1 || rest === 11) && ten < 8 ? " et " : "-"}${frenchUnits[rest]}`;
}

function frenchBelow1000(n) {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  const head = hundreds === 0 ? "" : hundreds === 1 ? "cent" : `${frenchUnits[hundreds]} cent${rest ? "" : "s"}`;
  return [head, rest ? frenchBelow100(rest) : ""].filter(Boolean).join(" ");
}

// Cardinal words for 1–9999 (traditional spelling: "vingt et un", "quatre-vingts", "deux cents").
export function frenchCardinal(n) {
  const thousands = Math.floor(n / 1000);
  const rest = n % 1000;
  const head = thousands === 0 ? "" : thousands === 1 ? "mille" : `${frenchBelow1000(thousands).replace(/cents$/, "cent")} mille`;
  return [head, rest ? frenchBelow1000(rest) : ""].filter(Boolean).join(" ");
}

// "10e" → "dixième": the last word of the cardinal takes the ordinal suffix.
export function frenchOrdinal(n) {
  return frenchCardinal(n).replace(/[^\s-]+$/, word => {
    if (word === "cinq") return "cinquième";
    if (word === "neuf") return "neuvième";
    return `${word.replace(/^(cent|vingt)s$/, "$1").replace(/e$/, "")}ième`;
  });
}

function speakNumber(value, language) {
  return language === "fr" ? value.replace(/\.(?=\d)/, ",") : value;
}

function speakHost(url, language) {
  let host;
  try { host = new URL(/^www\./i.test(url) ? `http://${url}` : url).hostname; } catch { return words[language].link; }
  host = host.toLowerCase().replace(/^www\./, "");
  if (!/[a-z]/.test(host) || host.startsWith("[")) return words[language].link; // IP addresses
  return host.split(".").join(` ${words[language].dot} `);
}

// URLs end before trailing sentence punctuation and closing brackets they did not open.
function urlEnd(text, start, end) {
  while (end > start) {
    const last = text[end - 1];
    if (/[.,;:!?'"»”’]/.test(last)) end--;
    else if (/[)\]}]/.test(last)) {
      const open = { ")": "(", "]": "[", "}": "{" }[last];
      const url = text.slice(start, end);
      if (url.split(open).length >= url.split(last).length) break;
      end--;
    } else break;
  }
  return end;
}

function urlEdits(text, language, edits) {
  const urls = [];
  for (const match of text.matchAll(/\[([^\]\n]+)\]\(((?:https?:\/\/|www\.)[^\s()]+(?:\([^\s()]*\)[^\s()]*)*)\)/giu)) {
    // A Markdown link keeps its label; a label that is itself a URL is spoken like one.
    const label = match[1].trim();
    const speech = language in words && /^(?:https?:\/\/|www\.)\S+$/i.test(label) ? speakHost(label, language) : label;
    edits.add(match.index, match.index + match[0].length, speech);
  }
  for (const match of text.matchAll(/(?<![\p{L}\p{N}_@/.])(?:https?:\/\/|www\.(?=[\p{L}\p{N}]))[^\s<>"«»“”]+/giu)) {
    const start = match.index;
    const end = urlEnd(text, start, start + match[0].length);
    if (end - start > (/^www\./i.test(match[0]) ? 4 : 8) && edits.free(start, end)) urls.push({ start, end });
  }
  let line = { start: 0, end: -1 };
  for (const [i, url] of urls.entries()) {
    // A reference URL alone on its line (bullets allowed), or a citation in brackets, is skipped.
    if (url.start > line.end) {
      const end = text.indexOf("\n", url.end);
      line = { start: text.lastIndexOf("\n", url.start - 1) + 1, end: end < 0 ? text.length : end, spoken: false };
      let at = line.start;
      for (let j = i; j < urls.length && urls[j].start < line.end; j++) {
        line.spoken ||= /[\p{L}\p{N}]/u.test(text.slice(at, urls[j].start));
        at = urls[j].end;
      }
      line.spoken ||= /[\p{L}\p{N}]/u.test(text.slice(at, line.end));
    }
    const closer = { "(": ")", "[": "]" }[text[url.start - 1]];
    // A bracketed URL after a phrase of its own clause is a citation: "See the docs (https://…)."
    // In "See (https://…)." or "…, or (https://…)" it is the object, and is spoken.
    const clause = text.slice(Math.max(line.start, url.start - 200), url.start - 1).split(/[.!?:;,](?:\s|$)/).at(-1);
    let start = url.start - 1;
    while (start > line.start && /[ \t\u00a0\u202f]/.test(text[start - 1])) start--;
    if (closer && text[url.end] === closer && (clause.match(/[\p{L}\p{N}]+/gu)?.length ?? 0) >= 2 &&
        edits.add(start, url.end + 1, "")) continue;
    edits.add(url.start, url.end, !line.spoken ? "" :
      language in words ? speakHost(text.slice(url.start, url.end), language) : text.slice(url.start, url.end));
  }
}

// The abbreviation's dot is dropped mid-sentence, but kept where it may also end the sentence:
// "Sep. 30" → "September 30", "1er sept. et" → "premier septembre et", "on 30 Sep. Then" keeps it.
const midSentenceDot = new RegExp(String.raw`^\.(?:${space}+[\p{Ll}\d]|[,;:)])`, "u");
function abbreviationDot(text, at) {
  return midSentenceDot.test(text.slice(at, at + 3)) ? 1 : 0;
}

// Rewrites never overlap: the first rule to claim a character owns it.
function editor(length) {
  const claimed = new Uint8Array(length);
  const list = [];
  const free = (start, end) => !claimed.subarray(start, end).includes(1);
  return { list, free, add(start, end, speech) {
    if (!free(start, end)) return false;
    claimed.fill(1, start, end);
    list.push({ start, end, speech });
    return true;
  } };
}

function languageEdits(text, language, edits) {
  const { to, times, units } = words[language];
  const plural = value => language === "fr" ? Number(value.replace(",", ".")) >= 2 : value !== "1";
  // "16 ms", "16ms", "10–20 ms": a time unit only after a number, in its exact case.
  const unit = new RegExp(String.raw`${before}(${number})(?:${space}?[-–]${space}?(${number}))?${space}?(ms|ns|µs|μs)(?!${alnum})`, "gu");
  for (const match of text.matchAll(unit)) {
    const [singular, many] = units[match[3] === "μs" ? "µs" : match[3]];
    const value = match[2] ?? match[1];
    const amount = match[2] ? `${speakNumber(match[1], language)} ${to} ${speakNumber(match[2], language)}` : speakNumber(match[1], language);
    edits.add(match.index, match.index + match[0].length, `${amount} ${match[2] || plural(value) ? many : singular}`);
  }
  // "2-3x", "2–3×", "10x": a multiplier directly after a number, never inside a token like "4x4" or "0x1f".
  const multiplier = new RegExp(String.raw`${before}(${number})(?:${space}?[-–]${space}?(${number}))?[x×](?!${alnum})`, "gu");
  for (const match of text.matchAll(multiplier)) {
    if (!match[2] && match[1] === "1") continue; // "1x" is usually a speed or zoom setting, read as is.
    const amount = match[2] ? `${speakNumber(match[1], language)} ${to} ${speakNumber(match[2], language)}` : speakNumber(match[1], language);
    edits.add(match.index, match.index + match[0].length, `${amount} ${times}`);
  }
  if (language === "en") {
    // Abbreviated months only in a recognizable date: "Sep 30", "Sep. 30, 2026", "Sept. 2026", or after a
    // day when a year or punctuation follows: "30 Sep 2026", "30 Sep.".
    const names = Object.keys(englishMonths).join("|");
    const month = new RegExp(String.raw`(?<!${alnum})(${names})(?=\.?${space}+\d{1,4}(?!\d)(?![.,]\d))|(?<=(?<![\d.,])\d{1,2}${space}+)(${names})(?=\.?(?:${space}+\d{4}(?!\d)|[\s.,;:)]|$))`, "gu");
    for (const match of text.matchAll(month)) {
      const name = match[1] ?? match[2];
      edits.add(match.index, match.index + name.length + abbreviationDot(text, match.index + name.length), englishMonths[name]);
    }
  }
  if (language === "fr") {
    const names = Object.keys(frenchMonths).join("|");
    // "30 sept. 2026", "1er sept.", "sept. 2026": dotted abbreviations after a day or before a year.
    const month = new RegExp(String.raw`(?<=(?<![\d.,])\d{1,2}(?:er|ᵉʳ)?${space}+)(${names})\.|(?<!${alnum})(${names})\.(?=${space}+\d{4}(?!\d))`, "giu");
    for (const match of text.matchAll(month)) {
      const name = match[1] ?? match[2];
      const spoken = frenchMonths[name.toLowerCase()];
      edits.add(match.index, match.index + name.length + abbreviationDot(text, match.index + name.length),
        name[0] === name[0].toUpperCase() ? spoken[0].toUpperCase() + spoken.slice(1) : spoken);
    }
    // "10e", "10ème", "10ᵉ" → "dixième"; "1er"/"1re"/"1ère" → "premier"/"première". Not "1e-5" or "10e3".
    const ordinal = new RegExp(String.raw`${before}(\d{1,4})(ᵉʳ|er|ʳᵉ|re|ère|ème|eme|ᵉ|e)(?!${alnum})(?![-+]?\d)`, "gu");
    for (const match of text.matchAll(ordinal)) {
      const value = Number(match[1]);
      const suffix = match[2];
      if (match[1].startsWith("0") || value === 0) continue;
      if (value === 1) {
        if (["ᵉʳ", "er"].includes(suffix)) edits.add(match.index, match.index + match[0].length, "premier");
        else if (["ʳᵉ", "re", "ère"].includes(suffix)) edits.add(match.index, match.index + match[0].length, "première");
      } else if (["ème", "eme", "ᵉ", "e"].includes(suffix)) edits.add(match.index, match.index + match[0].length, frenchOrdinal(value));
    }
  }
}

// Returns the speech text and, for each of its characters, the source range it was produced from.
// Unchanged text maps one to one; a rewrite maps every spoken character to the whole expression.
// Unsupported languages only lose reference URLs (alone on a line, or cited in brackets).
export function prepareSpeech(text, { language = "en" } = {}) {
  language = String(language).toLowerCase().split(/[-_]/)[0];
  const editing = editor(text.length);
  urlEdits(text, language, editing);
  if (language in words) languageEdits(text, language, editing);
  const edits = editing.list.sort((a, b) => a.start - b.start);
  let speech = "";
  const starts = [];
  const ends = [];
  let at = 0;
  const copy = end => {
    speech += text.slice(at, end);
    for (; at < end; at++) { starts.push(at); ends.push(at + 1); }
  };
  for (const edit of edits) {
    copy(edit.start);
    speech += edit.speech;
    for (let i = 0; i < edit.speech.length; i++) { starts.push(edit.start); ends.push(edit.end); }
    at = edit.end;
  }
  copy(text.length);
  return {
    text: speech,
    // Source range of speech characters [start, end).
    source: (start, end) => [starts[start], ends[end - 1]],
    edits,
  };
}
