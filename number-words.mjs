// Number words for speech. Pocket TTS tokenizes digits one by one and misreads most numbers of two
// or more digits ("42" → "four two"); spelled-out numbers are read correctly.

export const maxSpoken = 999_999_999_999;

const englishOnes = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
  "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const englishTens = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

function englishBelow100(n) {
  if (n < 20) return englishOnes[n];
  return n % 10 ? `${englishTens[Math.floor(n / 10)]}-${englishOnes[n % 10]}` : englishTens[n / 10];
}

function englishBelow1000(n) {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  return [hundreds ? `${englishOnes[hundreds]} hundred` : "", rest ? englishBelow100(rest) : ""].filter(Boolean).join(" ");
}

// "one hundred twenty-eight thousand", without "and".
export function englishCardinal(n) {
  if (n === 0) return "zero";
  const parts = [];
  for (const [scale, name] of [[1e9, "billion"], [1e6, "million"], [1e3, "thousand"], [1, ""]]) {
    const group = Math.floor(n / scale) % 1000;
    if (group) parts.push([englishBelow1000(group), name].filter(Boolean).join(" "));
  }
  return parts.join(" ");
}

const englishOrdinals = { one: "first", two: "second", three: "third", five: "fifth", eight: "eighth", nine: "ninth", twelve: "twelfth" };
export function englishOrdinal(n) {
  return englishCardinal(n).replace(/[a-z]+$/, word => englishOrdinals[word] ?? (word.endsWith("y") ? `${word.slice(0, -1)}ieth` : `${word}th`));
}

// Years as spoken: "nineteen ninety-nine", "nineteen oh five", "nineteen hundred", "two thousand five", "twenty twenty-six".
export function englishYear(n) {
  const century = Math.floor(n / 100);
  const rest = n % 100;
  if (n >= 2000 && n < 2010) return englishCardinal(n);
  if (!rest) return `${englishBelow100(century)} hundred`;
  return `${englishBelow100(century)} ${rest < 10 ? `oh ${englishOnes[rest]}` : englishBelow100(rest)}`;
}

// "the 1990s" → "the nineteen nineties".
export function englishPlural(words) {
  return words.replace(/[a-z]+$/, word => word.endsWith("y") ? `${word.slice(0, -1)}ies` : `${word}s`);
}

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

// Traditional spelling: "vingt et un", "quatre-vingts", "deux cents", "deux cent mille", "deux millions".
export function frenchCardinal(n) {
  if (n === 0) return "zéro";
  const parts = [];
  for (const [scale, name] of [[1e9, "milliard"], [1e6, "million"]]) {
    const group = Math.floor(n / scale) % 1000;
    if (group) parts.push(`${group === 1 ? "un" : frenchBelow1000(group)} ${name}${group > 1 ? "s" : ""}`);
  }
  const thousands = Math.floor(n / 1000) % 1000;
  // "Cent" and "vingt" lose their plural before "mille", which is invariable.
  if (thousands) parts.push(thousands === 1 ? "mille" : `${frenchBelow1000(thousands).replace(/(cent|vingt)s$/, "$1")} mille`);
  if (n % 1000) parts.push(frenchBelow1000(n % 1000));
  return parts.join(" ");
}

// "10e" → "dixième": the last word of the cardinal takes the ordinal suffix.
export function frenchOrdinal(n) {
  return frenchCardinal(n).replace(/[^\s-]+$/, word => {
    if (word === "cinq") return "cinquième";
    if (word === "neuf") return "neuvième";
    return `${word.replace(/^(cent|vingt|million|milliard)s$/, "$1").replace(/e$/, "")}ième`;
  });
}

// Digits as written ("1,000.5", "128 000", "1,5") in words, or null when out of range or a leading-zero code.
export function numberWords(raw, language) {
  const fr = language === "fr";
  const match = fr ? /^(\d{1,3}(?:[   ]\d{3})+|\d+)(?:[.,](\d+))?$/.exec(raw)
    : /^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?$/.exec(raw);
  if (!match) return null;
  const digits = match[1].replace(/\D/g, "");
  if (digits.length > 1 && digits.startsWith("0")) return null;
  const n = Number(digits);
  if (n > maxSpoken) return null;
  const cardinal = fr ? frenchCardinal : englishCardinal;
  if (!match[2]) return cardinal(n);
  const ones = fr ? frenchUnits : englishOnes;
  const fraction = fr && !match[2].startsWith("0") && match[2].length <= 3 ? frenchCardinal(Number(match[2]))
    : [...match[2]].map(digit => ones[digit]).join(" ");
  return `${cardinal(n)} ${fr ? "virgule" : "point"} ${fraction}`;
}
