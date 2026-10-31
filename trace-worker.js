// Runs the road tracer off the main thread so the editor stays responsive.
importScripts('tracer.js');
self.onmessage = (ev) => {
  const { width, height, buffer, opts } = ev.data;
  try {
    const img = { width, height, data: new Uint8ClampedArray(buffer) };
    const res = RoadTracer.traceRoads(img, Object.assign({}, opts, { progress: (msg, f) => self.postMessage({ type: 'progress', msg, f }) }));
    self.postMessage({ type: 'done', res });
  } catch (err) {
    self.postMessage({ type: 'error', msg: String(err && err.message || err) });
  }
};
