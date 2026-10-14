class PcmCaptureProcessor extends AudioWorkletProcessor {
  process(inputs, outputs) {
    for (const output of outputs) for (const channel of output) channel.fill(0);
    const channels = inputs[0];
    if (!channels?.length || !channels[0]?.length) return true;
    const mono = new Float32Array(channels[0].length);
    for (const channel of channels) {
      for (let i = 0; i < mono.length; i++) mono[i] += channel[i] / channels.length;
    }
    this.port.postMessage(mono, [mono.buffer]);
    return true;
  }
}

registerProcessor('pcm-capture', PcmCaptureProcessor);
