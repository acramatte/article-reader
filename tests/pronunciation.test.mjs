import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeSamples, wordErrorRate } from "../scripts/pronunciation.mjs";

test("pronunciation WER ignores typography, not digit-by-digit misreadings", () => {
  assert.equal(wordErrorRate("C'est vingt-et-une millisecondes!", "c’est vingt et une millisecondes").wer, 0);
  assert.deepEqual(wordErrorRate("forty two hens", "four two hens today"),
    { errors: 2, referenceWords: 3, wer: 2 / 3 });
  assert.equal(wordErrorRate("nineteen ninety nine", "nineteen nine nine").wer, 1 / 3);
  assert.equal(wordErrorRate("T L D R", "").wer, 1);
  assert.equal(wordErrorRate("dixième", "dix").wer, 1);
  assert.equal(wordErrorRate("one", "one two three").wer, 2);
  assert.throws(() => wordErrorRate("...", "anything"), /Reference/);
});

test("letter runs score equally on both sides without collapsing missing letters or digits", () => {
  for (const reference of ["T L D R", "TLDR", "T-L-D-R"]) {
    for (const transcript of ["T L D R", "tldr", "T-L-D-R"]) {
      assert.deepEqual(wordErrorRate(reference, transcript), { errors: 0, referenceWords: 1, wer: 0 });
    }
  }
  assert.equal(wordErrorRate("Meet at nine a m", "Meet at nine a.m.").wer, 0);
  assert.equal(wordErrorRate("Meet at nine a.m.", "Meet at nine a m").wer, 0);
  assert.equal(wordErrorRate("T L D R", "T L R").wer, 1);
  assert.equal(wordErrorRate("one two", "1 2").errors, 2);
});

test("Whisper abbreviations expand only in transcripts and in the selected language", () => {
  assert.equal(wordErrorRate("Doctor Smith Mister Jones Missus Doe Professor Lee versus others et cetera",
    "Dr. Smith Mr. Jones Mrs. Doe Prof. Lee vs. others etc.").wer, 0);
  assert.equal(wordErrorRate("Madame Martin Docteur Dupont et cetera", "Mme Martin Dr. Dupont etc.",
    { language: "fr" }).wer, 0);
  assert.equal(wordErrorRate("dr", "doctor").wer, 1);
  assert.equal(wordErrorRate("Docteur Dupont", "Dr. Dupont").wer, 0.5);
  assert.equal(wordErrorRate("Doctor Smith", "Dr. Smith", { language: "fr" }).wer, 0.5);
  assert.equal(wordErrorRate("constructor", "constructor").wer, 0);
});

test("unsuppressed ASR verbalizes transcript digits only when explicitly selected", () => {
  const reference = "La sortie est prévue le trente septembre deux mille vingt six";
  const transcript = "La sortie est prévue le 30 septembre 2026.";
  assert.equal(wordErrorRate(reference, transcript, { language: "fr", asr: "unsuppressed" }).wer, 0);
  assert.ok(wordErrorRate(reference, transcript, { language: "fr" }).wer > 0);
  assert.equal(wordErrorRate("mille neuf cent quatre vingt dix neuf", "1999",
    { language: "fr", asr: "unsuppressed" }).wer, 0);
  assert.equal(wordErrorRate("one point five kilograms", "1.5 kilograms", { asr: "unsuppressed" }).wer, 0);
  assert.equal(wordErrorRate("1999", "mille neuf cent quatre vingt dix neuf",
    { language: "fr", asr: "unsuppressed" }).wer, 7);
});

test("transcript domain dots expand in the selected language, not references or letter runs", () => {
  assert.equal(wordErrorRate("Visit github dot com", "Visit github.com.").wer, 0);
  assert.equal(wordErrorRate("Consultez le monde point fr", "Consultez le monde.fr.", { language: "fr" }).wer, 0);
  assert.equal(wordErrorRate("Visit a dot b dot com", "Visit a.b.com").wer, 0);
  assert.equal(wordErrorRate("github.com", "github dot com").wer, 0.5);
  assert.equal(wordErrorRate("Meet at nine a m", "Meet at nine a.m.").wer, 0);
  assert.equal(wordErrorRate("one point five", "1.5", { asr: "unsuppressed" }).wer, 0);
});

test("the prepared median gates a majority of samples while retaining the mean and range", () => {
  const scores = transcripts => transcripts.map(text => wordErrorRate("one two three four five", text));
  const outlier = scores(["one two three four five", "one two three four five", "six seven eight nine ten"]);
  assert.deepEqual(summarizeSamples(outlier, 0.2), { mean: 1 / 3, median: 0, min: 0, max: 1, failed: false });
  const majority = scores(["one two six seven eight", "one two three four five", "one two six four seven"]);
  assert.equal(summarizeSamples(majority, 0.2).median, 0.4);
  assert.equal(summarizeSamples(majority, 0.2).failed, true);
  assert.equal(summarizeSamples(majority, 0.2, "raw").failed, false);
  const boundary = scores(["one two three four six", "one two three four five", "one two six four seven"]);
  assert.equal(summarizeSamples(boundary, 0.2).failed, false);
  assert.equal(summarizeSamples(boundary, 0.19).failed, true);
  assert.equal(summarizeSamples(boundary.slice(1), 0.2).median, 0.2);
  assert.equal(summarizeSamples(boundary.slice(1), 0.2).failed, false);
});
