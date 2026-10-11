// Highlights the sentence being narrated. `container` must hold exactly the narrated text as one
// text node: sentence ranges are offsets into it. Uses the CSS Custom Highlight API, so the text
// stays a single node; browsers without it simply show no highlight.
export class NarrationHighlight {
  constructor({ container, audio, position, name = "narration", followPauseMs = 5000, now = () => performance.now() }) {
    Object.assign(this, { container, audio, position, followPauseMs, now });
    this.sentences = [];
    this.timings = [];
    this.index = -1;
    this.followPausedUntil = 0;
    if (typeof Highlight === "function" && globalThis.CSS?.highlights) {
      this.highlight = new Highlight();
      CSS.highlights.set(name, this.highlight);
    }
    // Reading ahead or back pauses auto-follow; programmatic scrolling does not raise these events.
    const pauseFollow = () => { this.followPausedUntil = this.now() + this.followPauseMs; };
    for (const type of ["wheel", "touchmove", "pointerdown", "keydown"]) container.addEventListener(type, pauseFollow, { passive: true });
    const tick = () => {
      this.update();
      this.frame = this.audio.paused ? null : requestAnimationFrame(tick);
    };
    const start = () => { if (!this.frame) this.frame = requestAnimationFrame(tick); };
    audio.addEventListener("playing", start);
    for (const type of ["pause", "ended", "seeked", "timeupdate"]) audio.addEventListener(type, () => this.update());
  }

  // Timings and sentence ranges arrive separately (SSE, admission, recovery content): always redraw.
  setTimeline(sentences, timings) {
    this.sentences = sentences;
    this.timings = timings;
    this.show(this.find(this.position()));
  }

  clear() {
    this.sentences = [];
    this.timings = [];
    this.show(-1);
  }

  // The timed sentence playing at `seconds` of the recording, or -1. Timings are known for a prefix.
  find(seconds) {
    let low = 0;
    let high = this.timings.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (this.timings[middle][0] <= seconds) low = middle + 1;
      else high = middle - 1;
    }
    return high >= 0 && seconds < this.timings[high][1] ? high : -1;
  }

  update() {
    const index = this.find(this.position());
    if (index !== this.index) this.show(index);
  }

  show(index) {
    this.index = index;
    if (!this.highlight) return;
    this.highlight.clear();
    const node = this.container.firstChild;
    const sentence = this.sentences[index];
    if (!sentence || node?.nodeType !== Node.TEXT_NODE || sentence[1] > node.length) return;
    const range = new Range();
    range.setStart(node, sentence[0]);
    range.setEnd(node, sentence[1]);
    this.highlight.add(range);
    this.follow(range);
  }

  // Keep the sentence in view inside the scrolling article body, never by scrolling the page.
  follow(range) {
    if (this.now() < this.followPausedUntil) return;
    const box = this.container.getBoundingClientRect();
    const sentence = range.getBoundingClientRect();
    if (!box.height || (sentence.top >= box.top + box.height * 0.1 && sentence.bottom <= box.bottom - box.height * 0.1)) return;
    this.container.scrollTo({ top: this.container.scrollTop + sentence.top - box.top - box.height * 0.25,
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }
}
