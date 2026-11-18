const svg = document.getElementById("graph");
const info = document.getElementById("info");
const status = document.getElementById("status");
const SVG = "http://www.w3.org/2000/svg";
const PAUSE = 30 * 60; // seconds of silence that start a new listening session

const pos = new Map(); // album -> {x, y} as fractions of the canvas, kept between refreshes so the graph doesn't jump
let data = null; // last answer from the server, redrawn on resize
let selected = null; // key of the album the visitor clicked
let graph = null; // albums and arrows currently drawn

async function load() {
  // Only our own server is called. If it is down, we still show a message.
  // relative URL: the same page works at / locally and under /music/ on the server
  const r = await fetch("api/recent").catch(() => null);
  const answer = (r && (await r.json().catch(() => null))) || { message: "The server is not answering. Try again in a minute." };

  status.classList.toggle("warn", Boolean(answer.message));
  status.textContent = answer.message
    ? answer.message + (answer.fetched_at ? ` Showing music from ${clock(answer.fetched_at)}.` : "")
    : `${answer.user} · updated ${clock(answer.fetched_at)}`;

  if (answer.tracks?.length) {
    data = answer;
    draw();
  } else if (!data) {
    svg.replaceChildren();
    info.replaceChildren(text("p", answer.message ? "Nothing to show yet." : "No music yet. Play something!", "empty"));
  }
}

// From the list of plays (newest first) to albums (nodes) and "what came next" (edges).
function model(tracks) {
  const plays = [...tracks].reverse(); // oldest first
  const nodes = new Map();
  const edges = new Map();
  let prev = null;
  plays.forEach((t, step) => {
    const key = `${t.album || t.title}|${t.artist}`;
    const time = t.played_at ?? Date.now() / 1000; // the track playing now has no date yet
    const n = nodes.get(key) || { key, plays: 0, now: false };
    Object.assign(n, { latest: t, time }); // keep the most recent play of this album
    n.plays += 1;
    n.now ||= t.now_playing;
    nodes.set(key, n);

    // Same album twice in a row: no arrow, the circle just gets bigger
    if (prev && prev.key !== key) {
      const id = `${prev.key}→${key}`;
      const e = edges.get(id) || { id, from: prev.key, to: key, count: 0 };
      e.count += 1;
      e.step = step; // when it last happened, for fading
      e.pause = time - prev.time >= PAUSE;
      edges.set(id, e);
    }
    prev = { key, time };
  });
  return { nodes: [...nodes.values()], edges: [...edges.values()], steps: plays.length };
}

// A small force layout: circles push each other away, arrows pull their two circles together.
function layout(nodes, edges, W, H) {
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  // circle area proportional to plays, scaled so all circles cover about a fifth of the canvas
  const total = nodes.reduce((s, n) => s + n.plays, 0);
  const k = Math.sqrt((0.2 * W * H) / (Math.PI * total));
  // every album already placed (refresh, resize): no forces, only fix overlaps, so nothing jumps.
  // ponytail: a new album re-runs the whole layout; pin the old circles if that reshuffle bothers
  const start = nodes.every((n) => pos.has(n.key)) ? 0 : 1;
  const spread = 0.0008 * W * H; // a bigger screen pushes circles further apart
  nodes.forEach((n, i) => {
    n.r = Math.max(10, k * Math.sqrt(n.plays));
    const p = pos.get(n.key);
    if (p) [n.x, n.y] = [p.x * W, p.y * H];
    else {
      // new album: on a spiral from the centre, in the order it was first played
      const a = i * 2.4;
      [n.x, n.y] = [W / 2 + Math.cos(a) * 25 * Math.sqrt(i), H / 2 + Math.sin(a) * 25 * Math.sqrt(i)];
    }
  });

  const TICKS = 300; // ponytail: every pair every tick, O(n²); fine up to a few hundred albums
  for (let t = 0; t < TICKS; t++) {
    const heat = start * (1 - t / TICKS); // forces fade out so the layout settles
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 0.1;
        const gap = a.r + b.r + 10;
        const push = (d < gap ? (gap - d) / 2 : 0) + (heat * spread) / d; // never overlap, plus a soft push
        a.x -= (dx / d) * push; a.y -= (dy / d) * push;
        b.x += (dx / d) * push; b.y += (dy / d) * push;
      }
    }
    for (const e of edges) {
      const a = byKey.get(e.from), b = byKey.get(e.to);
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 0.1;
      const pull = heat * 0.04 * (d - (a.r + b.r + 50)) * Math.min(e.count, 3); // repeated transitions pull harder
      a.x += (dx / d) * pull; a.y += (dy / d) * pull;
      b.x -= (dx / d) * pull; b.y -= (dy / d) * pull;
    }
    for (const n of nodes) {
      n.x += (W / 2 - n.x) * 0.02 * heat; // weak pull to the centre
      n.y += (H / 2 - n.y) * 0.02 * heat;
      n.x = Math.min(W - n.r - 14, Math.max(n.r + 14, n.x)); // stay inside the canvas, room for the green ring
      n.y = Math.min(H - n.r - 14, Math.max(n.r + 14, n.y));
    }
  }
  nodes.forEach((n) => pos.set(n.key, { x: n.x / W, y: n.y / H }));
}

function draw() {
  graph = model(data.tracks);
  const { nodes, edges, steps } = graph;
  const W = (drawnWidth = svg.clientWidth || 800);
  // phone: tall canvas; laptop: fit the screen, leaving room for the info under it
  const H = Math.round(W < 600 ? W * 1.4 : Math.max(420, Math.min(W * 0.6, innerHeight - 240)));
  layout(nodes, edges, W, H);
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const lastStep = Math.max(...edges.map((e) => e.step), 0);

  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.replaceChildren(markers());

  // arrows first, oldest first, so the recent ones end up on top
  for (const e of edges.sort((a, b) => a.step - b.step)) {
    const a = byKey.get(e.from), b = byKey.get(e.to);
    // bend each arrow to its left, so A→B and B→A don't sit on top of each other
    const cx = (a.x + b.x) / 2 - (b.y - a.y) * 0.2;
    const cy = (a.y + b.y) / 2 + (b.x - a.x) * 0.2;
    const [x1, y1] = toward(a, cx, cy, a.r + 2);
    const [x2, y2] = toward(b, cx, cy, b.r + 8);
    const latest = e.step === lastStep;
    svg.append(el("path", {
      d: `M${x1},${y1} Q${cx},${cy} ${x2},${y2}`,
      class: `edge${e.pause ? " pause" : ""}${latest ? " latest" : ""}`,
      "stroke-width": Math.min(1.5 + (e.count - 1) * 1.5, 8),
      opacity: (0.25 + 0.75 * (e.step / steps)).toFixed(2), // recent = solid, old = faded
      "marker-end": `url(#${latest ? "head-green" : "head"})`,
      "data-from": e.from,
      "data-to": e.to,
    }));
  }

  nodes.forEach((n, i) => {
    const g = el("g", {
      class: `node${n.now ? " now" : ""}`,
      transform: `translate(${n.x},${n.y})`,
      tabindex: 0,
      role: "button",
      "aria-label": `${n.latest.album || n.latest.title} by ${n.latest.artist}, ${n.plays} plays`,
      "data-key": n.key,
    });
    const fallback = () => {
      g.prepend(el("circle", { r: n.r, fill: colour(n.key) }), Object.assign(el("text", { class: "initials" }), { textContent: initials(n) }));
    };
    if (n.latest.cover) {
      const clip = el("clipPath", { id: `clip${i}` });
      clip.append(el("circle", { r: n.r }));
      const img = el("image", {
        href: n.latest.cover, x: -n.r, y: -n.r, width: 2 * n.r, height: 2 * n.r,
        "clip-path": `url(#clip${i})`, preserveAspectRatio: "xMidYMid slice",
      });
      img.addEventListener("error", () => { img.remove(); fallback(); });
      g.append(clip, img);
    } else fallback();
    g.append(el("circle", { r: n.r, class: "border" }));
    if (n.now) g.append(el("circle", { r: n.r + 5, class: "ring" }));

    g.addEventListener("mouseenter", () => select(n.key));
    g.addEventListener("focus", () => select(n.key));
    g.addEventListener("click", (ev) => { ev.stopPropagation(); select(n.key); });
    svg.append(g);
  });

  svg.onclick = () => select(null); // click on the background: show everything again
  select(selected && byKey.has(selected) ? selected : null);
}

// Highlight one album and its arrows, and describe it under the graph.
function select(key) {
  const { nodes, edges } = graph;
  selected = key;
  svg.classList.toggle("focus", Boolean(key));
  const linked = new Set([key]);
  for (const p of svg.querySelectorAll(".edge")) {
    const on = key && (p.dataset.from === key || p.dataset.to === key);
    p.classList.toggle("hl", Boolean(on));
    if (on) linked.add(p.dataset.from).add(p.dataset.to);
  }
  for (const g of svg.querySelectorAll(".node")) {
    g.classList.toggle("hl", linked.has(g.dataset.key));
    g.classList.toggle("sel", g.dataset.key === key);
  }

  // nothing selected: describe what is playing now, or the last album played
  const n = nodes.find((x) => x.key === key) || nodes.reduce((a, b) => (b.time > a.time ? b : a));
  const t = n.latest;
  const names = (list) => list.sort((a, b) => b.count - a.count).slice(0, 3)
    .map((e) => (e.from === n.key ? e.to : e.from).split("|")[0]).join(", ");
  const before = names(edges.filter((e) => e.to === n.key));
  const after = names(edges.filter((e) => e.from === n.key));

  const pic = t.cover ? Object.assign(document.createElement("img"), { src: t.cover, alt: "" }) : text("div", "", "swatch");
  if (!t.cover) pic.style.background = colour(n.key);
  // textContent, never innerHTML: track names come from outside and could contain HTML
  const lines = [
    text("p", `${t.album || t.title} — ${t.artist}`),
    text("p", `${n.plays} play${n.plays > 1 ? "s" : ""} · ${n.now ? "playing now" : `last: ${t.title}, ${ago(n.time)}`}`, "muted"),
  ];
  if (before) lines.push(text("p", `Came from: ${before}`, "muted"));
  if (after) lines.push(text("p", `Went to: ${after}`, "muted"));
  if (t.deezer) {
    const a = Object.assign(text("a", "Open in Deezer"), { href: t.deezer, target: "_blank", rel: "noopener" });
    lines.push(a);
  }
  const box = document.createElement("div");
  box.append(...lines);
  info.replaceChildren(pic, box);
}

function markers() {
  const defs = el("defs", {});
  for (const [id, fill] of [["head", "#a0a0a0"], ["head-green", "#1db954"]]) {
    const m = el("marker", { id, viewBox: "0 0 10 10", refX: 8, refY: 5, markerWidth: 9, markerHeight: 9, markerUnits: "userSpaceOnUse", orient: "auto" });
    m.append(el("path", { d: "M0,1 L9,5 L0,9 z", fill }));
    defs.append(m);
  }
  return defs;
}

function toward(n, x, y, dist) {
  const dx = x - n.x, dy = y - n.y, d = Math.hypot(dx, dy) || 1;
  return [n.x + (dx / d) * dist, n.y + (dy / d) * dist];
}

function el(tag, attrs) {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

function text(tag, content, cls) {
  const e = document.createElement(tag);
  e.textContent = content;
  if (cls) e.className = cls;
  return e;
}

function initials(n) {
  return (n.latest.album || n.latest.title).split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
}

function colour(s) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 45% 35%)`;
}

function clock(s) {
  return new Date(s * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function ago(s) {
  const min = Math.round((Date.now() / 1000 - s) / 60);
  if (min < 60) return `${min} min ago`;
  if (min < 1440) return `${Math.round(min / 60)} h ago`;
  return `${Math.round(min / 1440)} d ago`;
}

// Redraw when the width changes. Not on height: a phone changes height when its address bar hides.
let resizeTimer, drawnWidth = 0;
addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => data && svg.clientWidth !== drawnWidth && draw(), 200);
});
load();
setInterval(load, 60_000); // the server cache keeps this at one Last.fm call per minute at most
