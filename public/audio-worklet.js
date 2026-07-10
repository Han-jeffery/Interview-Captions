class PcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.sourceRate = sampleRate;
    this.targetRate = 16000;
    this.ratio = this.sourceRate / this.targetRate;
    this.pending = [];
    this.levelTick = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input || input.length === 0) return true;

    let sum = 0;
    for (let i = 0; i < input.length; i += this.ratio) {
      const sample = input[Math.floor(i)] || 0;
      const clipped = Math.max(-1, Math.min(1, sample));
      sum += clipped * clipped;
      this.pending.push(clipped < 0 ? clipped * 0x8000 : clipped * 0x7fff);
    }

    this.levelTick += 1;
    if (this.levelTick >= 8) {
      this.levelTick = 0;
      const rms = Math.sqrt(sum / Math.max(1, Math.floor(input.length / this.ratio)));
      this.port.postMessage({ type: "level", value: Math.min(1, rms * 8) });
    }

    if (this.pending.length >= 640) {
      const frame = this.pending.splice(0, 640);
      const buffer = new ArrayBuffer(frame.length * 2);
      const view = new DataView(buffer);
      frame.forEach((sample, index) => {
        view.setInt16(index * 2, sample, true);
      });
      this.port.postMessage(buffer, [buffer]);
    }

    return true;
  }
}

registerProcessor("pcm-processor", PcmProcessor);
