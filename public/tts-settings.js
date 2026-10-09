// The reader and diagnostic page use the catalog of this backend instance.
export async function loadTtsSettings(select) {
  const response = await fetch("/api/config", { cache: "no-store", signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Could not load speech settings (HTTP ${response.status}).`);
  const { tts } = await response.json();
  const groups = new Map();
  for (const { id, name, group } of tts.voices) {
    if (!groups.has(group)) {
      const element = document.createElement("optgroup");
      element.label = group;
      groups.set(group, element);
    }
    groups.get(group).append(new Option(name, id));
  }
  select.replaceChildren(...groups.values());
  return tts;
}
