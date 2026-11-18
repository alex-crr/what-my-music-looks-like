const svg = document.getElementById("graph");
const info = document.getElementById("info");
const kernelList = document.getElementById("kernels");
const status = document.getElementById("status");
const SVG = "http://www.w3.org/2000/svg";
const COLOURS = ["#a78bfa", "#f472b6", "#34d399", "#fbbf24", "#60a5fa", "#f87171", "#2dd4bf", "#fb923c"];
const LONE = "#8a8a93"; // albums in no kernel

const pos = new Map(); // album -> {x, y}, kept between refreshes so nothing jumps
let data = null; // last answer from the server
let graph = null; // { nodes, edges, byKey, kernels, steps }
let selected = null; // an album key, or "kernel:<n>"
let view = { x: 0, y: 0, k: 1 }; // pan and zoom
let autoFit = true; // keep the whole graph in view until the visitor pans or zooms
let alpha = 0, alphaTarget = 0, running = false; // the simulation's "heat": forces fade as it cools
let W = 800, H = 500, layer = null;
let ticks = 0; // steps since the first layout started

// ---------- data ----------

async function load() {
  // relative URL: the same page works at / locally and under /music/ on the server
  const r = await fetch("api/recent").catch(() => null);
  const answer = (r && (await r.json().catch(() => null))) || { message: "The server is not answering. Try again in a minute." };

  status.classList.toggle("warn", Boolean(answer.message));
  status.textContent = answer.message
    ? answer.message + (answer.fetched_at ? ` Showing music from ${clock(answer.fetched_at)}.` : "")
    : `${answer.user} · updated ${clock(answer.fetched_at)}` +
      (answer.history_days ? ` · last ${answer.history_days} days with my Deezer history, most played albums` : "");

  if (answer.tracks?.length) {
    data = answer;
    update();
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
    const key = t.key; // album, from the server
    const time = t.played_at ?? Date.now() / 1000; // the track playing now has no date yet
    const n = nodes.get(key) || { key, plays: 0, now: false };
    Object.assign(n, { latest: t, time });
    n.plays += 1;
    n.now ||= t.now_playing;
    nodes.set(key, n);

    // Same album twice in a row: no line, the circle just gets bigger
    if (prev && prev.key !== key) {
      const pause = t.session !== prev.session; // sessions come from the server, counted before albums were left out
      const id = `${prev.key}→${key}`;
      const e = edges.get(id) || { id, from: prev.key, to: key, count: 0, weight: 0 };
      e.count += 1;
      e.weight += pause ? 0.2 : 1; // inside a session it says "these go together"; after a pause, much less
      e.step = step; // when it last happened, for fading
      e.pause = pause;
      edges.set(id, e);
    }
    prev = { key, session: t.session };
  });
  const list = [...nodes.values()];
  // size weighted against my most played album: played once = small dot, most played = biggest circle
  const most = Math.max(...list.map((n) => n.plays));
  list.forEach((n) => (n.r = 10 + 20 * Math.sqrt((n.plays - 1) / Math.max(1, most - 1)))); // 10 to 30
  const links = [...edges.values()];
  return { nodes: list, edges: links, byKey: nodes, kernels: findKernels(list, links), steps: plays.length };
}

// ---------- kernels ----------

// Kernels are groups of albums I play together. The lines become undirected weights
// (A→B and B→A add up), Louvain finds the groups, and each group of 2+ albums gets a colour.
function findKernels(nodes, edges) {
  const weights = new Map();
  for (const e of edges) {
    const id = [e.from, e.to].sort().join("\0");
    weights.set(id, (weights.get(id) || 0) + e.weight);
  }
  const group = louvain(nodes.map((n) => n.key), [...weights].map(([id, w]) => [...id.split("\0"), w]));
  const groups = new Map();
  for (const n of nodes) groups.set(group.get(n.key), [...(groups.get(group.get(n.key)) || []), n]);
  const kernels = [...groups.values()].filter((g) => g.length >= 2).sort((a, b) => total(b) - total(a));
  nodes.forEach((n) => Object.assign(n, { kernel: -1, colour: LONE }));
  kernels.forEach((members, i) => members.forEach((n) => Object.assign(n, { kernel: i, colour: COLOURS[i % COLOURS.length] })));
  return kernels;
}

// Louvain community detection (Blondel et al., 2008), the method Gephi uses.
// 1. Move each album into the neighbouring group that most raises "modularity":
//    the weight of lines inside groups, compared with what random lines would give.
// 2. Merge each group into a single node and start again, until nothing moves.
function louvain(keys, links) {
  const member = new Map(keys.map((k) => [k, k])); // album -> its group
  let nodes = keys, edges = links;
  for (let level = 0; level < 10; level++) {
    const { group, moved } = localMoves(nodes, edges);
    if (!moved) break;
    for (const [k, g] of member) member.set(k, group.get(g));
    const merged = new Map();
    for (const [a, b, w] of edges) {
      const id = [group.get(a), group.get(b)].sort().join("\0"); // lines inside a group become a self-loop
      merged.set(id, (merged.get(id) || 0) + w);
    }
    nodes = [...new Set(group.values())];
    edges = [...merged].map(([id, w]) => [...id.split("\0"), w]);
  }
  return member;
}

function localMoves(nodes, edges) {
  const near = new Map(nodes.map((n) => [n, []]));
  const degree = new Map(nodes.map((n) => [n, 0]));
  let twice = 0; // twice the total weight
  for (const [a, b, w] of edges) {
    degree.set(a, degree.get(a) + w);
    degree.set(b, degree.get(b) + w);
    twice += 2 * w;
    if (a !== b) near.get(a).push([b, w]), near.get(b).push([a, w]);
  }
  const group = new Map(nodes.map((n) => [n, n]));
  const size = new Map(degree); // sum of degrees per group
  let moved = false, again = twice > 0;
  while (again) {
    again = false;
    for (const n of nodes) {
      const own = group.get(n), k = degree.get(n);
      const toGroup = new Map();
      for (const [m, w] of near.get(n)) toGroup.set(group.get(m), (toGroup.get(group.get(m)) || 0) + w);
      size.set(own, size.get(own) - k); // take n out of its group, then put it where it gains most
      let best = own, bestGain = (toGroup.get(own) || 0) - (size.get(own) * k) / twice;
      for (const [g, w] of toGroup) {
        const gain = w - (size.get(g) * k) / twice;
        if (gain > bestGain + 1e-9) [best, bestGain] = [g, gain];
      }
      size.set(best, size.get(best) + k);
      if (best !== own) group.set(n, best), (moved = again = true);
    }
  }
  return { group, moved };
}

// ---------- layout: a small force simulation, like Obsidian's graph ----------

function tick() {
  const { nodes, edges, byKey, kernels } = graph;
  // every pair pushes apart, less with distance
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      const dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy || 1;
      if (d2 > 250000) continue; // further than 500: negligible
      const f = (300 * alpha) / d2;
      a.vx -= dx * f; a.vy -= dy * f;
      b.vx += dx * f; b.vy += dy * f;
    }
  }
  // each line is a spring; heavier lines (repeated, same session) pull harder
  for (const e of edges) {
    const a = byKey.get(e.from), b = byKey.get(e.to);
    const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
    const f = ((d - (a.r + b.r + 30)) / d) * alpha * 0.08 * Math.min(e.weight, 4);
    a.vx += dx * f; a.vy += dy * f;
    b.vx -= dx * f; b.vy -= dy * f;
  }
  // albums of one kernel drift toward the kernel's centre, so kernels form separate clumps
  for (const members of kernels) {
    const cx = mean(members, "x"), cy = mean(members, "y");
    for (const n of members) {
      n.vx += (cx - n.x) * 0.03 * alpha;
      n.vy += (cy - n.y) * 0.03 * alpha;
    }
  }
  const gx = (0.006 * H) / W, gy = (0.006 * W) / H; // pull to the middle, shaped like the frame
  for (const n of nodes) {
    n.vx -= n.x * gx * alpha; // a tall phone frame gets a tall layout, a wide laptop frame a wide one
    n.vy -= n.y * gy * alpha;
    if (n.fixed) { n.vx = n.vy = 0; continue; } // the circle being dragged follows the pointer
    n.vx *= 0.6; n.vy *= 0.6; // friction
    n.x += n.vx; n.y += n.vy;
  }
  // circles never overlap
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1, gap = a.r + b.r + 4;
      if (d >= gap) continue;
      const push = (gap - d) / 2 / d;
      if (!a.fixed) { a.x -= dx * push; a.y -= dy * push; }
      if (!b.fixed) { b.x += dx * push; b.y += dy * push; }
    }
  }
  alpha += (alphaTarget - alpha) * 0.03; // cool down
}

// A force layout has no fixed orientation. Early in the first settling, turn it a quarter turn
// if it is wide in a tall frame (phone) or tall in a wide frame (laptop), so it fills the frame.
function orient() {
  const xs = graph.nodes.map((n) => n.x), ys = graph.nodes.map((n) => n.y);
  const wide = Math.max(...xs) - Math.min(...xs) > Math.max(...ys) - Math.min(...ys);
  if (wide === W > H) return;
  for (const n of graph.nodes) [n.x, n.y, n.vx, n.vy] = [-n.y, n.x, -n.vy, n.vx];
}

function reheat(a) {
  alpha = Math.max(alpha, a);
  if (!running) { running = true; requestAnimationFrame(step); }
}

function step() {
  tick();
  if (++ticks === 60) orient();
  for (const n of graph.nodes) pos.set(n.key, { x: n.x, y: n.y });
  if (autoFit) fit();
  render();
  if (alpha > 0.01 || alphaTarget > 0) requestAnimationFrame(step);
  else running = false;
}

// ---------- drawing ----------

function update() {
  const first = !graph;
  graph = model(data.tracks);
  const fresh = graph.nodes.filter((n) => !pos.has(n.key)).length;
  place();
  build();
  if (fresh) reheat(first ? 1 : 0.3); // a new album: let the layout adjust; otherwise nothing moves
}

// Start positions: where the album was last time, else next to the album played before it.
function place() {
  graph.nodes.forEach((n, i) => {
    const p = pos.get(n.key);
    const from = !p && graph.edges.find((e) => e.to === n.key && pos.has(e.from));
    const base = p || (from && pos.get(from.from)) || { x: 0, y: 0 };
    const a = i * 2.4, d = p ? 0 : from ? 30 : 15 * Math.sqrt(i);
    Object.assign(n, { x: base.x + Math.cos(a) * d, y: base.y + Math.sin(a) * d, vx: 0, vy: 0 });
  });
}

function build() {
  W = svg.clientWidth || 800;
  H = Math.round(W < 600 ? W * 1.15 : Math.max(420, Math.min(W * 0.6, innerHeight - 280)));
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  layer = el("g", {});
  svg.replaceChildren(markers(), layer);

  const lastStep = Math.max(0, ...graph.edges.map((e) => e.step));
  for (const e of graph.edges.sort((a, b) => a.step - b.step)) { // recent lines drawn last, on top
    const a = graph.byKey.get(e.from), b = graph.byKey.get(e.to);
    const inner = a.kernel >= 0 && a.kernel === b.kernel;
    const latest = e.step === lastStep;
    e.el = el("line", {
      class: `edge${e.pause ? " pause" : ""}${inner ? " inner" : ""}${latest ? " latest" : ""}`,
      style: `--c:${a.colour}`,
      "stroke-width": 1 + Math.log2(e.count),
      "vector-effect": "non-scaling-stroke", // same thickness at every zoom
      // recent = solid, old = faded; lines between two kernels fainter, so the kernels stand out
      opacity: ((0.3 + 0.7 * (e.step / graph.steps)) * (inner ? 1 : 0.45)).toFixed(2),
      "marker-end": `url(#${latest ? "head-green" : "head"})`,
    });
    layer.append(e.el);
  }

  graph.nodes.forEach((n, i) => {
    const g = el("g", {
      class: `node${n.now ? " now" : ""}`, style: `--c:${n.colour}`, tabindex: 0, role: "button",
      "aria-label": `${name(n)} by ${n.latest.artist}, ${n.plays} plays`, "data-key": n.key,
    });
    const fallback = () => {
      g.prepend(el("circle", { r: n.r, fill: n.colour, opacity: 0.6 }));
      if (n.r >= 10) g.append(Object.assign(el("text", { class: "initials" }), { textContent: initials(n) })); // no room in a small dot
    };
    if (n.latest.cover) {
      const clip = el("clipPath", { id: `clip${i}` });
      clip.append(el("circle", { r: n.r }));
      const img = el("image", { href: n.latest.cover, x: -n.r, y: -n.r, width: 2 * n.r, height: 2 * n.r, "clip-path": `url(#clip${i})`, preserveAspectRatio: "xMidYMid slice" });
      img.addEventListener("error", () => { img.remove(); fallback(); });
      g.append(clip, img);
    } else fallback();
    g.append(el("circle", { r: n.r, class: "ring" }));
    if (n.now) g.append(el("circle", { r: n.r + 5, class: "now-ring" }));
    g.addEventListener("pointerenter", (ev) => ev.pointerType === "mouse" && !drag && select(n.key));
    g.addEventListener("focus", () => select(n.key));
    n.el = g;
    layer.append(g);
  });

  render();
  if (autoFit) fit(); else applyView();
  renderKernels();
  const ok = selected && (graph.byKey.has(selected) || graph.kernels[+selected.split(":")[1]]);
  select(ok ? selected : null);
}

function render() {
  for (const n of graph.nodes) n.el.setAttribute("transform", `translate(${n.x.toFixed(1)},${n.y.toFixed(1)})`);
  for (const e of graph.edges) {
    const a = graph.byKey.get(e.from), b = graph.byKey.get(e.to);
    const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
    // from edge to edge of the two circles, leaving room for the arrowhead
    e.el.setAttribute("x1", (a.x + (dx / d) * a.r).toFixed(1));
    e.el.setAttribute("y1", (a.y + (dy / d) * a.r).toFixed(1));
    e.el.setAttribute("x2", (b.x - (dx / d) * (b.r + 3)).toFixed(1));
    e.el.setAttribute("y2", (b.y - (dy / d) * (b.r + 3)).toFixed(1));
  }
}

// ---------- zoom, pan, drag ----------

function fit() {
  const ns = graph.nodes, pad = 24;
  const minX = Math.min(...ns.map((n) => n.x - n.r)) - pad, maxX = Math.max(...ns.map((n) => n.x + n.r)) + pad;
  const minY = Math.min(...ns.map((n) => n.y - n.r)) - pad, maxY = Math.max(...ns.map((n) => n.y + n.r)) + pad;
  const k = Math.min(W / (maxX - minX), H / (maxY - minY), 2.5);
  view = { k, x: W / 2 - ((minX + maxX) / 2) * k, y: H / 2 - ((minY + maxY) / 2) * k };
  applyView();
}

function applyView() {
  layer.setAttribute("transform", `translate(${view.x},${view.y}) scale(${view.k})`);
}

function zoomAt(p, factor) {
  const k = Math.min(6, Math.max(0.2, view.k * factor));
  const w = toWorld(p);
  view = { k, x: p.x - w.x * k, y: p.y - w.y * k };
  autoFit = false;
  applyView();
}

const point = (ev) => {
  const box = svg.getBoundingClientRect();
  return { x: ((ev.clientX - box.left) * W) / box.width, y: ((ev.clientY - box.top) * H) / box.height };
};
const toWorld = (p) => ({ x: (p.x - view.x) / view.k, y: (p.y - view.y) / view.k });
const pointers = new Map(); // fingers or mouse currently down
let drag = null;

svg.addEventListener("pointerdown", (ev) => {
  if (!graph) return;
  svg.setPointerCapture(ev.pointerId);
  pointers.set(ev.pointerId, point(ev));
  if (pointers.size === 2) { // second finger: pinch to zoom
    if (drag?.node) drag.node.fixed = false;
    drag = { pinch: true, dist: spread(), k: view.k };
    return;
  }
  const hit = ev.target.closest(".node");
  drag = { node: hit && graph.byKey.get(hit.dataset.key), last: point(ev), moved: 0 };
  if (drag.node) { drag.node.fixed = true; alphaTarget = 0.3; reheat(0.3); }
  else svg.classList.add("panning");
});

svg.addEventListener("pointermove", (ev) => {
  if (!pointers.has(ev.pointerId) || !drag) return;
  const p = point(ev);
  pointers.set(ev.pointerId, p);
  if (drag.pinch) {
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      zoomAt({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, (drag.k * spread()) / drag.dist / view.k);
    }
    return;
  }
  drag.moved += Math.hypot(p.x - drag.last.x, p.y - drag.last.y);
  if (drag.node) {
    Object.assign(drag.node, toWorld(p));
    if (drag.moved > 5) autoFit = false; // don't rescale under the finger
    render();
  } else {
    view.x += p.x - drag.last.x;
    view.y += p.y - drag.last.y;
    autoFit = false;
    applyView();
  }
  drag.last = p;
});

function release(ev) {
  pointers.delete(ev.pointerId);
  if (!drag) return;
  if (drag.pinch) { if (!pointers.size) drag = null; return; }
  if (drag.node) { drag.node.fixed = false; alphaTarget = 0; }
  if (drag.moved < 5) select(drag.node ? drag.node.key : null); // a tap, not a drag
  svg.classList.remove("panning");
  drag = null;
}
svg.addEventListener("pointerup", release);
svg.addEventListener("pointercancel", release);
svg.addEventListener("wheel", (ev) => { ev.preventDefault(); zoomAt(point(ev), Math.exp(-ev.deltaY * 0.0015)); }, { passive: false });
document.getElementById("fit").addEventListener("click", () => { autoFit = true; graph && fit(); });

function spread() {
  const [a, b] = [...pointers.values()];
  return Math.hypot(a.x - b.x, a.y - b.y) || 1;
}

// ---------- selection and text ----------

// Highlight one album and its lines, or a whole kernel, and describe it under the graph.
function select(key) {
  selected = key;
  const kernel = key?.startsWith("kernel:") ? graph.kernels[+key.split(":")[1]] : null;
  const keep = new Set(kernel ? kernel.map((n) => n.key) : key ? [key] : []);
  if (key && !kernel) for (const e of graph.edges) if (e.from === key || e.to === key) keep.add(e.from).add(e.to);
  svg.classList.toggle("focus", Boolean(key));
  for (const e of graph.edges) {
    e.el.classList.toggle("hl", kernel ? keep.has(e.from) && keep.has(e.to) : e.from === key || e.to === key);
  }
  for (const n of graph.nodes) {
    n.el.classList.toggle("hl", keep.has(n.key));
    n.el.classList.toggle("sel", n.key === key);
  }
  for (const b of kernelList.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.key === key));
  describe(kernel ? null : graph.byKey.get(key));
}

function describe(chosen) {
  // nothing chosen: what is playing now, or the last album played
  const n = chosen || graph.nodes.reduce((a, b) => (b.time > a.time ? b : a));
  const t = n.latest;
  const names = (list) => list.sort((a, b) => b.count - a.count).slice(0, 3)
    .map((e) => short(name(graph.byKey.get(e.from === n.key ? e.to : e.from)), 30)).join(", ");
  const before = names(graph.edges.filter((e) => e.to === n.key));
  const after = names(graph.edges.filter((e) => e.from === n.key));

  const pic = t.cover ? Object.assign(document.createElement("img"), { src: t.cover, alt: "" }) : text("div", "", "swatch");
  if (!t.cover) pic.style.background = n.colour;
  // textContent, never innerHTML: track names come from outside and could contain HTML
  const lines = [
    text("p", `${name(n)} — ${t.artist}`),
    text("p", `${n.plays} play${n.plays > 1 ? "s" : ""} · ${n.now ? "playing now" : `last: ${t.title}, ${ago(n.time)}`}`, "muted"),
    text("p", n.kernel >= 0 ? `Kernel of ${graph.kernels[n.kernel].length} albums` : "In no kernel yet", "muted"),
  ];
  if (before) lines.push(text("p", `Came from: ${before}`, "muted"));
  if (after) lines.push(text("p", `Went to: ${after}`, "muted"));
  if (t.deezer) lines.push(Object.assign(text("a", "Open in Deezer"), { href: t.deezer, target: "_blank", rel: "noopener" }));
  const box = document.createElement("div");
  box.append(...lines);
  info.replaceChildren(pic, box);
}

function renderKernels() {
  kernelList.replaceChildren(...graph.kernels.map((members, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.key = `kernel:${i}`;
    b.style.setProperty("--c", members[0].colour);
    const top = [...members].sort((a, c) => c.plays - a.plays).slice(0, 3).map((n) => short(name(n), 22)).join(", ");
    const more = members.length > 3 ? ` +${members.length - 3}` : "";
    b.append(text("span", "", "dot"), text("span", `${top}${more} · ${total(members)} plays`));
    b.addEventListener("click", () => select(selected === b.dataset.key ? null : b.dataset.key));
    return b;
  }));
}

function markers() {
  const defs = el("defs", {});
  for (const [id, fill] of [["head", "#8a8a93"], ["head-green", "#1db954"]]) {
    const m = el("marker", { id, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, markerUnits: "userSpaceOnUse", orient: "auto" });
    m.append(el("path", { d: "M0,1 L9,5 L0,9 z", fill }));
    defs.append(m);
  }
  return defs;
}

// ---------- small helpers ----------

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

const name = (n) => n.latest.album || n.latest.title;
const total = (list) => list.reduce((s, n) => s + n.plays, 0);
const mean = (list, prop) => list.reduce((s, n) => s + n[prop], 0) / list.length;
const short = (s, max) => (s.length > max ? s.slice(0, max - 1) + "…" : s);
const initials = (n) => name(n).split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
const clock = (s) => new Date(s * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function ago(s) {
  const min = Math.max(0, Math.round((Date.now() / 1000 - s) / 60));
  if (min < 60) return `${min} min ago`;
  if (min < 1440) return `${Math.round(min / 60)} h ago`;
  return `${Math.round(min / 1440)} d ago`;
}

// Redraw when the width changes. Not on height: a phone changes height when its address bar hides.
let resizeTimer;
addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => graph && svg.clientWidth !== W && build(), 200);
});
load();
setInterval(load, 60_000); // the server cache keeps this at one Last.fm call per minute at most
