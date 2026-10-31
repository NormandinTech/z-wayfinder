// Screenshot stitcher: lines up a grid of overlapping map screenshots.
// Pure functions on pixel arrays, so it runs in a Worker (browser) or Node (tests).
// tiles: [{width,height,data(RGBA)}] in reading order (left to right, top to bottom), all the same size, already cropped.
// alignGrid(tiles, cols) -> {pos:[[x,y]] top-left of each tile in pixels, width, height, pairs:[{i,j,dx,dy,score}]}
(function (root) {
  'use strict';

  // grayscale, downscaled by integer factor f (box filter)
  function gray(t, f) {
    const w = Math.floor(t.width / f), h = Math.floor(t.height / f), g = new Float32Array(w * h), d = t.data, W = t.width;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let s = 0;
      for (let yy = 0; yy < f; yy++) for (let xx = 0; xx < f; xx++) {
        const p = ((y * f + yy) * W + x * f + xx) * 4; s += d[p] * 0.3 + d[p + 1] * 0.59 + d[p + 2] * 0.11;
      }
      g[y * w + x] = s / (f * f);
    }
    return { w, h, g };
  }

  // zero-mean normalized cross-correlation of patch P (from B at px,py size pw x ph) against A at offset (ax,ay)
  function nccAt(A, B, px, py, pw, ph, ax, ay, step) {
    let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, n = 0;
    for (let y = 0; y < ph; y += step) {
      const ra = (ay + y) * A.w + ax, rb = (py + y) * B.w + px;
      for (let x = 0; x < pw; x += step) {
        const a = A.g[ra + x], b = B.g[rb + x];
        sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b; n++;
      }
    }
    const va = saa - sa * sa / n, vb = sbb - sb * sb / n;
    if (va < 1e-3 * n || vb < 1e-3 * n) return -1; // flat area: no information
    return (sab - sa * sb / n) / Math.sqrt(va * vb);
  }

  // find offset (dx,dy) of B's top-left relative to A's top-left, given B is to the right ('h') or below ('v') of A.
  // works coarse-to-fine: search at 1/8, refine at 1/2 and full scale.
  function alignPair(ta, tb, dir, cache) {
    const g = (t, f) => { const k = f; t._g = t._g || {}; return t._g[k] || (t._g[k] = gray(t, f)); };
    const W = ta.width, H = ta.height;
    const search = (f, cx, cy, rx, ry, step) => {
      const A = g(ta, f), B = g(tb, f);
      // patch from B near the side that overlaps A
      const pw = Math.max(8, Math.floor((dir === 'h' ? 0.12 : 0.6) * B.w)), ph = Math.max(8, Math.floor((dir === 'h' ? 0.6 : 0.12) * B.h));
      const px = dir === 'h' ? Math.floor(0.04 * B.w) : Math.floor((B.w - pw) / 2);
      const py = dir === 'h' ? Math.floor((B.h - ph) / 2) : Math.floor(0.04 * B.h);
      let best = { s: -2, dx: 0, dy: 0 };
      const x0 = Math.round((cx - rx) / f), x1 = Math.round((cx + rx) / f), y0 = Math.round((cy - ry) / f), y1 = Math.round((cy + ry) / f);
      for (let oy = y0; oy <= y1; oy++) for (let ox = x0; ox <= x1; ox++) {
        // B top-left at (ox,oy) in A coords => patch sits at (ox+px, oy+py) in A
        const ax = ox + px, ay = oy + py;
        if (ax < 0 || ay < 0 || ax + pw > A.w || ay + ph > A.h) continue;
        const s = nccAt(A, B, px, py, pw, ph, ax, ay, step);
        if (s > best.s) best = { s, dx: ox * f, dy: oy * f };
      }
      return best;
    };
    // coarse: B's left edge somewhere in A's right 85%..10% (overlap 15%-90%), vertical drift +-20%
    let b = dir === 'h' ? search(8, W * 0.55, 0, W * 0.42, H * 0.2, 1) : search(8, 0, H * 0.55, W * 0.2, H * 0.42, 1);
    b = search(2, b.dx, b.dy, 12, 12, 1);
    b = search(1, b.dx, b.dy, 3, 3, 2);
    return { dx: b.dx, dy: b.dy, score: +b.s.toFixed(3) };
  }

  function alignGrid(tiles, cols, progress) {
    const n = tiles.length, rows = Math.ceil(n / cols), pairs = [];
    const prog = progress || (() => {});
    let done = 0; const total = (cols - 1) * rows + cols * (rows - 1);
    for (let i = 0; i < n; i++) {
      const r = Math.floor(i / cols), c = i % cols;
      if (c + 1 < cols && i + 1 < n) { pairs.push({ i, j: i + 1, ...alignPair(tiles[i], tiles[i + 1], 'h') }); prog(++done / total); }
      if (r + 1 < rows && i + cols < n) { pairs.push({ i, j: i + cols, ...alignPair(tiles[i], tiles[i + cols], 'v') }); prog(++done / total); }
    }
    // place tiles: weighted relaxation over all pairs (handles small errors better than chaining)
    const W = tiles[0].width, H = tiles[0].height;
    const pos = tiles.map((_, i) => [(i % cols) * W * 0.7, Math.floor(i / cols) * H * 0.7]);
    // initialise by chaining good pairs from tile 0 (breadth first)
    const good = pairs.filter(p => p.score > 0.5), seen = new Set([0]), queue = [0]; pos[0] = [0, 0];
    while (queue.length) { const a = queue.shift();
      for (const p of good) { const [u, v, s] = p.i === a ? [p.i, p.j, 1] : p.j === a ? [p.j, p.i, -1] : [null];
        if (u === null || seen.has(v)) continue; pos[v] = [pos[u][0] + s * p.dx, pos[u][1] + s * p.dy]; seen.add(v); queue.push(v); } }
    for (let it = 0; it < 200; it++) {
      const acc = tiles.map(() => [0, 0, 0]);
      for (const p of pairs) { const w = Math.max(0.01, p.score) ** 4;
        acc[p.j][0] += w * (pos[p.i][0] + p.dx); acc[p.j][1] += w * (pos[p.i][1] + p.dy); acc[p.j][2] += w;
        acc[p.i][0] += w * (pos[p.j][0] - p.dx); acc[p.i][1] += w * (pos[p.j][1] - p.dy); acc[p.i][2] += w; }
      for (let i = 1; i < n; i++) if (acc[i][2]) pos[i] = [acc[i][0] / acc[i][2], acc[i][1] / acc[i][2]];
    }
    const mx = Math.min(...pos.map(p => p[0])), my = Math.min(...pos.map(p => p[1]));
    const P = pos.map(p => [Math.round(p[0] - mx), Math.round(p[1] - my)]);
    const width = Math.max(...P.map(p => p[0])) + W, height = Math.max(...P.map(p => p[1])) + H;
    const weak = pairs.filter(p => p.score < 0.5);
    return { pos: P, width, height, pairs, weak };
  }

  const api = { alignGrid, alignPair, gray };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Stitcher = api;
})(typeof self !== 'undefined' ? self : this);
