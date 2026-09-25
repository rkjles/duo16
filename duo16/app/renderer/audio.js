// ===== Audio: 32 kHz stereo stream from the emulator into an AudioWorklet =====
const WORKLET_SRC = `
class Duo16Out extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(32000 * 2); this.r = 0; this.w = 0; this.n = 0; this.primed = false;
    this.port.onmessage = (e) => {
      const d = e.data; if (d === 'flush') { this.r = this.w = this.n = 0; this.primed = false; return; }
      const cap = this.buf.length;
      // drop the oldest audio if we fall too far behind (keeps latency low)
      if (this.n + d.length > 32000 * 0.25 * 2) { const drop = this.n + d.length - 32000 * 0.12 * 2; this.r = (this.r + drop) % cap; this.n -= drop; if (this.n < 0) this.n = 0; }
      for (let i = 0; i < d.length; i++) { this.buf[this.w] = d[i]; this.w = (this.w + 1) % cap; }
      this.n += d.length;
    };
  }
  process(_in, outs) {
    const out = outs[0]; const L = out[0], R = out[1] || out[0]; const cap = this.buf.length;
    if (!this.primed) { if (this.n < 32000 * 0.05 * 2) { L.fill(0); R.fill(0); return true; } this.primed = true; }
    for (let i = 0; i < L.length; i++) {
      if (this.n >= 2) { L[i] = this.buf[this.r]; R[i] = this.buf[(this.r + 1) % cap]; this.r = (this.r + 2) % cap; this.n -= 2; }
      else { L[i] = 0; R[i] = 0; this.primed = false; }
    }
    return true;
  }
}
registerProcessor('duo16-out', Duo16Out);
`;

class AudioOut {
  constructor() { this.ctx = null; this.node = null; this.gain = null; this.volume = 0.8; this.ready = false; }
  async start() {
    if (this.ctx) { if (this.ctx.state === 'suspended') await this.ctx.resume(); return; }
    try {
      this.ctx = new AudioContext({ sampleRate: 32000, latencyHint: 'interactive' });
      const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
      await this.ctx.audioWorklet.addModule(url);
      this.node = new AudioWorkletNode(this.ctx, 'duo16-out', { outputChannelCount: [2] });
      this.gain = this.ctx.createGain(); this.gain.gain.value = this.volume;
      this.node.connect(this.gain).connect(this.ctx.destination);
      this.ready = true;
    } catch (e) { console.warn('audio unavailable', e); }
  }
  setVolume(v) { this.volume = v; if (this.gain) this.gain.gain.value = v; }
  push(int16) {
    if (!this.ready || !int16.length) return;
    const f = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) f[i] = int16[i] / 32768;
    this.node.port.postMessage(f, [f.buffer]);
  }
  flush() { if (this.ready) this.node.port.postMessage('flush'); }
}
