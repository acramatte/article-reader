import { test } from "node:test";
import assert from "node:assert/strict";
import { PlaybackBookmark, BOOKMARK_KEY } from "../public/streaming-state.js";

const id = "81b16cd8-fab8-4ed9-b855-7f127299e944";
const record = { id, title: "A narration", positionSeconds: 6.25 };
function fixture() {
  const items = new Map();
  let writes = 0;
  const storage = { getItem: key => items.get(key) ?? null,
    setItem: (key, value) => { writes++; items.set(key, value); }, removeItem: key => items.delete(key) };
  let time = 10_000;
  const bookmark = new PlaybackBookmark({ storage: () => storage, now: () => time });
  return { bookmark, storage, writes: () => writes, advance: ms => { time += ms; } };
}

test("bookmark survives a new page instance, throttles ticks and saves pause immediately", () => {
  const f = fixture();
  f.bookmark.save(record);
  assert.equal(f.writes(), 1);
  f.bookmark.save({ ...record, positionSeconds: 7 });
  assert.equal(f.writes(), 1);
  f.advance(5000);
  f.bookmark.save({ ...record, positionSeconds: 8 });
  f.bookmark.save({ ...record, positionSeconds: 8.25 }, true);
  assert.equal(f.writes(), 3);
  const loaded = new PlaybackBookmark({ storage: () => f.storage }).load();
  assert.equal(loaded.id, id);
  assert.equal(loaded.positionSeconds, 8.25);
  assert.equal(loaded.title, record.title);
  f.bookmark.clear();
  assert.equal(f.bookmark.load(), null);
});

test("invalid bookmarks are removed before they can construct a media or status URL", () => {
  for (const value of ["not json", "null", JSON.stringify({ ...record, id: "../../other" }),
    JSON.stringify({ ...record, id: [id] }),
    JSON.stringify({ ...record, positionSeconds: -1 }), JSON.stringify({ ...record, positionSeconds: "6" }),
    JSON.stringify({ ...record, title: "x".repeat(201) })]) {
    const f = fixture();
    f.storage.setItem(BOOKMARK_KEY, value);
    assert.equal(f.bookmark.load(), null);
    assert.equal(f.storage.getItem(BOOKMARK_KEY), null);
    assert.ok(f.bookmark.warning);
  }
});

test("unavailable browser storage is explicit but does not prevent playback", () => {
  const bookmark = new PlaybackBookmark({ storage: () => { throw new Error("Storage blocked"); } });
  assert.equal(bookmark.load(), null);
  assert.doesNotThrow(() => bookmark.save(record, true));
  assert.doesNotThrow(() => bookmark.clear());
  assert.match(bookmark.warning, /unavailable/);
});
