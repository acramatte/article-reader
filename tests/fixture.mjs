export const paragraphs = [
  "The morning train crossed the valley just as the sun rose above the hills. From the window, the river looked like a silver thread winding through the fields, and the little villages were still quiet.",
  "At the station, a group of volunteers had gathered to restore the old community garden. They planted apple trees, repaired the wooden benches, and made a wide path so that everyone could enjoy the space.",
  "The project began with a conversation in the public library. Neighbors wanted somewhere to meet outside, share their knowledge, and grow fresh vegetables together. Soon, more than fifty people had offered to help.",
  "By late afternoon, the garden had changed completely. Children watered the new plants while their parents prepared a simple meal. An older resident explained how to care for the trees through the coming winter.",
  "The volunteers agreed to return every Saturday. They knew that a garden takes patience, but the first day had already given them something valuable: a place to learn, to listen, and to build a stronger community.",
];
export const html = `<!doctype html><html><head><title>A garden for everyone</title></head><body>
<nav>MENU NOISE <a href='/ads'>BUY THINGS</a></nav><main><article><h1>A garden for everyone</h1>
${paragraphs.map((p) => `<p>${p}</p>`).join("")}</article></main><aside>ADVERTISEMENT NOISE</aside>
<script>window.injected = true;</script></body></html>`;
