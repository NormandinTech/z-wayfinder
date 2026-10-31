// Road tracer: turns a map image into a road graph.
// Works on raw RGBA pixels, so it runs in a Web Worker (browser) or in Node (tests).
// traceRoads({data,width,height}, opts) -> {size, nodes:[[x,z]], edges:[{a,b,pts,len}], stats}
(function (root) {
  'use strict';

  // ---- colour mask ----
  // samples: [[r,g,b],...] colours the owner clicked on roads; tol: max RGB distance (0-255 scale)
  function colourMask(img, samples, tol) {
    const { data, width: W, height: H } = img;
    const m = new Uint8Array(W * H), t2 = tol * tol;
    for (let i = 0, p = 0; i < W * H; i++, p += 4) {
      const r = data[p], g = data[p + 1], b = data[p + 2];
      for (const s of samples) {
        const dr = r - s[0], dg = g - s[1], db = b - s[2];
        // weight green less: map greens vary a lot, road reds/whites/yellows differ mainly in R/B
        if (dr * dr * 1.2 + dg * dg * 0.8 + db * db < t2) { m[i] = 1; break; }
      }
    }
    return m;
  }

  // ---- morphology (3x3) ----
  function dilate(m, W, H) {
    const o = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (!m[y * W + x]) continue;
      for (let dy = -1; dy <= 1; dy++) { const yy = y + dy; if (yy < 0 || yy >= H) continue;
        for (let dx = -1; dx <= 1; dx++) { const xx = x + dx; if (xx >= 0 && xx < W) o[yy * W + xx] = 1; } }
    }
    return o;
  }
  function erode(m, W, H) {
    const o = new Uint8Array(W * H);
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      let all = 1;
      for (let dy = -1; dy <= 1 && all; dy++) for (let dx = -1; dx <= 1; dx++) if (!m[(y + dy) * W + x + dx]) { all = 0; break; }
      o[y * W + x] = all;
    }
    return o;
  }

  // ---- connected components; keep elongated ones (roads), drop blobs and text ----
  function filterComponents(m, W, H, minLen) {
    const lab = new Int32Array(W * H).fill(-1), keep = new Uint8Array(W * H);
    const stack = [];
    let id = 0, kept = 0, dropped = 0;
    for (let s = 0; s < W * H; s++) {
      if (!m[s] || lab[s] !== -1) continue;
      const pix = []; stack.push(s); lab[s] = id;
      let x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1;
      while (stack.length) {
        const p = stack.pop(); pix.push(p);
        const x = p % W, y = (p / W) | 0;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          const q = yy * W + xx; if (m[q] && lab[q] === -1) { lab[q] = id; stack.push(q); }
        }
      }
      const span = Math.hypot(x1 - x0, y1 - y0);
      // a road piece is long compared with its area (thin); text/blobs are compact
      const thinness = span * span / pix.length;
      if (span >= minLen && thinness > 1.5) { for (const p of pix) keep[p] = 1; kept++; } else dropped++;
      id++;
    }
    return { keep, kept, dropped };
  }

  // ---- Zhang-Suen thinning ----
  function thin(m, W, H) {
    const a = Uint8Array.from(m);
    let changed = true; const del = [];
    const P = (x, y) => (x < 0 || y < 0 || x >= W || y >= H) ? 0 : a[y * W + x];
    while (changed) {
      changed = false;
      for (let step = 0; step < 2; step++) {
        del.length = 0;
        for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
          if (!a[y * W + x]) continue;
          const p2 = P(x, y - 1), p3 = P(x + 1, y - 1), p4 = P(x + 1, y), p5 = P(x + 1, y + 1),
                p6 = P(x, y + 1), p7 = P(x - 1, y + 1), p8 = P(x - 1, y), p9 = P(x - 1, y - 1);
          const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (B < 2 || B > 6) continue;
          const seq = [p2, p3, p4, p5, p6, p7, p8, p9, p2];
          let A = 0; for (let k = 0; k < 8; k++) if (!seq[k] && seq[k + 1]) A++;
          if (A !== 1) continue;
          if (step === 0 ? (p2 * p4 * p6 || p4 * p6 * p8) : (p2 * p4 * p8 || p2 * p6 * p8)) continue;
          del.push(y * W + x);
        }
        if (del.length) { changed = true; for (const i of del) a[i] = 0; }
      }
    }
    return a;
  }

  // ---- skeleton -> graph ----
  const NB = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]];
  function skeletonGraph(s, W, H) {
    const nbrs = p => { const x = p % W, y = (p / W) | 0, out = [];
      for (const [dx, dy] of NB) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < W && yy < H && s[yy * W + xx]) out.push(yy * W + xx); }
      return out; };
    const deg = new Uint8Array(W * H);
    for (let p = 0; p < W * H; p++) if (s[p]) deg[p] = nbrs(p).length;
    // nodes: endpoints (1) and junction pixels (>=3); merge adjacent junction pixels into one node
    const nodeOf = new Int32Array(W * H).fill(-1), nodes = [];
    for (let p = 0; p < W * H; p++) {
      if (!s[p] || deg[p] === 2 || nodeOf[p] !== -1) continue;
      const id = nodes.length, cl = [p], st = [p]; nodeOf[p] = id;
      if (deg[p] >= 3) while (st.length) { const q = st.pop(); for (const r of nbrs(q)) if (deg[r] >= 3 && nodeOf[r] === -1) { nodeOf[r] = id; cl.push(r); st.push(r); } }
      let sx = 0, sy = 0; for (const q of cl) { sx += q % W; sy += (q / W) | 0; }
      nodes.push([sx / cl.length, sy / cl.length]);
    }
    const edges = [], used = new Set();
    const key = (a, b) => a < b ? a + ',' + b : b + ',' + a;
    for (let p = 0; p < W * H; p++) {
      if (nodeOf[p] === -1) continue;
      for (const q0 of nbrs(p)) {
        if (nodeOf[q0] === nodeOf[p]) continue;
        if (used.has(key(p, q0))) continue;
        const pts = [p]; let prev = p, cur = q0; used.add(key(p, q0));
        while (nodeOf[cur] === -1) {
          pts.push(cur);
          const nx = nbrs(cur).filter(r => r !== prev && !used.has(key(cur, r)));
          if (!nx.length) break;
          // prefer 4-neighbours to avoid diagonal shortcuts
          nx.sort((a, b) => (Math.abs(a - cur) === 1 || Math.abs(a - cur) === W ? 0 : 1) - (Math.abs(b - cur) === 1 || Math.abs(b - cur) === W ? 0 : 1));
          used.add(key(cur, nx[0])); prev = cur; cur = nx[0];
        }
        pts.push(cur);
        const a = nodeOf[p], b = nodeOf[cur];
        if (b === -1) continue; // dangling loop
        edges.push({ a, b, px: pts.map(i => [i % W, (i / W) | 0]) });
      }
    }
    // closed loops with no node (e.g. a ring road): add a node and an edge
    return { nodes, edges };
  }

  // ---- geometry helpers ----
  function rdp(pts, eps) {
    if (pts.length < 3) return pts;
    let dmax = 0, idx = 0; const [ax, ay] = pts[0], [bx, by] = pts[pts.length - 1];
    const L = Math.hypot(bx - ax, by - ay) || 1;
    for (let i = 1; i < pts.length - 1; i++) {
      const d = Math.abs((by - ay) * pts[i][0] - (bx - ax) * pts[i][1] + bx * ay - by * ax) / L;
      if (d > dmax) { dmax = d; idx = i; }
    }
    if (dmax <= eps) return [pts[0], pts[pts.length - 1]];
    return rdp(pts.slice(0, idx + 1), eps).slice(0, -1).concat(rdp(pts.slice(idx), eps));
  }
  const plen = pts => pts.reduce((s, p, i) => i ? s + Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) : 0, 0);

  // drop small or tangled isolated pieces (leftover contour, text or symbol fragments)
  function dropClutter(nodes, edges, minPiece) {
    const par = nodes.map((_, i) => i); const f = i => par[i] === i ? i : (par[i] = f(par[i]));
    for (const e of edges) par[f(e.a)] = f(e.b);
      const tot = {}, bb = {}, gaps = {};
    for (const e of edges) { const r = f(e.a); tot[r] = (tot[r] || 0) + e.len; if (e.gap) gaps[r] = (gaps[r] || 0) + e.len;
      const b = bb[r] || (bb[r] = [1e9, 1e9, -1e9, -1e9]);
      for (const p of e.px) { if (p[0] < b[0]) b[0] = p[0]; if (p[1] < b[1]) b[1] = p[1]; if (p[0] > b[2]) b[2] = p[0]; if (p[1] > b[3]) b[3] = p[1]; } }
    const ok = r => { const b = bb[r], span = Math.hypot(b[2] - b[0], b[3] - b[1]);
      if (tot[r] >= minPiece * 6) return true;          // big networks always stay
      if (tot[r] < minPiece) return false;              // tiny bits go
      if ((gaps[r] || 0) > tot[r] * 0.35) return false; // mostly invented joins: scattered symbols
      return tot[r] / (span || 1) < 2.2;                // roads run somewhere; symbol clusters tangle in place
    };
    return edges.filter(e => ok(f(e.a)));
  }

  // ---- clean up the graph: drop spurs, join gaps, compact ----
  function cleanGraph(g, spurLen, gapLen, minPiece) {
    let { nodes, edges } = g;
    edges.forEach(e => { e.len = plen(e.px); });
    edges = edges.filter(e => !(e.a === e.b && e.len < spurLen * 2));
    // remove short dead-end spurs (thinning artefacts) a few times
    for (let it = 0; it < 3; it++) {
      const deg = new Array(nodes.length).fill(0);
      for (const e of edges) { deg[e.a]++; deg[e.b]++; }
      edges = edges.filter(e => !(e.len < spurLen && (deg[e.a] === 1) !== (deg[e.b] === 1)));
    }
    edges = dropClutter(nodes, edges, minPiece);
    // join mutual-nearest dead ends across small gaps (breaks under labels, bridges, junction blobs)
    const deg = new Array(nodes.length).fill(0);
    for (const e of edges) { deg[e.a]++; deg[e.b]++; }
    const ends = []; deg.forEach((d, i) => { if (d === 1) ends.push(i); });
    // direction a dead end points in (away from its road)
    const dirOf = {};
    for (const e of edges) for (const [n, pts] of [[e.a, e.px], [e.b, [...e.px].reverse()]]) {
      if (deg[n] !== 1) continue; const k = Math.min(pts.length - 1, 6);
      const dx = pts[0][0] - pts[k][0], dy = pts[0][1] - pts[k][1], L = Math.hypot(dx, dy) || 1; dirOf[n] = [dx / L, dy / L];
    }
    const near = i => { let best = -1, bd = gapLen;
      for (const j of ends) { if (j === i) continue; const d = Math.hypot(nodes[i][0] - nodes[j][0], nodes[i][1] - nodes[j][1]);
        if (d < bd) { const di = dirOf[i]; const v = [(nodes[j][0] - nodes[i][0]) / (d || 1), (nodes[j][1] - nodes[i][1]) / (d || 1)];
          if (!di || di[0] * v[0] + di[1] * v[1] > 0.3) { bd = d; best = j; } } }
      return best; };
    let joined = 0; const done = new Set();
    for (const i of ends) { if (done.has(i)) continue; const j = near(i); if (j < 0 || done.has(j) || near(j) !== i) continue;
      edges.push({ a: i, b: j, px: [nodes[i], nodes[j]], len: Math.hypot(nodes[i][0] - nodes[j][0], nodes[i][1] - nodes[j][1]), gap: true });
      done.add(i); done.add(j); joined++; }
    // dead end that stops short of the side of another road (T-junction under a town blob): split that road and connect
    {
      const deg2 = new Array(nodes.length).fill(0);
      for (const e of edges) { deg2[e.a]++; deg2[e.b]++; }
      const comp = (() => { const par = nodes.map((_, i) => i); const f = i => par[i] === i ? i : (par[i] = f(par[i]));
        for (const e of edges) par[f(e.a)] = f(e.b); return f; })();
      const add = [];
      for (let i = 0; i < nodes.length; i++) {
        if (deg2[i] !== 1 || !dirOf[i]) continue;
        const [nx, ny] = nodes[i], di = dirOf[i]; let best = null;
        for (let ei = 0; ei < edges.length; ei++) {
          const e = edges[ei]; if (e.a === i || e.b === i) continue;
          const pts = e.px;
          for (let k = 0; k < pts.length - 1; k++) {
            const [ax, ay] = pts[k], [bx, by] = pts[k + 1], dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
            let t = L2 ? ((nx - ax) * dx + (ny - ay) * dy) / L2 : 0; t = Math.max(0, Math.min(1, t));
            const px = ax + t * dx, py = ay + t * dy, d = Math.hypot(px - nx, py - ny);
            if (d < 1 || d > gapLen) continue;
            const v = [(px - nx) / d, (py - ny) / d];
            // must point roughly toward the road, unless very close
            if (d > 6 && di[0] * v[0] + di[1] * v[1] < 0.5) continue;
            // prefer joining a different piece of network (that's what fixes breaks)
            const score = d * (comp(e.a) === comp(i) ? 2.5 : 1);
            if (!best || score < best.score) best = { score, d, ei, k, p: [px, py] };
          }
        }
        if (best) add.push({ i, ...best });
      }
      // apply splits (one per edge per pass keeps it simple)
      const split = new Set();
      for (const s of add) {
        if (split.has(s.ei)) continue; split.add(s.ei);
        const e = edges[s.ei], nid = nodes.length; nodes.push(s.p);
        const p1 = e.px.slice(0, s.k + 1).concat([s.p]), p2 = [s.p].concat(e.px.slice(s.k + 1));
        edges[s.ei] = { a: e.a, b: nid, px: p1, len: plen(p1) };
        edges.push({ a: nid, b: e.b, px: p2, len: plen(p2) });
        edges.push({ a: s.i, b: nid, px: [nodes[s.i], s.p], len: s.d, gap: true });
        joined++;
      }
    }
    edges = dropClutter(nodes, edges, minPiece);
    // compact node ids
    const used = new Map(); const out = [];
    for (const e of edges) for (const n of [e.a, e.b]) if (!used.has(n)) { used.set(n, out.length); out.push(nodes[n]); }
    edges.forEach(e => { e.a = used.get(e.a); e.b = used.get(e.b); });
    return { nodes: out, edges, joined };
  }

  function components(nodes, edges) {
    const par = nodes.map((_, i) => i); const f = i => par[i] === i ? i : (par[i] = f(par[i]));
    for (const e of edges) par[f(e.a)] = f(e.b);
    const cnt = {}; nodes.forEach((_, i) => { const r = f(i); cnt[r] = (cnt[r] || 0) + 1; });
    return Object.values(cnt).sort((a, b) => b - a);
  }

  // ---- main ----
  function traceRoads(img, opts) {
    const o = Object.assign({ tol: 40, close: 1, minLen: 25, spur: 8, gap: 40, minPiece: 80, size: 12800, bounds: null, progress: null }, opts);
    const { width: W, height: H } = img; const prog = o.progress || (() => {});
    prog('Finding road colours', 0.1);
    let m = colourMask(img, o.samples, o.tol);
    for (let i = 0; i < o.close; i++) m = dilate(m, W, H);
    for (let i = 0; i < o.close; i++) m = erode(m, W, H);
    prog('Removing labels and blobs', 0.3);
    const fc = filterComponents(m, W, H, o.minLen);
    prog('Thinning roads to centre lines', 0.45);
    const sk = thin(fc.keep, W, H);
    prog('Building the road network', 0.75);
    const g = cleanGraph(skeletonGraph(sk, W, H), o.spur, o.gap, o.minPiece);
    // pixels -> world metres. bounds: [[z0,x0],[z1,x1]] like Leaflet, default whole map
    const B = o.bounds || [[0, 0], [o.size, o.size]];
    const sx = (B[1][1] - B[0][1]) / W, sz = (B[1][0] - B[0][0]) / H;
    const toW = ([px, py]) => [+(B[0][1] + px * sx).toFixed(1), +(B[1][0] - py * sz).toFixed(1)];
    const nodes = g.nodes.map(toW);
    const edges = g.edges.map(e => { const pts = rdp(e.px, 1.2).map(toW); return { a: e.a, b: e.b, pts, len: +plen(pts).toFixed(1), ...(e.gap ? { gap: true } : {}) }; })
      .filter(e => e.pts.length > 1);
    // make each edge start at node a and end at node b exactly
    edges.forEach(e => { e.pts[0] = nodes[e.a]; e.pts[e.pts.length - 1] = nodes[e.b]; });
    const comps = components(nodes, edges);
    prog('Done', 1);
    return { size: o.size, nodes, edges, stats: { nodes: nodes.length, edges: edges.length, km: +(edges.reduce((s, e) => s + e.len, 0) / 1000).toFixed(1),
      pieces: comps.length, biggestShare: nodes.length ? +(comps[0] / nodes.length).toFixed(2) : 0, gapsJoined: g.joined, blobsDropped: fc.dropped } };
  }

  // sample the median colour around a pixel (for "click a road")
  function sampleColour(img, x, y, r = 1) {
    const { data, width: W, height: H } = img; const rs = [], gs = [], bs = [];
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const xx = Math.min(W - 1, Math.max(0, x + dx)), yy = Math.min(H - 1, Math.max(0, y + dy)), p = (yy * W + xx) * 4;
      rs.push(data[p]); gs.push(data[p + 1]); bs.push(data[p + 2]); }
    const med = a => a.sort((p, q) => p - q)[a.length >> 1];
    return [med(rs), med(gs), med(bs)];
  }

  const api = { traceRoads, sampleColour, colourMask };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.RoadTracer = api;
})(typeof self !== 'undefined' ? self : this);
