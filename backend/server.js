// server.js
import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { GoogleGenAI, Modality } from "@google/genai";

// Configuration
dotenv.config();
const PORT = Number(process.env.PORT || 3000);
const SESSION_IDLE_MS = 90_000; // 1.5 minutes idle timeout
const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAY_MS = 2000;
const MODEL = "gemini-2.5-flash-preview-native-audio-dialog";

// Initialize Express
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const FRONTEND_DIR = path.resolve(__dirname, "../frontend");

// Middleware
app.use(express.static(FRONTEND_DIR));
app.use(express.json());

// Health Check Endpoint
app.get("/healthz", (_, res) => res.json({ 
  status: "healthy", 
  timestamp: new Date().toISOString() 
}));

const server = http.createServer(app);

// WebSocket Server
const wss = new WebSocketServer({ 
  server,
  clientTracking: true,
  perMessageDeflate: true
});

// Client Session Manager
wss.on("connection", async (clientWS, req) => {
  console.log(`✅ New connection from ${req.socket.remoteAddress}`);
  let reconnectAttempts = 0;
  
  // Session State
  const sessionState = {
    ai: new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY }),
    geminiSession: null,
    isAISpeaking: false,
    idleTimer: null,
    isActive: true
  };

  // --- Core Functions ---

  const resetIdleTimer = () => {
    clearTimeout(sessionState.idleTimer);
    sessionState.idleTimer = setTimeout(() => {
      safeSend(clientWS, { 
        type: "session_timeout", 
        message: "Session ended due to inactivity." 
      });
      cleanupSession();
    }, SESSION_IDLE_MS);
  };

  const cleanupSession = () => {
    if (!sessionState.isActive) return;
    sessionState.isActive = false;
    
    clearTimeout(sessionState.idleTimer);
    
    if (sessionState.geminiSession) {
      try {
        sessionState.geminiSession.close();
      } catch (e) {
        console.warn("Gemini session close error:", e);
      }
      sessionState.geminiSession = null;
    }

    try {
      if (clientWS.readyState === clientWS.OPEN) {
        clientWS.close(1000, "Session cleanup");
      }
    } catch (e) {
      console.warn("Client WS close error:", e);
    }
  };

  const safeSend = (ws, data, isBinary = false) => {
    if (ws.readyState === ws.OPEN) {
      try {
        ws.send(isBinary ? data : JSON.stringify(data));
      } catch (e) {
        console.warn("Send error:", e);
      }
    }
  };

  const handleGeminiAudio = (audioData) => {
    try {
      const pcmBytes = Buffer.from(audioData, "base64");
      if (!pcmBytes.length) {
        console.warn("Empty audio chunk received");
        return;
      }
      
      const framed = Buffer.concat([Buffer.from([0x01]), pcmBytes]);
      safeSend(clientWS, framed, true);
    } catch (e) {
      console.error("Audio processing error:", e);
    }
  };

  const openGeminiSession = async () => {
    if (sessionState.geminiSession?.readyState === WebSocket.OPEN) {
      return sessionState.geminiSession;
    }

    try {
      // Cleanup previous session if exists
      if (sessionState.geminiSession) {
        try {
          sessionState.geminiSession.close();
        } catch (e) {
          console.warn("Previous session cleanup error:", e);
        }
      }

      sessionState.geminiSession = await sessionState.ai.live.connect({
        model: MODEL,
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: "You are a helpful assistant. Reply in speech only.",
        },
        callbacks: {
          onopen: () => {
            console.log("🔌 Gemini session established");
            sessionState.isAISpeaking = false;
            safeSend(clientWS, { type: "status", message: "AI session ready" });
            resetIdleTimer();
          },
          onmessage: (msg) => {
            resetIdleTimer();
            if (msg?.data) {
              sessionState.isAISpeaking = true;
              handleGeminiAudio(msg.data);
            } else if (msg?.serverContent?.turnComplete) {
              sessionState.isAISpeaking = false;
              safeSend(clientWS, Buffer.from([0x02]), true);
            }
          },
          onerror: (err) => {
            console.error("Gemini error:", err);
            safeSend(clientWS, { 
              type: "error", 
              message: "AI service error" 
            });
            attemptReconnect();
          },
          onclose: () => {
            console.log("Gemini session closed");
            sessionState.isAISpeaking = false;
            attemptReconnect();
          }
        }
      });
      
      return sessionState.geminiSession;
    } catch (error) {
      console.error("Session creation failed:", error);
      throw error;
    }
  };

  const attemptReconnect = () => {
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.log("Max reconnection attempts reached");
      safeSend(clientWS, { 
        type: "error", 
        message: "Connection lost. Please refresh." 
      });
      return;
    }

    reconnectAttempts++;
    console.log(`Reconnecting attempt ${reconnectAttempts}...`);
    
    setTimeout(async () => {
      if (sessionState.isActive) {
        try {
          await openGeminiSession();
          reconnectAttempts = 0; // Reset on success
        } catch (e) {
          console.warn("Reconnect failed:", e);
          attemptReconnect();
        }
      }
    }, RECONNECT_DELAY_MS);
  };

  const processAudioInput = async (audioBuffer) => {
    try {
      if (!sessionState.geminiSession) {
        await openGeminiSession();
      }

      if (sessionState.isAISpeaking) {
        safeSend(clientWS, Buffer.from([0x03]), true);
        await sessionState.geminiSession.sendRealtimeInput({ 
          event: { type: "stop" } 
        });
        sessionState.isAISpeaking = false;
      }

      await sessionState.geminiSession.sendRealtimeInput({
        audio: {
          data: audioBuffer.toString("base64"),
          mimeType: "audio/pcm;rate=16000"
        }
      });
    } catch (error) {
      console.error("Audio processing error:", error);
      safeSend(clientWS, { 
        type: "error", 
        message: "Error processing audio" 
      });
    }
  };

  // --- Event Handlers ---

  clientWS.on("message", async (data, isBinary) => {
    if (!sessionState.isActive) return;
    
    resetIdleTimer();
    
    try {
      if (isBinary) {
        await processAudioInput(data);
      } else {
        const msg = JSON.parse(data.toString());
        if (msg.type === "interruption" && sessionState.geminiSession) {
          safeSend(clientWS, Buffer.from([0x03]), true);
          await sessionState.geminiSession.sendRealtimeInput({ 
            event: { type: "stop" } 
          });
          sessionState.isAISpeaking = false;
        }
      }
    } catch (error) {
      console.error("Message processing error:", error);
    }
  });

  clientWS.on("close", () => {
    console.log("Client disconnected");
    cleanupSession();
  });

  clientWS.on("error", (error) => {
    console.error("Client error:", error);
    cleanupSession();
  });

  // Initialize
  resetIdleTimer();
});

// Server Startup
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`Serving frontend from: ${FRONTEND_DIR}`);
});

// Graceful Shutdown
process.on("SIGTERM", () => {
  console.log("SIGTERM received - shutting down");
  wss.clients.forEach(client => client.close(1001, "Server shutdown"));
  server.close(() => process.exit(0));
});