// app.js - Optimized Voice Interface Client
class VoiceSession {
  constructor() {
    // DOM Elements
    this.themeToggle = document.getElementById("theme-toggle");
    this.sessionToggleButton = document.getElementById("sessionToggleButton");
    this.body = document.body;

    // Audio Configuration
    this.TARGET_SAMPLE_RATE = 16000;
    this.PLAYBACK_SAMPLE_RATE = 24000;

    // Session State
    this.state = {
      isActive: false,
      isLoading: false,
      isStarting: false,
      audioStreamEnded: false,
    };

    // Audio Context
    this.audioContext = null;
    this.mediaStreamSource = null;
    this.inputNode = null;
    this.localStream = null;
    this.webSocket = null;

    // Audio Scheduling
    this.nextStartTime = 0;
    this.activeSources = new Set();
    this.pendingPlaybackTimeout = null;

    // Initialize
    this.initTheme();
    this.bindEvents();
  }

  // =====================
  // CORE FUNCTIONALITY
  // =====================

  async startSession() {
    if (this.state.isStarting || this.state.isActive) {
      console.debug("Session start prevented - already active/starting");
      return;
    }

    this.state.isStarting = true;
    this.state.isLoading = true;
    this.updateButtonState("loading");

    try {
      // Initialize Audio Pipeline
      await this.initAudioPipeline();

      // Initialize WebSocket Connection
      await this.initWebSocket();

      console.log("Session started successfully");
    } catch (error) {
      console.error("Session startup failed:", error);
      this.endSessionCleanup();
      this.showError("Failed to start session. Please try again.");
    }
  }

  endSession() {
    if (this.webSocket?.readyState === WebSocket.OPEN) {
      this.webSocket.close(1000, "User ended session");
    } else {
      this.endSessionCleanup();
    }
  }

  // =====================
  // AUDIO MANAGEMENT
  // =====================

  async initAudioPipeline() {
    try {
      // Get microphone access
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: this.TARGET_SAMPLE_RATE,
          echoCancellation: true,
          noiseSuppression: true,
        },
        video: false,
      });

      // Create audio context
      this.audioContext = new (window.AudioContext ||
        window.webkitAudioContext)({
        sampleRate: this.PLAYBACK_SAMPLE_RATE,
      });
      await this.audioContext.resume();

      // Set up audio worklet
      if (!this.audioContext.audioWorklet) {
        throw new Error("AudioWorklet not supported");
      }

      await this.audioContext.audioWorklet.addModule("input-processor.js");
      this.inputNode = new AudioWorkletNode(
        this.audioContext,
        "input-processor",
        {
          processorOptions: {
            inputSampleRate: this.audioContext.sampleRate,
          },
        }
      );

      // Set up audio graph
      this.mediaStreamSource = this.audioContext.createMediaStreamSource(
        this.localStream
      );
      const gainNode = this.audioContext.createGain();
      gainNode.gain.setValueAtTime(0, this.audioContext.currentTime);

      this.mediaStreamSource.connect(this.inputNode);
      this.inputNode.connect(gainNode);
      gainNode.connect(this.audioContext.destination);

      // Handle audio data from worklet
      this.inputNode.port.onmessage = (event) => {
        if (event.data && this.webSocket?.readyState === WebSocket.OPEN) {
          this.webSocket.send(event.data);
        }
      };
    } catch (error) {
      console.error("Audio pipeline initialization failed:", error);
      throw error;
    }
  }

  async queueAudio(arrayBuffer) {
    if (!this.audioContext || this.audioContext.state !== "running") {
      return;
    }

    try {
      // Convert and normalize audio data
      const int16Array = new Int16Array(arrayBuffer);
      const float32Array = new Float32Array(int16Array.length);

      for (let i = 0; i < int16Array.length; i++) {
        float32Array[i] = Math.max(-1, Math.min(1, int16Array[i] / 32768.0));
      }

      // Schedule playback
      this.nextStartTime = Math.max(
        this.nextStartTime,
        this.audioContext.currentTime
      );

      const audioBuffer = this.audioContext.createBuffer(
        1,
        float32Array.length,
        this.PLAYBACK_SAMPLE_RATE
      );
      audioBuffer.copyToChannel(float32Array, 0);

      const source = this.audioContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.audioContext.destination);

      source.addEventListener("ended", () => {
        this.activeSources.delete(source);
      });

      source.start(this.nextStartTime);
      this.nextStartTime += audioBuffer.duration;
      this.activeSources.add(source);
    } catch (error) {
      console.error("Audio queuing failed:", error);
    }
  }

  stopAllAudio() {
    this.activeSources.forEach((source) => {
      try {
        source.stop();
      } catch (e) {
        console.debug("Error stopping audio source:", e);
      }
    });
    this.activeSources.clear();
    this.nextStartTime = 0;
  }

  // =====================
  // WEBSOCKET MANAGEMENT
  // =====================

  async initWebSocket() {
    return new Promise((resolve, reject) => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const backendPort = 3000; // Your backend port
      this.webSocket = new WebSocket(`${protocol}//${window.location.hostname}:${backendPort}`);

      this.webSocket.onopen = () => {
        console.log("WebSocket connected");
        resolve();
      };

      this.webSocket.onerror = (error) => {
        console.error("WebSocket error:", error);
        reject(error);
      };

      this.webSocket.onclose = (event) => {
        if (event.code !== 1000) {
          // Abnormal closure
          console.warn(`WebSocket closed (${event.code}), reconnecting...`);
          setTimeout(() => this.initWebSocket(), 1000);
        }
      };
    });
  }

  handleBinaryMessage(data) {
    const view = new DataView(data);
    const messageType = view.getUint8(0);

    switch (messageType) {
      case 0x01: // Audio data
        this.queueAudio(data.slice(1));
        break;
      case 0x02: // Turn complete
        console.debug("AI turn complete");
        this.state.audioStreamEnded = true;
        break;
      case 0x03: // Interruption
        console.debug("Interruption received");
        this.stopAllAudio();
        break;
      default:
        console.warn("Unknown binary message type:", messageType);
    }
  }

  handleJSONMessage(data) {
    try {
      const message = JSON.parse(data);

      switch (message.type) {
        case "status":
          this.handleStatusMessage(message);
          break;
        case "error":
          console.error("Server error:", message.message);
          this.showError(message.message);
          this.endSession();
          break;
        case "session_timeout":
          this.showNotification(message.message);
          this.endSessionCleanup();
          break;
        default:
          console.warn("Unknown message type:", message.type);
      }
    } catch (error) {
      console.error("JSON message parsing failed:", error);
    }
  }

  handleStatusMessage(message) {
    console.log("Status:", message.message);

    if (message.message.includes("opened")) {
      this.playSound("sounds/stream-start.ogg");
      this.state.isActive = true;
      this.state.isLoading = false;
      this.state.isStarting = false;
      this.updateButtonState("active");
    } else if (message.message.includes("closed")) {
      if (this.state.isActive) {
        this.endSessionCleanup();
      }
    }
  }

  attemptReconnect() {
    if (this.reconnectAttempts > 3) {
      console.log("Max reconnection attempts reached");
      this.showError("Connection lost. Please refresh the page.");
      return;
    }

    this.reconnectAttempts = (this.reconnectAttempts || 0) + 1;
    const delay = Math.min(1000 * this.reconnectAttempts, 5000);

    console.log(
      `Attempting reconnect #${this.reconnectAttempts} in ${delay}ms`
    );

    setTimeout(() => {
      if (this.state.isActive) {
        this.initWebSocket().catch(() => this.attemptReconnect());
      }
    }, delay);
  }

  // =====================
  // SESSION CLEANUP
  // =====================

  endSessionCleanup() {
    this.playSound("sounds/stream-end.ogg");
    console.log("Cleaning up session...");

    // Clear any pending timeouts
    if (this.pendingPlaybackTimeout) {
      clearTimeout(this.pendingPlaybackTimeout);
      this.pendingPlaybackTimeout = null;
    }

    // Stop all audio playback
    this.stopAllAudio();

    // Clean up microphone
    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => track.stop());
      this.localStream = null;
    }

    // Clean up audio nodes
    if (this.inputNode) {
      this.inputNode.port.onmessage = null;
      this.inputNode.disconnect();
      this.inputNode = null;
    }

    if (this.mediaStreamSource) {
      this.mediaStreamSource.disconnect();
      this.mediaStreamSource = null;
    }

    // Close audio context
    if (this.audioContext && this.audioContext.state !== "closed") {
      this.audioContext
        .close()
        .then(() => {
          this.audioContext = null;
        })
        .catch((e) => console.error("AudioContext close error:", e));
    }

    // Reset state
    this.state = {
      isActive: false,
      isLoading: false,
      isStarting: false,
      audioStreamEnded: false,
    };

    this.updateButtonState("inactive");
  }

  // =====================
  // UI MANAGEMENT
  // =====================

  initTheme() {
    const savedTheme =
      localStorage.getItem("theme") ||
      (window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light");
    this.applyTheme(savedTheme);

    this.themeToggle.addEventListener("change", () => {
      const theme = this.themeToggle.checked ? "dark" : "light";
      this.applyTheme(theme);
      localStorage.setItem("theme", theme);
    });

    window
      .matchMedia("(prefers-color-scheme: dark)")
      .addEventListener("change", (e) => {
        const theme = e.matches ? "dark" : "light";
        this.applyTheme(theme);
        localStorage.setItem("theme", theme);
      });
  }

  applyTheme(theme) {
    this.body.classList.toggle("dark-mode", theme === "dark");
    this.themeToggle.checked = theme === "dark";
  }

  updateButtonState(state) {
    this.sessionToggleButton.disabled = state === "loading";
    this.sessionToggleButton.classList.toggle(
      "loading-state",
      state === "loading"
    );
    this.sessionToggleButton.classList.toggle(
      "active-session",
      state === "active"
    );

    if (state === "loading") {
      this.sessionToggleButton.innerHTML =
        '<i class="fas fa-spinner fa-spin"></i>';
      this.sessionToggleButton.setAttribute("aria-label", "Loading session...");
    } else if (state === "active") {
      this.sessionToggleButton.innerHTML = '<i class="fas fa-stop"></i>';
      this.sessionToggleButton.setAttribute("aria-label", "End session");
    } else {
      this.sessionToggleButton.innerHTML = '<i class="fas fa-microphone"></i>';
      this.sessionToggleButton.setAttribute("aria-label", "Start session");
    }
  }

  playSound(soundFile) {
    try {
      const audio = new Audio(soundFile);
      audio.play().catch((e) => console.error("Audio play failed:", e));
    } catch (e) {
      console.error("Sound playback error:", e);
    }
  }

  showError(message) {
    // Implement your error display logic here
    console.error("Error:", message);
    alert(message); // Replace with better UI
  }

  showNotification(message) {
    // Implement your notification display logic here
    console.log("Notification:", message);
    alert(message); // Replace with better UI
  }

  bindEvents() {
    this.sessionToggleButton.addEventListener("click", () => {
      if (this.state.isLoading) return;
      this.state.isActive ? this.endSession() : this.startSession();
    });
  }
}

// Initialize the application when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
  new VoiceSession();
});