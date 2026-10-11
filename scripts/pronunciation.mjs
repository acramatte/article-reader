import { readFile, writeFile, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { planNarration } from "../chunks.mjs";
import { numberWords } from "../number-words.mjs";

const asrAbbreviations = {
  en: { dr: "doctor", mr: "mister", mrs: "missus", prof: "professor", vs: "versus", etc: "et cetera" },
  fr: { mme: "madame", dr: "docteur", etc: "et cetera" },
};

// Keep accents; ignore typography and join spelled letter runs on both sides.
export function words(text) {
  const tokens = text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const result = [];
  for (let i = 0; i < tokens.length;) {
    let end = i + 1;
    if (/^\p{L}$/u.test(tokens[i])) {
      while (end < tokens.length && /^\p{L}$/u.test(tokens[end])) end++;
    }
    result.push(tokens.slice(i, end).join(""));
    i = end;
  }
  return result;
}

export function wordErrorRate(reference, transcript, { language = "en", asr = "suppressed" } = {}) {
  transcript = transcript.normalize("NFKC").toLowerCase();
  transcript = transcript.replace(/\p{L}+(?:\.\p{L}+)+/gu, domain =>
    domain.split(".").every(part => /^\p{L}$/u.test(part)) ? domain :
      domain.replaceAll(".", language === "fr" ? " point " : " dot "));
  if (asr === "unsuppressed") {
    transcript = transcript.replace(/\d+(?:[.,]\d+)*/g, raw => {
      const spoken = numberWords(raw, language);
      return spoken === null ? raw : ` ${spoken} `;
    });
  }
  const abbreviations = asrAbbreviations[language] ?? {};
  transcript = transcript.replace(/[\p{L}\p{N}]+/gu,
    word => Object.hasOwn(abbreviations, word) ? abbreviations[word] : word);
  const expected = words(reference);
  const actual = words(transcript);
  if (!expected.length) throw new Error("Reference must contain words.");
  let previous = Array.from({ length: actual.length + 1 }, (_, i) => i);
  for (let i = 1; i <= expected.length; i++) {
    const row = [i];
    for (let j = 1; j <= actual.length; j++) {
      row[j] = Math.min(previous[j] + 1, row[j - 1] + 1,
        previous[j - 1] + (expected[i - 1] === actual[j - 1] ? 0 : 1));
    }
    previous = row;
  }
  const errors = previous.at(-1);
  return { errors, referenceWords: expected.length, wer: errors / expected.length };
}

export function summarizeSamples(runs, threshold, mode = "prepared") {
  // References are identical within a case; integer edit totals avoid rounding
  // an exact threshold upward, including the two middle scores of an even set.
  const errors = runs.map(run => run.errors).sort((a, b) => a - b);
  const referenceWords = runs[0].referenceWords;
  const mean = errors.reduce((sum, value) => sum + value, 0) / (runs.length * referenceWords);
  const median = (errors[Math.floor((runs.length - 1) / 2)] + errors[Math.floor(runs.length / 2)]) /
    (2 * referenceWords);
  const min = Math.min(...runs.map(run => run.wer));
  const max = Math.max(...runs.map(run => run.wer));
  return { mean, median, min, max, failed: mode === "prepared" && median > threshold };
}

async function main() {
  const { values } = parseArgs({ options: {
    cases: { type: "string", default: "tests/fixtures/pronunciation.json" },
    out: { type: "string", default: `/tmp/pronunciation-${Date.now()}` },
    url: { type: "string", default: process.env.TTS_URL || "http://127.0.0.1:8000/tts" },
    python: { type: "string", default: "python3" },
    model: { type: "string", default: "small" },
    samples: { type: "string", default: "3" },
    threshold: { type: "string", default: "0.2" },
    "english-voice": { type: "string", default: "jane" },
    baseline: { type: "boolean", default: false },
    "asr-diagnostic": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  } });
  if (values.help) {
    console.log("node scripts/pronunciation.mjs [--cases FILE] [--out NEW_DIR] [--baseline] [--asr-diagnostic]\n" +
      "  [--samples 3] [--threshold 0.2] [--english-voice jane|bill_boerst]\n" +
      "  [--url http://127.0.0.1:8000/tts] [--python python3] [--model small|LOCAL_PATH]");
    return;
  }
  const samples = Number(values.samples);
  const threshold = Number(values.threshold);
  if (!Number.isInteger(samples) || samples < 2) throw new Error("Use at least two samples.");
  if (!Number.isFinite(threshold) || threshold < 0) throw new Error("Threshold must be nonnegative.");
  if (!["jane", "bill_boerst"].includes(values["english-voice"])) throw new Error("Unknown English voice.");
  const cases = JSON.parse(await readFile(values.cases, "utf8"));
  const ids = new Set();
  if (!Array.isArray(cases) || !cases.length) throw new Error("Case file must be a nonempty JSON array.");
  for (const item of cases) {
    if (!item || typeof item.id !== "string" || !/^[a-z0-9-]+$/.test(item.id) || ids.has(item.id) ||
        !["en", "fr"].includes(item.language) || typeof item.text !== "string" || !item.text.trim() ||
        typeof item.reference !== "string" || !words(item.reference).length ||
        (item.asr !== undefined && item.asr !== "unsuppressed")) {
      throw new Error("Each case needs a unique slug id, en/fr language, text and spoken reference; optional asr must be unsuppressed.");
    }
    ids.add(item.id);
  }
  const out = resolve(values.out);
  // Refuse an existing directory: never overwrite someone's listening evidence.
  await mkdir(out, { recursive: false });
  console.log(`Evidence directory: ${out}`);
  const manifest = { model: values.model, samples, threshold, englishVoice: values["english-voice"],
    asrDiagnostic: values["asr-diagnostic"], startedAt: new Date().toISOString(), cases, recordings: [] };
  const save = (name, data) => writeFile(resolve(out, name), JSON.stringify(data, null, 2) + "\n");
  await save("manifest.json", manifest);
  for (const item of cases) {
    const voice = item.language === "fr" ? "estelle" : values["english-voice"];
    const prepared = planNarration(item.text, { language: item.language }).chunks.map(chunk => chunk.text);
    if (!prepared.length) throw new Error(`${item.id}: nothing to narrate.`);
    const modes = values.baseline ? ["raw", "prepared"] : ["prepared"];
    for (const mode of modes) {
      const texts = mode === "raw" ? [item.text] : prepared;
      for (let sample = 1; sample <= samples; sample++) {
        const recording = { id: item.id, language: item.language, voice, mode, sample,
          asr: item.asr ?? "suppressed", texts, files: [] };
        for (let chunk = 0; chunk < texts.length; chunk++) {
          const file = `${item.id}-${mode}-${sample}-${chunk + 1}.wav`;
          const response = await fetch(values.url, { method: "POST", signal: AbortSignal.timeout(300_000),
            headers: { "Content-Type": "application/json",
              ...(process.env.TTS_TOKEN ? { Authorization: `Bearer ${process.env.TTS_TOKEN}` } : {}) },
            body: JSON.stringify({ text: texts[chunk], voice, speed: 1 }) });
          if (!response.ok) throw new Error(`${file}: TTS HTTP ${response.status}`);
          if (!response.headers.get("content-type")?.startsWith("audio/wav")) throw new Error(`${file}: expected WAV.`);
          await writeFile(resolve(out, file), Buffer.from(await response.arrayBuffer()));
          recording.files.push(file);
        }
        manifest.recordings.push(recording);
        await save("manifest.json", manifest);
        console.log(`Synthesized ${item.id} ${voice} ${mode} ${sample}/${samples}`);
      }
    }
  }
  // Load Whisper once, after synthesis, rather than once per short clip.
  const helper = fileURLToPath(new URL("./pronunciation-whisper.py", import.meta.url));
  await new Promise((done, reject) => {
    const child = spawn(values.python, [helper, resolve(out, "manifest.json")], { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", code => code === 0 ? done() : reject(new Error(`Whisper exited ${code}; WAVs retained in ${out}`)));
  });
  const transcripts = JSON.parse(await readFile(resolve(out, "transcripts.json"), "utf8"));
  const results = [];
  for (const item of cases) {
    for (const mode of values.baseline ? ["raw", "prepared"] : ["prepared"]) {
      const runs = transcripts.filter(run => run.id === item.id && run.mode === mode)
        .map(run => {
          const scoredTranscript = item.asr === "unsuppressed" ? run.unsuppressedTranscript : run.transcript;
          if (typeof scoredTranscript !== "string") throw new Error(`${item.id}: missing scoring transcript.`);
          return { ...run, scoredTranscript,
            ...wordErrorRate(item.reference, scoredTranscript, { language: item.language, asr: item.asr }) };
        });
      if (runs.length !== samples) throw new Error(`${item.id}: incomplete transcripts.`);
      const { mean, median, min, max, failed } = summarizeSamples(runs, threshold, mode);
      results.push({ id: item.id, language: item.language, asr: item.asr ?? "suppressed", mode, mean, median, min, max, failed, runs });
      console.log(`${failed ? "FAIL" : mode === "raw" ? "BASE" : "PASS"} ${item.id} ${mode}: ` +
        `median ${(median * 100).toFixed(1)}%, mean ${(mean * 100).toFixed(1)}%, range ${(min * 100).toFixed(1)}–${(max * 100).toFixed(1)}%`);
    }
  }
  await save("report.json", { ...manifest, asr: JSON.parse(await readFile(resolve(out, "whisper.json"), "utf8")), results });
  console.log(`Evidence: ${out}/report.json (and WAVs, manifest, transcripts).`);
  if (results.some(result => result.failed)) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 2; });
}
