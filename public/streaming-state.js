export const BOOKMARK_KEY = "reader.streaming.resume.v1";
const valid = record => record && typeof record === "object" && typeof record.id === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(record.id) &&
  typeof record.title === "string" && record.title.length <= 200 &&
  Number.isFinite(record.positionSeconds) && record.positionSeconds >= 0;

// Only a session reference and best-known position, never article text or an arbitrary media URL.
export class PlaybackBookmark {
  constructor({ storage = () => localStorage, now = Date.now } = {}) {
    Object.assign(this, { storage, now, warning: null, lastSavedAt: -Infinity });
  }

  load() {
    try {
      const value = this.storage().getItem(BOOKMARK_KEY);
      if (!value) return null;
      let record;
      try { record = JSON.parse(value); } catch { /* Invalid local data is removed below. */ }
      if (valid(record)) return record;
      this.clear();
      this.warning = "Saved playback details were invalid and have been removed.";
    } catch (error) { this.warning = `Playback recovery storage unavailable: ${error.message}`; }
    return null;
  }

  save(record, force = false) {
    if (!valid(record) || (!force && this.now() - this.lastSavedAt < 5000)) return;
    try {
      const savedAt = this.now();
      this.storage().setItem(BOOKMARK_KEY, JSON.stringify({ ...record, savedAt }));
      this.lastSavedAt = savedAt;
    } catch (error) { this.warning = `Playback recovery storage unavailable: ${error.message}`; }
  }

  clear() {
    try { this.storage().removeItem(BOOKMARK_KEY); }
    catch (error) { this.warning = `Playback recovery storage unavailable: ${error.message}`; }
    this.lastSavedAt = -Infinity;
  }
}
