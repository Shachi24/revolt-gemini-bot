class InputProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.inputSampleRate = options.processorOptions.inputSampleRate || 48000;
  }

  process(inputs) {
    const input = inputs[0];
    if (input && input[0]) {
      // Convert Float32 samples to Int16 PCM
      const float32Array = input[0];
      const int16Array = new Int16Array(float32Array.length);
      for (let i = 0; i < float32Array.length; i++) {
        int16Array[i] = Math.max(-1, Math.min(1, float32Array[i])) * 0x7fff;
      }
      this.port.postMessage(int16Array.buffer);
    }
    return true;
  }
}

registerProcessor('input-processor', InputProcessor);
