const speech = /[\p{L}\p{N}]/u;
const space = /\s/;
// Intl.Segmenter has no abbreviation suppressions: keep "Mr. Smith" and "J. K. Rowling" together.
const title = /(?:^|[\s(«“"'])(?:Mr|Mrs|Ms|Dr|Prof|St|Sr|Jr|Mt|Mme|Mlle|Mgr|\p{Lu})\.$/u;

function trimmed(text, start, end) {
  while (start < end && space.test(text[start])) start++;
  while (end > start && space.test(text[end - 1])) end--;
  return [start, end];
}

function* paragraphs(text) {
  let start = 0;
  for (const match of text.matchAll(/\n\s*\n/g)) {
    yield trimmed(text, start, match.index);
    start = match.index + match[0].length;
  }
  yield trimmed(text, start, text.length);
}

// Single-spaced text of a trimmed range, with the source index of each of its characters.
function normalized(text, start, end) {
  let value = "";
  const index = [];
  for (let i = start; i < end; i++) {
    if (space.test(text[i])) {
      if (space.test(text[i - 1])) continue;
      value += " ";
    } else value += text[i];
    index.push(i);
  }
  return { value, index };
}

// Sentences are the highlight units: source ranges of `text`, in narration order. Chunks are the
// synthesis requests: whole sentences packed up to the limits, never across paragraphs. The first
// request stays small. A sentence longer than a chunk is split at words (or hard), and each piece
// becomes its own sentence. Punctuation-only fragments stay with a neighbor or are not narrated.
export function planNarration(text, { language = "en", firstLimit = 220, limit = 500 } = {}) {
  if (!Number.isInteger(firstLimit) || !Number.isInteger(limit) || firstLimit < 1 || limit < 1) {
    throw new Error("Chunk limits must be positive integers.");
  }
  const segmenter = new Intl.Segmenter(language, { granularity: "sentence" });
  const sentences = [];
  const chunks = [];
  let current = null;
  const capacity = () => chunks.length === 0 ? firstLimit : limit;
  const flush = () => { if (current) chunks.push(current); current = null; };
  const add = (start, end, value) => {
    if (!speech.test(value)) return;
    if (current && current.text.length + 1 + value.length > capacity()) flush();
    sentences.push({ start, end, length: value.length });
    if (current) {
      current.text += ` ${value}`;
      current.sentences.push(sentences.length - 1);
    } else current = { text: value, sentences: [sentences.length - 1] };
  };
  for (const [start, end] of paragraphs(text)) {
    flush();
    const ranges = [];
    for (const { index, segment } of segmenter.segment(text.slice(start, end))) {
      const range = trimmed(text, start + index, start + index + segment.length);
      if (range[0] === range[1]) continue;
      const previous = ranges.at(-1);
      if (previous && (!speech.test(text.slice(...range)) || !speech.test(text.slice(...previous)) ||
          title.test(text.slice(...previous)))) previous[1] = range[1];
      else ranges.push(range);
    }
    for (const range of ranges) {
      let { value, index } = normalized(text, ...range);
      if (current && current.text.length + 1 + value.length > capacity()) flush();
      while (value.length > capacity()) {
        let cut = value.slice(0, capacity() + 1).lastIndexOf(" ");
        if (cut <= 0) cut = capacity();
        add(index[0], index[cut - 1] + 1, value.slice(0, cut));
        flush();
        const next = value[cut] === " " ? cut + 1 : cut;
        value = value.slice(next);
        index = index.slice(next);
      }
      add(index[0], index.at(-1) + 1, value);
    }
  }
  flush();
  return { sentences, chunks };
}

export function chunkText(text, options) {
  return planNarration(text, options).chunks.map(chunk => chunk.text);
}
