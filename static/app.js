const svg = document.getElementById("graph");
const card = document.getElementById("card");
const stats = document.getElementById("stats");
const status = document.getElementById("status");
const SVG = "http://www.w3.org/2000/svg";
const COLOURS = ["#a78bfa", "#f472b6", "#34d399", "#fbbf24", "#60a5fa", "#f87171", "#2dd4bf", "#fb923c"];
const LONE = "#8a8a93"; // albums in no kernel
const FOCAL = 10; // the most played albums: full colour
const REPEL = 120; // how hard circles push each other away
const MOAT = 60; // empty space kept around each kernel, so kernels stand as separate islands
const PULL = 150; // strength of the pull to the middle
const FILL = 0.15; // share of the frame the circles should cover

const pos = new Map(); // album -> {x, y}, kept between refreshes so nothing jumps
let data = null; // last answer from the server
let graph = null; // { nodes, edges, byKey, kernels, steps }
let selected = null; // the album shown in the card
let pinned = false; // tapped or clicked: the card stays until the background is tapped
let view = { x: 0, y: 0, k: 1 }; // pan and zoom
let autoFit = true; // keep the whole graph in view until the visitor pans or zooms
let alpha = 0, alphaTarget = 0, running = false; // the simulation's "heat": forces fade as it cools
let W = 800, H = 500, layer = null;
let soon = null; // timer to ask the server again while data or covers are on their way
let quick = 0; // quick re-asks in a row: capped, so a Deezer that keeps refusing can't keep the page busy
let seen = ""; // what the last answer looked like: an identical answer doesn't redraw anything
let year = null; // the timeline: null = now (last 30 days, live), or a year of the Deezer history
const slider = document.getElementById("year");

// ---------- data ----------

async function load() {
  // relative URL: the same page works at / locally and under /music/ on the server
  const asked = year;
  const r = await fetch(asked ? `api/recent?year=${asked}` : "api/recent").catch(() => null);
  const answer = (r && (await r.json().catch(() => null))) || { message: "The server is not answering. Try again in a minute." };
  if (asked !== year) return; // the slider moved on while this was loading
  if (answer.years?.length && slider.parentElement.hidden) timeline(answer.years);

  status.classList.toggle("warn", Boolean(answer.message));
  status.textContent = answer.message
    ? answer.message + (answer.fetched_at ? ` Showing music from ${clock(answer.fetched_at)}.` : "")
    : answer.year ? `${answer.user} · ${answer.year}, my most played albums`
    : `${answer.user} · updated ${clock(answer.fetched_at)}` +
      (answer.history_days ? ` · last ${answer.history_days} days, my most played albums` : "");

  const look = answer.tracks ? `${answer.year ?? answer.fetched_at}|${answer.tracks.length}|${answer.tracks.filter((t) => t.cover).length}|${answer.pending}` : "";
  if (answer.tracks?.length && look !== seen) {
    seen = look;
    data = answer;
    update();
  } else if (!data) {
    svg.replaceChildren();
    stats.replaceChildren(text("p", answer.message ? "Nothing to show yet." : "No music yet. Play something!", "empty"));
  }
  // The server answered with what it had: fresher data or more covers are coming, so ask again shortly
  clearTimeout(soon);
  if ((answer.refreshing || answer.pending) && quick < 8) {
    quick += 1;
    soon = setTimeout(load, 4000);
  } else quick = 0;
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
      const e = edges.get(id) || { id, from: prev.key, to: key, count: 0, together: 0, weight: 0 };
      e.count += 1;
      e.together += pause ? 0 : 1; // only these are drawn: a jump after a pause isn't "what I played next"
      e.weight += pause ? 0.2 : 1; // inside a session it says "these go together"; after a pause, much less
      e.step = step; // when it last happened, for fading
      edges.set(id, e);
    }
    prev = { key, session: t.session };
  });
  const list = [...nodes.values()];
  // size weighted against my most played album: played once = small dot, most played = biggest circle
  const most = Math.max(...list.map((n) => n.plays));
  // linear, not by area: most albums have a few plays, and a linear scale keeps the big ones clearly apart
  list.forEach((n) => (n.r = 10 + 30 * ((n.plays - 1) / Math.max(1, most - 1)))); // 10 to 40
  const links = [...edges.values()];
  // the most played albums are the focal points
  [...list].sort((a, b) => b.plays - a.plays || b.time - a.time).forEach((n, i) => (n.focal = i < FOCAL));
  // the flow: the last 12 albums I played, in order
  const flow = [];
  for (const t of plays) if (flow.at(-1) !== t.key) flow.push(t.key);
  return { nodes: list, edges: links, byKey: nodes, kernels: findKernels(list, links), steps: plays.length, flow: flow.slice(-12) };
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
      const f = (REPEL * alpha) / d2;
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
      n.vx += (cx - n.x) * 0.07 * alpha;
      n.vy += (cy - n.y) * 0.07 * alpha;
    }
  }
  // Pull to the middle, measured against a box shaped like the frame: the layout settles into
  // the frame's shape (wide on a laptop, tall on a phone) and fills it, so the circles show bigger.
  const [boxW, boxH] = box();
  for (const n of nodes) {
    n.vx -= (n.x / boxW) * PULL * alpha;
    n.vy -= (n.y / boxH) * PULL * alpha;
    if (n.fixed) { n.vx = n.vy = 0; continue; } // the circle being dragged follows the pointer
    n.vx *= 0.6; n.vy *= 0.6; // friction
    n.x += n.vx; n.y += n.vy;
  }
  // circles never overlap (and keep a MOAT from other kernels), once the layout has calmed down: while it is still moving fast they can pass
  // through each other, so an album that starts on the wrong side doesn't get trapped inside another kernel
  for (let i = 0; alpha < 0.3 && i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1, gap = a.r + b.r + (a.kernel === b.kernel ? 12 : MOAT);
      if (d >= gap) continue;
      const push = (gap - d) / 2 / d;
      if (!a.fixed) { a.x -= dx * push; a.y -= dy * push; }
      if (!b.fixed) { b.x += dx * push; b.y += dy * push; }
    }
  }
  alpha += (alphaTarget - alpha) * 0.03; // cool down
}

// The box the layout fills: shaped like the frame, sized so the circles cover a share FILL of it.
function box() {
  const area = graph.nodes.reduce((s, n) => s + Math.PI * (n.r + 6) ** 2, 0) / FILL;
  const h = Math.sqrt((area * H) / W);
  return [(h * W) / H, h];
}

function reheat(a) {
  alpha = Math.max(alpha, a);
  if (!running) { running = true; requestAnimationFrame(step); }
}

function step() {
  tick();
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
  const jump = first || fresh > graph.nodes.length / 2; // first layout, or another year: mostly new albums
  size();
  place(); // albums already on screen start where they were, so a year change shows what stayed
  if (jump) {
    // Work out most of the layout before drawing it: the graph appears nearly in place, then settles
    alpha = 1;
    while (alpha > 0.1) tick();
  }
  build();
  if (fresh) reheat(jump ? 0.1 : 0.3); // a new album: let the layout adjust; otherwise nothing moves
}

// The timeline under the graph: one step per year of history, then "Now"
function timeline(years) {
  const labels = [...years, "Now"].map((y) => text("span", y));
  slider.max = years.length;
  slider.value = years.length;
  slider.parentElement.querySelector(".ticks").replaceChildren(...labels);
  slider.parentElement.hidden = false;
  const show = () => labels.forEach((l, i) => l.classList.toggle("on", i === Number(slider.value)));
  show();
  slider.addEventListener("input", () => {
    year = years[slider.value] ?? null;
    show();
    seen = "";
    quick = 0;
    load();
  });
}

// Start positions: where the album was last time; a new album next to the one played before it;
// on a first layout, each kernel starts in its own part of the frame, so no album has to cross another kernel.
function place() {
  const [boxW, boxH] = box();
  const count = graph.kernels.length;
  graph.nodes.forEach((n, i) => {
    const p = pos.get(n.key);
    const from = !p && graph.edges.find((e) => e.to === n.key && pos.has(e.from) && graph.byKey.get(e.from).kernel === n.kernel);
    const turn = (2 * Math.PI * n.kernel) / Math.max(1, count);
    const anchor = n.kernel >= 0 && count > 1 ? { x: Math.cos(turn) * boxW * 0.3, y: Math.sin(turn) * boxH * 0.3 } : { x: 0, y: 0 };
    const base = p || (from && pos.get(from.from)) || anchor;
    const a = i * 2.4, d = p ? 0 : from ? 30 : 8 * Math.sqrt(i % 40);
    Object.assign(n, { x: base.x + Math.cos(a) * d, y: base.y + Math.sin(a) * d, vx: 0, vy: 0 });
  });
}

function size() {
  W = svg.clientWidth || 800;
  H = Math.round(W < 600 ? W * 1.15 : Math.max(420, Math.min(W * 0.6, innerHeight - 280)));
}

function build() {
  size();
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  layer = el("g", {});
  const defs = el("defs", {});
  svg.replaceChildren(defs, layer);
  // the arrowhead of a hovered album's lines (style.css), painted in its line's colour
  const arrow = el("marker", { id: "arrow", viewBox: "0 0 10 10", refX: 10, refY: 5, markerWidth: 4, markerHeight: 4, markerUnits: "userSpaceOnUse", orient: "auto" });
  arrow.append(el("path", { d: "M0,1.5 L10,5 L0,8.5 z", fill: "context-stroke" }));
  defs.append(arrow);

  // Kernel colour fields: a faint tint of the kernel's colour behind each of its albums
  const fields = el("g", { class: "field" });
  graph.kernels.forEach((members, i) => {
    const glow = el("radialGradient", { id: `field${i}` });
    glow.append(el("stop", { offset: 0, "stop-color": members[0].colour, "stop-opacity": 0.07 }),
      el("stop", { offset: 1, "stop-color": members[0].colour, "stop-opacity": 0 }));
    defs.append(glow);
    for (const n of members) {
      n.fieldEl = el("circle", { r: n.r * 1.8 + 26, fill: `url(#field${i})` });
      fields.append(n.fieldEl);
    }
  });
  layer.append(fields);

  // Bands between kernels: one per pair of kernels I often go between, from centre to centre,
  // wider the more often, in neutral grey: colour means kernel, and a band belongs to two
  const between = new Map();
  for (const e of graph.edges) {
    const a = graph.byKey.get(e.from).kernel, b = graph.byKey.get(e.to).kernel;
    if (!e.together || a < 0 || b < 0 || a === b) continue;
    const id = `${Math.min(a, b)}-${Math.max(a, b)}`;
    between.set(id, { a: Math.min(a, b), b: Math.max(a, b), count: (between.get(id)?.count || 0) + e.together });
  }
  graph.bands = [...between.values()].filter((p) => p.count >= 3); // ponytail: fixed threshold, make it relative if real data shows too many or none
  graph.bands.forEach((p, i) => {
    p.el = el("line", { class: "band", stroke: LONE, "stroke-width": 2 + 2 * Math.log2(p.count), "vector-effect": "non-scaling-stroke" });
    layer.append(p.el);
  });

  // Lines take their kernel's colour; a line between two kernels is neutral grey.
  // Only transitions inside a session are drawn, and those that happened once only show on hover.
  const flowing = new Set(graph.flow.slice(1).map((k, i) => `${graph.flow[i]}→${k}`)); // the flow's lines
  graph.edges.sort((a, b) => a.step - b.step).forEach((e) => { // recent lines drawn last, on top
    if (!e.together) return; // only ever after a pause: still weighs on the kernels, not drawn
    const a = graph.byKey.get(e.from), b = graph.byKey.get(e.to);
    const inner = a.colour === b.colour;
    e.el = el("line", {
      class: `edge${e.together === 1 ? " once" : ""}${flowing.has(e.id) ? " flow" : ""}`,
      stroke: inner ? a.colour : LONE,
      "stroke-width": 0.75 * (1 + Math.log2(e.together)),
      "vector-effect": "non-scaling-stroke", // same thickness at every zoom
      // recent = brighter, old = fainter; lines between two kernels fainter, so the kernels stand out
      opacity: ((0.18 + 0.5 * (e.step / graph.steps)) * (inner ? 1 : 0.6)).toFixed(2),
    });
    layer.append(e.el);
  });


  graph.nodes.forEach((n, i) => {
    const g = el("g", {
      class: `node${n.now ? " now" : ""}${n.focal ? " focal" : ""}`,
      style: `--c:${n.colour}`,
      tabindex: 0, role: "button", "aria-label": `${name(n)} by ${n.latest.artist}, ${n.plays} plays`, "data-key": n.key,
    });
    const lens = el("g", { class: "lens" }); // grows on hover
    const fallback = () => {
      lens.prepend(el("circle", { r: n.r, fill: n.colour, opacity: 0.5 }));
      if (n.r >= 10) lens.append(Object.assign(el("text", { class: "initials" }), { textContent: initials(n) })); // no room in a small dot
    };
    if (n.latest.cover) {
      const clip = el("clipPath", { id: `clip${i}` });
      clip.append(el("circle", { r: n.r }));
      const img = el("image", { href: n.latest.cover, x: -n.r, y: -n.r, width: 2 * n.r, height: 2 * n.r, "clip-path": `url(#clip${i})`, preserveAspectRatio: "xMidYMid slice" });
      img.addEventListener("error", () => { img.remove(); fallback(); });
      lens.append(clip, img);
    } else fallback();
    lens.append(el("circle", { r: n.r, class: "ring", "vector-effect": "non-scaling-stroke" })); // 1 px at every zoom
    g.append(lens);
    g.addEventListener("pointerenter", (ev) => ev.pointerType === "mouse" && !drag && !pinned && select(n.key));
    g.addEventListener("pointerleave", (ev) => ev.pointerType === "mouse" && !drag && !pinned && select(null));
    g.addEventListener("focus", () => select(n.key));
    n.el = g;
    layer.append(g);
  });

  render();
  if (autoFit) fit(); else applyView();
  renderStats();
  select(selected && graph.byKey.has(selected) ? selected : null);
}

// Where a circle is drawn: its place in the layout, plus the offsets of the motion (see animate)
const px = (n) => n.x + (n.ox || 0), py = (n) => n.y + (n.oy || 0), pr = (n) => n.r * (n.k || 1);

function render(only) { // only: a Set of circles to redraw, with their lines; default everything
  for (const n of graph.nodes) {
    if (only && !only.has(n)) continue;
    const at = `translate(${px(n).toFixed(1)},${py(n).toFixed(1)})`;
    n.el.setAttribute("transform", n.k ? `${at} scale(${n.k.toFixed(3)})` : at);
    n.fieldEl?.setAttribute("transform", at);
  }
  const centre = (k) => [mean(graph.kernels[k], "x"), mean(graph.kernels[k], "y")];
  for (const p of only ? [] : graph.bands) { // bands follow the layout, not the push
    const [x1, y1] = centre(p.a), [x2, y2] = centre(p.b);
    p.el.setAttribute("x1", x1.toFixed(1)); p.el.setAttribute("y1", y1.toFixed(1));
    p.el.setAttribute("x2", x2.toFixed(1)); p.el.setAttribute("y2", y2.toFixed(1));
  }
  for (const e of graph.edges) {
    if (!e.el) continue;
    const a = graph.byKey.get(e.from), b = graph.byKey.get(e.to);
    if (only && !only.has(a) && !only.has(b)) continue;
    const dx = px(b) - px(a), dy = py(b) - py(a), d = Math.hypot(dx, dy) || 1;
    // from edge to edge of the two circles
    const x1 = (px(a) + (dx / d) * pr(a)).toFixed(1), y1 = (py(a) + (dy / d) * pr(a)).toFixed(1);
    const x2 = (px(b) - (dx / d) * pr(b)).toFixed(1), y2 = (py(b) - (dy / d) * pr(b)).toFixed(1);
    e.el.setAttribute("x1", x1); e.el.setAttribute("y1", y1);
    e.el.setAttribute("x2", x2); e.el.setAttribute("y2", y2);
  }
}

// The numbers in the header
function renderStats() {
  const stat = (label, value) => {
    const box = document.createElement("div");
    box.append(text("dt", label), text("dd", value));
    return box;
  };
  stats.replaceChildren(stat("Plays", graph.steps), stat("Albums", graph.nodes.length), stat("Kernels", graph.kernels.length));
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
  if (drag.moved < 5) { // a tap, not a drag: the card stays for a tapped circle, goes for the background
    pinned = Boolean(drag.node);
    select(drag.node ? drag.node.key : null);
  }
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

// Highlight one album and its lines, and show it in the card over the graph.
function select(key) {
  selected = key;
  const keep = new Set(key ? [key] : []);
  const drawn = graph.edges.filter((e) => e.el);
  if (key) for (const e of drawn) if (e.from === key || e.to === key) keep.add(e.from).add(e.to);
  svg.classList.toggle("focus", Boolean(key));
  for (const e of drawn) e.el.classList.toggle("hl", e.from === key || e.to === key);
  for (const n of graph.nodes) {
    n.el.classList.toggle("hl", keep.has(n.key));
    n.el.classList.toggle("sel", n.key === key);
  }
  describe(graph.byKey.get(key));
}

// The card in the footer: the album hovered or tapped, otherwise what is playing now (or was played last).
function describe(chosen) {
  const n = chosen || graph.nodes.reduce((a, b) => (b.time > a.time ? b : a));
  const t = n.latest;
  const live = !chosen; // showing the latest listening, not an album the visitor picked
  card.classList.toggle("live", live && n.now);
  const names = (list) => list.sort((a, b) => b.count - a.count).slice(0, 3)
    .map((e) => short(name(graph.byKey.get(e.from === n.key ? e.to : e.from)), 28)).join(", ");
  const before = names(graph.edges.filter((e) => e.to === n.key));
  const after = names(graph.edges.filter((e) => e.from === n.key));
  card.style.setProperty("--c", n.colour);
  const pic = t.cover ? Object.assign(document.createElement("img"), { src: t.cover, alt: "" }) : text("div", "", "swatch");
  if (!t.cover) pic.style.background = n.colour;
  // textContent, never innerHTML: track names come from outside and could contain HTML
  const lines = live
    ? [text("p", n.now ? "Playing now" : `Played ${ago(n.time)}`, "label"), text("p", t.title, "big"), text("p", `${t.artist} · ${name(n)}`)]
    : [text("p", name(n), "big"), text("p", t.artist),
      text("p", `${n.plays} play${n.plays > 1 ? "s" : ""} · ${n.now ? "playing now" : ago(n.time)}`, "muted")];
  if (!live && before) lines.push(text("p", `After ${before}`, "muted"));
  if (!live && after) lines.push(text("p", `Then ${after}`, "muted"));
  if (t.deezer) lines.push(Object.assign(text("a", "Open in Deezer"), { href: t.deezer, target: "_blank", rel: "noopener" }));
  const box = document.createElement("div");
  box.append(...lines);
  card.replaceChildren(pic, box);
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
  if (min < 86400) return `${Math.round(min / 1440)} d ago`; // up to 60 days
  if (min < 525600) return `${Math.round(min / 43200)} months ago`;
  return `${Math.round(min / 525600)} y ago`;
}

// Redraw when the width changes. Not on height: a phone changes height when its address bar hides.
let resizeTimer;
addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => graph && svg.clientWidth !== W && build(), 200);
});

// ---------- motion ----------
// Both motions are only drawn: the layout itself never moves, so nothing drifts over time.
// 1. The album playing now beats like a heart (lub, dub, rest) and pushes the circles around it aside.
// 2. My latest listening flows: each of the last 12 albums leans toward the one I played next, then lets go,
//    in a wave running from the oldest to the newest.
// Reduced motion: the beat stays half-grown and the flow stays still.
const HEARTBEAT = 3000; // ms per beat: 20 a minute, slow and calm
const FLOW = 4000; // ms per wave of the flow
const swell = (x, at) => Math.exp(-(((x - at) / 0.06) ** 2)); // one quick bump centred on "at" (fraction of a beat)
const still = matchMedia("(prefers-reduced-motion: reduce)");
let moved = new Set();
function animate(t) {
  if (graph) {
    const before = moved;
    moved = new Set();
    for (const n of graph.nodes) n.ox = n.oy = 0;
    const now = graph.nodes.find((n) => n.now);
    if (now) {
      const peak = 9 + 0.3 * now.r;
      const x = (t % HEARTBEAT) / HEARTBEAT;
      const grow = still.matches ? peak / 2 : peak * (swell(x, 0.15) + 0.6 * swell(x, 0.35));
      now.k = (now.r + grow) / now.r;
      moved.add(now);
      for (const n of graph.nodes) {
        const dx = n.x - now.x, dy = n.y - now.y, d = Math.hypot(dx, dy) || 1;
        const push = grow * Math.exp(-Math.max(0, d - now.r - n.r) / 40); // nearest pushed most, fading with distance
        if (n === now || push < 0.2) continue; // ponytail: under 0.2 is invisible
        n.ox += (dx / d) * push; n.oy += (dy / d) * push;
        moved.add(n);
      }
    }
    if (!still.matches) graph.flow.forEach((key, i) => {
      if (!i) return;
      const a = graph.byKey.get(graph.flow[i - 1]), b = graph.byKey.get(key);
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
      // each leans up to 30% of the gap (16 at most), so the two never touch
      const lean = Math.min(16, Math.max(0, d - a.r - b.r) * 0.3) * (1 - Math.cos(2 * Math.PI * (t / FLOW - i * 0.12))) / 2;
      a.ox += (dx / d) * lean; a.oy += (dy / d) * lean;
      b.ox -= (dx / d) * lean; b.oy -= (dy / d) * lean;
      moved.add(a).add(b);
    });
    if (!running) render(new Set([...before, ...moved])); // also redraws what stopped moving; a running layout draws everything itself
  }
  requestAnimationFrame(animate);
}
requestAnimationFrame(animate);

load();
setInterval(load, 60_000); // the server cache keeps this at one Last.fm call per minute at most
