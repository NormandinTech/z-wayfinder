// Runs the screenshot alignment off the main thread.
importScripts('stitch.js');
self.onmessage = (ev) => {
  const { tiles, cols } = ev.data; // tiles: [{width,height,buffer}]
  try {
    const t = tiles.map(x => ({ width: x.width, height: x.height, data: new Uint8ClampedArray(x.buffer) }));
    const res = Stitcher.alignGrid(t, cols, f => self.postMessage({ type: 'progress', f }));
    self.postMessage({ type: 'done', res: { pos: res.pos, width: res.width, height: res.height, weak: res.weak.map(p => ({ i: p.i, j: p.j, score: p.score })) } });
  } catch (err) {
    self.postMessage({ type: 'error', msg: String(err && err.message || err) });
  }
};
