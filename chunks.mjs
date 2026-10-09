// Keep the first request small; preserve paragraph boundaries and split long paragraphs at sentences/words.
export function chunkText(text, { firstLimit = 220, limit = 500 } = {}) {
  if (!Number.isInteger(firstLimit) || !Number.isInteger(limit) || firstLimit < 1 || limit < 1) {
    throw new Error("Chunk limits must be positive integers.");
  }
  const chunks = [];
  let current = "";
  const capacity = () => chunks.length === 0 ? firstLimit : limit;
  const flush = () => { if (/[\p{L}\p{N}]/u.test(current)) chunks.push(current); current = ""; };
  for (const paragraph of text.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, " ").trim()).filter(p => /[\p{L}\p{N}]/u.test(p))) {
    flush();
    let remaining = paragraph;
    while (remaining.length > capacity()) {
      const window = remaining.slice(0, capacity() + 1);
      const sentences = [...window.matchAll(/[.!?]["”']?\s/g)];
      let end = sentences.length ? sentences.at(-1).index + sentences.at(-1)[0].length - 1 : window.lastIndexOf(" ");
      if (end < capacity() / 3) end = window.lastIndexOf(" ");
      if (end <= 0 || end > capacity()) end = capacity();
      current = remaining.slice(0, end).trim();
      remaining = remaining.slice(end).trim();
      flush();
    }
    current = remaining;
  }
  flush();
  return chunks;
}
