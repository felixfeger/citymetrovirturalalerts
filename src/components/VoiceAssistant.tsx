import { GoogleGenAI, LiveServerMessage, Modality, Type, FunctionDeclaration } from "@google/genai";
import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Mic, MicOff, Volume2, Shield, AlertTriangle, Map, Clock, ExternalLink, Train, Info } from "lucide-react";

const SYSTEM_INSTRUCTION = `Role: You are the City Metro Voice Assistant, the official digital concierge for City Metro, serving Lego City County. Your goal is to provide accurate, real-time, and polite transit information to commuters. You are part of the Republic State Railway and Transportation Authority, alongside your partner agency, Republic State Railways.

Core Identity & Tone:
Founder: Founded in 2022 by Felix.
Tone: Professional, efficient, and helpful. You represent a government agency.
Location: Based at Union Station Lego City (100 S Union Station Way).

Knowledge Base & Infrastructure:
Rail Network: You solely operate the Light Rail and Subway network, consisting of the A, B, D, E, F (Airport Terminal Connector), and K lines.
Joint Operations: You collaborate with Republic State Railways to operate City Metro-North, City MetroLink, and City Metro Express.
Bus Fleet: You operate numerous lines, including the 76 DTLC Loop, 111, 112, 113, 114, and 211B.
Security: You are policed by the City Metro Transit Police, supported by the Lego City County Sheriff and Lego City Police Department.

Live Arrivals Logic:
- Arrivals are estimated based on train positions.
- Each "block" between stations is approximately 30 seconds.
- Most stations are about 90 seconds (3 blocks) apart.
- Use the getLiveArrivals tool to fetch real-time data from the Cloudflare worker.

Digital Directory:
General Info: citymetro.xyz
Service Alerts: alerts.citymetro.xyz
Live Arrivals: livearrivals.citymetro.xyz
Transit Police: police.citymetro.xyz
Trip Planning: trip-planner.citymetro.xyz
Network Map: map.citymetro.xyz

Interaction Guidelines:
Emergency: If a user mentions a crime or safety emergency, immediately direct them to contact the City Metro Transit Police at police.citymetro.xyz or call emergency services.
Navigation: If a user asks "How do I get to...", refer them to the trip-planner.citymetro.xyz or the map at map.citymetro.xyz.
Context: Always acknowledge Union Station Lego City as the major hub for all rail and bus transfers.
Brevity: Since you are a voice agent, keep responses concise. Use "Scan-able" information (e.g., "The next A Line train arrives in 4 minutes").

Example Response Style:
"Welcome to City Metro, part of the Republic State Railway and Transportation Authority. I am your assistant. How can I help you navigate Lego City County today?"`;

const getLiveArrivalsTool: FunctionDeclaration = {
  name: "getLiveArrivals",
  description: "Fetch real-time train arrival data for City Metro stations.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      station: {
        type: Type.STRING,
        description: "The name of the station to check (e.g., 'Union Station', 'Airport').",
      },
      line: {
        type: Type.STRING,
        description: "Optional: The line to filter by (A, B, D, E, F, K).",
      }
    },
    required: ["station"],
  },
};

export default function VoiceAssistant() {
  const [isActive, setIsActive] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [status, setStatus] = useState<"idle" | "connecting" | "active" | "error">("idle");
  const [aiResponse, setAiResponse] = useState("");
  
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sessionRef = useRef<any>(null);
  const audioQueueRef = useRef<Int16Array[]>([]);
  const isPlayingRef = useRef(false);

  const handleToolCall = async (toolCall: any) => {
    if (toolCall.name === "getLiveArrivals") {
      try {
        const response = await fetch("https://trains-api.felixfeger46.workers.dev/");
        const data = await response.json();
        
        // Filter or process data based on station/line if needed
        // For now, we return the whole payload and let the model interpret it based on the 30s/block logic
        return {
          arrivals: data,
          logic_note: "Each block is ~30s, stations are ~90s apart."
        };
      } catch (err) {
        console.error("Tool call failed:", err);
        return { error: "Failed to fetch live arrivals." };
      }
    }
    return { error: "Unknown tool." };
  };

  const startSession = async () => {
    try {
      setStatus("connecting");
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      
      const session = await ai.live.connect({
        model: "gemini-3.1-flash-live-preview",
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Zephyr" } },
          },
          systemInstruction: SYSTEM_INSTRUCTION,
          tools: [
            { functionDeclarations: [getLiveArrivalsTool] },
            { googleSearch: {} }
          ],
        },
        callbacks: {
          onopen: () => {
            setStatus("active");
            setIsActive(true);
            startAudioCapture();
          },
          onmessage: async (message: LiveServerMessage) => {
            if (message.serverContent?.modelTurn?.parts) {
              for (const part of message.serverContent.modelTurn.parts) {
                if (part.inlineData?.data) {
                  const base64Data = part.inlineData.data;
                  const binaryString = atob(base64Data);
                  const bytes = new Uint8Array(binaryString.length);
                  for (let i = 0; i < binaryString.length; i++) {
                    bytes[i] = binaryString.charCodeAt(i);
                  }
                  const pcmData = new Int16Array(bytes.buffer);
                  audioQueueRef.current.push(pcmData);
                  if (!isPlayingRef.current) {
                    playNextInQueue();
                  }
                }
              }
            }

            if (message.toolCall) {
              for (const call of message.toolCall.functionCalls) {
                const result = await handleToolCall(call);
                sessionRef.current.sendToolResponse({
                  functionResponses: [{
                    name: call.name,
                    response: result,
                    id: call.id
                  }]
                });
              }
            }

            if (message.serverContent?.interrupted) {
              audioQueueRef.current = [];
              isPlayingRef.current = false;
            }

            if (message.serverContent?.modelTurn?.parts?.[0]?.text) {
              setAiResponse(prev => prev + message.serverContent!.modelTurn!.parts![0].text);
            }
          },
          onclose: () => {
            stopSession();
          },
          onerror: (error) => {
            console.error("Live API Error:", error);
            setStatus("error");
          }
        }
      });

      sessionRef.current = session;
    } catch (err) {
      console.error("Failed to start session:", err);
      setStatus("error");
    }
  };

  const stopSession = () => {
    setIsActive(false);
    setStatus("idle");
    if (sessionRef.current) {
      sessionRef.current.close();
      sessionRef.current = null;
    }
    stopAudioCapture();
    setAiResponse("");
  };

  const startAudioCapture = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      
      const audioContext = new AudioContext({ sampleRate: 16000 });
      audioContextRef.current = audioContext;
      
      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;

      processor.onaudioprocess = (e) => {
        if (!isActive || isMuted || !sessionRef.current) return;
        
        const inputData = e.inputBuffer.getChannelData(0);
        const pcmData = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
          pcmData[i] = Math.max(-1, Math.min(1, inputData[i])) * 0x7FFF;
        }
        
        const base64Data = btoa(String.fromCharCode(...new Uint8Array(pcmData.buffer)));
        sessionRef.current.sendRealtimeInput({
          audio: { data: base64Data, mimeType: "audio/pcm;rate=16000" }
        });
      };

      source.connect(processor);
      processor.connect(audioContext.destination);
    } catch (err) {
      console.error("Microphone access denied:", err);
      setStatus("error");
    }
  };

  const stopAudioCapture = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
  };

  const playNextInQueue = async () => {
    if (audioQueueRef.current.length === 0) {
      isPlayingRef.current = false;
      return;
    }

    isPlayingRef.current = true;
    const pcmData = audioQueueRef.current.shift()!;
    
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext({ sampleRate: 24000 });
    }
    
    const buffer = audioContextRef.current.createBuffer(1, pcmData.length, 24000);
    const channelData = buffer.getChannelData(0);
    for (let i = 0; i < pcmData.length; i++) {
      channelData[i] = pcmData[i] / 0x7FFF;
    }

    const source = audioContextRef.current.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContextRef.current.destination);
    source.onended = () => playNextInQueue();
    source.start();
  };

  return (
    <div className="flex flex-col items-center min-h-screen bg-slate-50 text-slate-900 p-6 font-sans selection:bg-yellow-200 selection:text-slate-900">
      {/* Header with Logo */}
      <header className="w-full max-w-4xl flex items-center justify-between mb-16 pt-4 border-b border-slate-200 pb-8">
        <div className="flex items-center gap-6">
          <div className="w-16 h-16 bg-white rounded-full flex items-center justify-center border-2 border-slate-900 p-1 shadow-sm">
            <div className="w-full h-full bg-white rounded-full flex items-center justify-center">
              <span className="text-slate-900 text-4xl font-light leading-none mb-1">m</span>
            </div>
          </div>
          <div>
            <h1 className="text-4xl font-black tracking-tighter uppercase leading-none text-slate-900">City Metro</h1>
            <p className="text-slate-500 text-xs font-bold uppercase tracking-[0.2em] mt-1">City Metro Virtural Assistant</p>
          </div>
        </div>
        <div className="hidden md:flex items-center gap-4 text-[10px] font-bold uppercase tracking-widest text-slate-400">
          <span>Republic State Railway</span>
          <div className="w-1 h-1 bg-slate-300 rounded-full" />
          <span>Republic State Railway and Transportation Authority</span>
        </div>
      </header>

      {/* Main Interaction Area */}
      <main className="w-full max-w-3xl flex flex-col items-center">
        
        {/* Status Bar */}
        <div className="w-full flex justify-between items-center mb-12 px-4">
          <div className="flex items-center gap-3">
            <div className={`w-3 h-3 rounded-full ${status === 'active' ? 'bg-green-500 shadow-[0_0_15px_rgba(34,197,94,0.4)]' : status === 'connecting' ? 'bg-yellow-500' : 'bg-slate-300'}`} />
            <span className="text-sm font-black uppercase tracking-tighter text-slate-600">
              {status === 'active' ? 'System Live' : status === 'connecting' ? 'Initializing...' : 'System Standby'}
            </span>
          </div>
          <div className="text-slate-400 text-xs font-mono">
            {new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
          </div>
        </div>

        {/* Voice Orb Container */}
        <div className="relative w-full aspect-square max-w-[400px] flex items-center justify-center mb-16">
          <AnimatePresence>
            {isActive && (
              <>
                <motion.div
                  initial={{ scale: 0.5, opacity: 0 }}
                  animate={{ scale: [1, 1.2, 1], opacity: [0.1, 0.2, 0.1] }}
                  transition={{ repeat: Infinity, duration: 3 }}
                  className="absolute inset-0 bg-blue-600 rounded-full blur-[100px]"
                />
                <motion.div
                  initial={{ scale: 0.8, opacity: 0 }}
                  animate={{ scale: [1, 1.1, 1], opacity: [0.2, 0.4, 0.2] }}
                  transition={{ repeat: Infinity, duration: 2 }}
                  className="absolute inset-20 border-2 border-blue-600/20 rounded-full"
                />
              </>
            )}
          </AnimatePresence>
          
          <motion.div
            animate={isActive ? {
              scale: [1, 1.02, 1],
            } : {}}
            transition={{ repeat: Infinity, duration: 1.5 }}
            className={`w-64 h-64 rounded-full flex items-center justify-center transition-all duration-700 relative z-10 shadow-xl ${
              isActive ? 'bg-blue-600 text-white' : 'bg-white text-slate-300 border border-slate-200'
            }`}
          >
            {isActive ? (
              <div className="flex flex-col items-center gap-2">
                <Volume2 className="w-16 h-16" />
                <span className="text-[10px] font-black uppercase tracking-widest">Listening</span>
              </div>
            ) : (
              <Train className="w-16 h-16 opacity-20" />
            )}
          </motion.div>
        </div>

        {/* Controls */}
        <div className="w-full flex flex-col items-center gap-8">
          {!isActive ? (
            <button
              onClick={startSession}
              disabled={status === 'connecting'}
              className="group relative px-12 py-6 bg-slate-900 text-white font-black uppercase tracking-tighter text-2xl transition-all hover:bg-blue-700 active:scale-95 disabled:opacity-50 shadow-2xl shadow-slate-200"
            >
              <div className="flex items-center gap-4">
                <Mic className="w-8 h-8" />
                <span>Activate Assistant</span>
              </div>
              <div className="absolute -bottom-2 -right-2 w-full h-full border-2 border-slate-900 -z-10 group-hover:translate-x-1 group-hover:translate-y-1 transition-transform" />
            </button>
          ) : (
            <div className="flex items-center gap-6">
              <button
                onClick={() => setIsMuted(!isMuted)}
                className={`p-6 border-2 transition-all active:scale-90 shadow-sm ${
                  isMuted ? 'bg-red-500 border-red-500 text-white' : 'bg-white border-slate-200 text-slate-600 hover:border-slate-400'
                }`}
              >
                {isMuted ? <MicOff className="w-8 h-8" /> : <Mic className="w-8 h-8" />}
              </button>
              <button
                onClick={stopSession}
                className="px-12 py-6 bg-red-600 text-white font-black uppercase tracking-tighter text-2xl transition-all hover:bg-red-700 active:scale-95 shadow-xl shadow-red-100"
              >
                Deactivate
              </button>
            </div>
          )}

          {/* Transcript / Response Area */}
          <div className="w-full bg-white border border-slate-200 p-8 min-h-[120px] relative shadow-sm rounded-xl">
            <div className="absolute -top-3 left-6 bg-slate-50 px-3 text-[10px] font-black uppercase tracking-widest text-slate-400">
              Real-time Output
            </div>
            <p className="text-xl font-medium leading-relaxed text-slate-700 italic">
              {aiResponse || (isActive ? "Awaiting your command..." : "System ready. Please activate to begin.")}
            </p>
          </div>
        </div>
      </main>

      {/* Footer Grid */}
      <footer className="w-full max-w-5xl mt-24 grid grid-cols-1 md:grid-cols-3 gap-1 border-t border-slate-200 bg-white shadow-sm rounded-t-3xl overflow-hidden">
        <a href="https://police.citymetro.xyz" className="group p-8 hover:bg-slate-50 transition-colors flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <Shield className="w-6 h-6 text-slate-300 group-hover:text-blue-600 transition-colors" />
            <ExternalLink className="w-4 h-4 opacity-0 group-hover:opacity-100 transition-opacity text-slate-300" />
          </div>
          <div>
            <h3 className="font-black uppercase tracking-tighter text-lg text-slate-900">Transit Police</h3>
            <p className="text-slate-500 text-sm mt-1">Immediate safety & security assistance.</p>
          </div>
        </a>

        <a href="https://trip-planner.citymetro.xyz" className="group p-8 hover:bg-slate-50 transition-colors flex flex-col gap-4 border-x border-slate-100">
          <div className="flex items-center justify-between">
            <Map className="w-6 h-6 text-slate-300 group-hover:text-blue-600 transition-colors" />
            <ExternalLink className="w-4 h-4 opacity-0 group-hover:opacity-100 transition-opacity text-slate-300" />
          </div>
          <div>
            <h3 className="font-black uppercase tracking-tighter text-lg text-slate-900">Trip Planner</h3>
            <p className="text-slate-500 text-sm mt-1">Navigate Lego City County network.</p>
          </div>
        </a>

        <a href="https://livearrivals.citymetro.xyz" className="group p-8 hover:bg-slate-50 transition-colors flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <Clock className="w-6 h-6 text-slate-300 group-hover:text-blue-600 transition-colors" />
            <ExternalLink className="w-4 h-4 opacity-0 group-hover:opacity-100 transition-opacity text-slate-300" />
          </div>
          <div>
            <h3 className="font-black uppercase tracking-tighter text-lg text-slate-900">Live Arrivals</h3>
            <p className="text-slate-500 text-sm mt-1">Real-time tracking & estimates.</p>
          </div>
        </a>
      </footer>

      {/* Bottom Branding */}
      <div className="mt-16 mb-8 flex flex-col items-center gap-4 opacity-70">
        <div className="flex items-center gap-4">
          <span className="text-[10px] font-black uppercase tracking-[0.1em] text-slate-900 text-center">
            Lego City County Metropollitian Transportation Authority * Republic States Railways
          </span>
        </div>
        <div className="flex flex-col items-center gap-1">
          <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500 text-center">
            Copyright 2026 by the Republic State Railway and Transporation Authoiry
          </p>
          <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-900 text-center">
            An Official Website of the Republic States Government
          </p>
        </div>
      </div>
    </div>
  );
}
