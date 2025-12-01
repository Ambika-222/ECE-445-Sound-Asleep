import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Line, LineChart, ResponsiveContainer, XAxis, YAxis } from "recharts";
import {
  Bluetooth,
  Brain,
  Headphones,
  Play,
  Activity,
  Settings,
  Timer,
  Battery,
  Waves,
} from "lucide-react";

// Helpers: mock streaming data for demo mode (single channel)
function useStreamingData(points = 256, hz = 25) {
  const [data, setData] = useState(() =>
    Array.from({ length: points }, (_, i) => ({ t: i, v: 0 }))
  );
  useEffect(() => {
    const id = setInterval(() => {
      setData((prev) => {
        const nextV =
          Math.sin(prev.length / 8 + Math.random() * 0.2) * 40 +
          (Math.random() - 0.5) * 8;
        const next = [
          ...prev.slice(1),
          { t: prev[prev.length - 1].t + 1, v: nextV },
        ];
        return next;
      });
    }, 1000 / hz);
    return () => clearInterval(id);
  }, [hz]);
  return data;
}

function ImpedanceBadge({ value }: { value: number }) {
  const color =
    value < 25 ? "bg-emerald-600" : value < 60 ? "bg-amber-500" : "bg-rose-600";
  return (
    <Badge variant="secondary" className={`text-white ${color}`}>
      {value.toFixed(0)} kΩ
    </Badge>
  );
}

// Service / characteristic UUIDs for EEG
const EEG_SERVICE_UUID = "00000000-cc7a-482a-984a-7f2ed5b3e58f";
const EEG_CHAR_UUID = "00000000-8e22-4541-9d4c-21edae82ed19";

type EegPoint = { t: number; v: number };

// Main UI component
export default function SoundAsleepUI() {
  // Mock EEG stream (one channel)
  const mockSingle = useStreamingData(256, 30);

  // Build 8 mock channels from the single mock (phase / gain tweaks)
  const mockEeg: EegPoint[][] = useMemo(() => {
    return Array.from({ length: 8 }, (_, ch) =>
      mockSingle.map((p, idx) => ({
        t: p.t,
        v:
          p.v *
          (1 + ch * 0.1) + // slightly different gain
          Math.sin((idx / 16 + ch) * 0.3) * 3, // tiny phase wobble
      }))
    );
  }, [mockSingle]);

  // Real EEG buffer: 8 channels × 256 points each
  const [eeg, setEeg] = useState<EegPoint[][]>(() =>
    Array.from({ length: 8 }, () =>
      Array.from({ length: 256 }, (_, i) => ({ t: i, v: 0 }))
    )
  );

  const [paired, setPaired] = useState(false);
  const [mockDemo, setMockDemo] = useState(true);
  const [stimulationOn, setStimulationOn] = useState(false);
  const [threshold, setThreshold] = useState([65]);
  const [volume, setVolume] = useState([55]);
  const [algorithm, setAlgorithm] = useState("YASA");
  const [latencyMs, setLatencyMs] = useState(120);
  const [battery, setBattery] = useState(78);
  const [log, setLog] = useState<string[]>([
    "App initialized.",
    "Awaiting device pairing…",
  ]);

  // Which EEG data to show: mock vs real
  const eegForDisplay = mockDemo ? mockEeg : eeg;

  // Pink noise audio reference
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const addLog = (m: string) =>
    setLog((prev) => [
      new Date().toLocaleTimeString() + "  " + m,
      ...prev,
    ].slice(0, 40));

  // Bluetooth pairing logic + EEG notifications
  const handlePair = async () => {
    const navAny = navigator as any;

    if (!navAny.bluetooth) {
      addLog(
        "Web Bluetooth not supported. Pair your speaker/headband via macOS Bluetooth settings, then ensure audio output is set to it."
      );
      setPaired(true);
      return;
    }

    try {
      addLog("Requesting Bluetooth device…");

      const device: BluetoothDevice = await navAny.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: [EEG_SERVICE_UUID],
      });

      addLog(`Selected device: ${device.name ?? "Unnamed device"}. Connecting…`);

      const server = await device.gatt?.connect();
      if (!server) {
        addLog("Device has no GATT server.");
        return;
      }

      addLog("Bluetooth GATT connection established.");

      const service = await server.getPrimaryService(EEG_SERVICE_UUID);
      addLog("EEG service obtained.");

      const characteristic = await service.getCharacteristic(EEG_CHAR_UUID);
      addLog("EEG notification characteristic obtained.");

      await characteristic.startNotifications();
      addLog(
        "Subscribed to EEG notifications (16-byte packets → 8× int16 channels)."
      );

      characteristic.addEventListener(
        "characteristicvaluechanged",
        (event: Event) => {
          const target = event.target as BluetoothRemoteGATTCharacteristic;
          const value = target.value;
          if (!value) {
            addLog("EEG notification had no value.");
            return;
          }

          if (value.byteLength < 16) {
            addLog(
              `EEG packet too short: ${value.byteLength} bytes (expected 16).`
            );
            return;
          }

          // Parse all 8 channels (little-endian int16)
          const channels: number[] = [];
          for (let i = 0; i < 8; i++) {
            channels.push(value.getInt16(i * 2, true));
          }

          // Update all 8 channel buffers simultaneously
          setEeg((prev) =>
            prev.map((channelData, chIndex) => {
              const lastT =
                channelData.length > 0
                  ? channelData[channelData.length - 1].t
                  : 0;
              const nextT = lastT + 1;
              return [...channelData.slice(1), { t: nextT, v: channels[chIndex] }];
            })
          );

          // Disable mock once we receive real EEG
          if (mockDemo) {
            setMockDemo(false);
          }

          addLog(`EEG[8ch]: ${channels.join(", ")}`);
        }
      );

      setPaired(true);
      addLog("Device paired and EEG notifications active.");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      addLog("Bluetooth pairing failed or cancelled: " + msg);
    }
  };

  // Calibrate latency
  const handleCalibrate = () => {
    const est = Math.max(
      80,
      100 + Math.round((60 - volume[0]) * 0.6 + Math.random() * 20)
    );
    setLatencyMs(est);
    addLog(`Audio latency calibrated → ${est} ms`);
  };

  // Play pink noise file
  const triggerTestBurst = async () => {
    addLog("Pink-noise test burst requested.");

    if (!audioRef.current) {
      addLog("Pink-noise audio not loaded.");
      return;
    }

    try {
      // Convert slider dB to normalized gain
      const normalized = Math.min(
        1,
        Math.max(0, (volume[0] - 30) / (80 - 30))
      );
      audioRef.current.volume = normalized;

      audioRef.current.currentTime = 0;
      await audioRef.current.play();
      addLog(
        "Pink-noise playback started (macOS will route audio to BT speaker)."
      );
    } catch (err) {
      addLog("Audio playback failed: " + (err as Error).message);
      return;
    }

    setTimeout(
      () => addLog("Pink-noise playback ACK (Δt=" + latencyMs + " ms)."),
      latencyMs
    );
  };

  const impedances = useMemo(
    () =>
      Array.from({ length: 8 }, () => 15 + Math.random() * 80),
    [
      eegForDisplay[0][
        eegForDisplay[0].length - 1
      ]?.t,
    ]
  );

  return (
    <TooltipProvider>
      <div className="min-h-screen w-full bg-slate-50 text-slate-900 p-6">
        {/* Pink-noise audio file from public/pink-noise.mp3 */}
        <audio
          ref={audioRef}
          src="/pink-noise.mp3"
          preload="auto"
          style={{ display: "none" }}
        />

        <header className="mb-6 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Brain className="h-8 w-8" />
            <h1 className="text-2xl font-semibold">Sound Asleep</h1>
            <Badge className="ml-2">Closed-loop SWS</Badge>
          </div>
          <div className="flex items-center gap-3">
            <Battery className="h-5 w-5" />
            <Progress value={battery} className="w-28" />
            <span className="text-sm font-medium">{battery}%</span>
          </div>
        </header>

        <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
          <Card className="xl:col-span-1">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Bluetooth className="h-5 w-5" />
                Device & Session
              </CardTitle>
              <CardDescription>
                Pair headband, pick algorithm, and control the session.
              </CardDescription>
            </CardHeader>

            <CardContent className="space-y-4">
              {/* Pairing Box */}
              <div className="flex items-center justify-between rounded-2xl border p-3">
                <div>
                  <div className="font-medium">EEG Headband</div>
                  <div className="text-xs text-slate-500">
                    Status: {paired ? "Connected" : "Not connected"}
                  </div>
                </div>

                {paired ? (
                  <Badge className="bg-emerald-600">Connected</Badge>
                ) : (
                  <Button onClick={handlePair}>
                    <Bluetooth className="mr-2 h-4 w-4" />
                    Pair
                  </Button>
                )}
              </div>

              {/* Algorithm & Mock Mode */}
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-2xl border p-3">
                  <div className="mb-1 text-xs text-slate-500">Algorithm</div>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="outline"
                        className="w-full justify-between"
                      >
                        {algorithm}
                        <Settings className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>

                    <DropdownMenuContent className="w-48">
                      <DropdownMenuLabel>Choose</DropdownMenuLabel>
                      <DropdownMenuSeparator />
                      <DropdownMenuCheckboxItem
                        checked={algorithm === "YASA"}
                        onCheckedChange={() => setAlgorithm("YASA")}
                      >
                        YASA (staging + SW)
                      </DropdownMenuCheckboxItem>

                      <DropdownMenuCheckboxItem
                        checked={algorithm === "CoSleep"}
                        onCheckedChange={() => setAlgorithm("CoSleep")}
                      >
                        CoSleep (closed-loop)
                      </DropdownMenuCheckboxItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>

                <div className="rounded-2xl border p-3">
                  <div className="mb-1 text-xs text-slate-500">
                    Mock Demo Mode
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm">Use prerecorded data</span>
                    <Switch
                      checked={mockDemo}
                      onCheckedChange={setMockDemo}
                    />
                  </div>
                </div>
              </div>

              {/* Stimulation Controls */}
              <div className="rounded-2xl border p-3 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-medium flex items-center gap-2">
                    <Headphones className="h-4 w-4" />
                    Stimulation
                  </div>
                  <Switch
                    checked={stimulationOn}
                    onCheckedChange={setStimulationOn}
                  />
                </div>

                <div>
                  <div className="mb-1 text-xs text-slate-500">
                    Volume (target 55 dB)
                  </div>
                  <Slider
                    value={volume}
                    onValueChange={setVolume}
                    min={30}
                    max={80}
                    step={1}
                  />
                  <div className="text-xs text-slate-500 mt-1">
                    {volume[0]} dB
                  </div>
                </div>

                <div>
                  <div className="mb-1 text-xs text-slate-500">
                    Slow-wave threshold
                  </div>
                  <Slider
                    value={threshold}
                    onValueChange={setThreshold}
                    min={40}
                    max={90}
                    step={1}
                  />
                  <div className="text-xs text-slate-500 mt-1">
                    z-score ≥ {threshold[0]}
                  </div>
                </div>

                <div className="flex gap-2">
                  <Button onClick={triggerTestBurst} className="flex-1">
                    <Play className="mr-2 h-4 w-4" />
                    Pink-noise test
                  </Button>

                  <Button
                    variant="outline"
                    onClick={handleCalibrate}
                    className="flex-1"
                  >
                    <Timer className="mr-2 h-4 w-4" />
                    Calibrate latency
                  </Button>
                </div>

                <div className="text-xs text-slate-600">
                  Latency estimate:{" "}
                  <span className="font-medium">{latencyMs} ms</span>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Live EEG – 8 channels, vertical stack */}
          <Card className="xl:col-span-2">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Activity className="h-5 w-5" />
                Live EEG (8 channels)
              </CardTitle>
              <CardDescription>
                16-byte notifications: 8× int16 channels, streamed via BLE.
              </CardDescription>
            </CardHeader>

            <CardContent>
              <div className="space-y-3">
                {eegForDisplay.map((channelData, idx) => (
                  <div key={idx}>
                    <div className="text-xs mb-1 font-medium text-slate-600">
                      Channel {idx + 1}
                    </div>
                    <div className="h-24 w-full rounded-2xl border p-2 bg-white">
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart
                          data={channelData}
                          margin={{
                            left: 12,
                            right: 12,
                            top: 4,
                            bottom: 2,
                          }}
                        >
                          <XAxis dataKey="t" hide />
                          <YAxis domain={[-2000, 2000]} hide />
                          <Line
                            type="monotone"
                            dataKey="v"
                            dot={false}
                            strokeWidth={1}
                            isAnimationActive={false}
                          />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                ))}
              </div>

              <div className="mt-4 grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-2">
                {impedances.map((z, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between rounded-xl border p-2"
                  >
                    <span className="text-xs font-medium">Ch{i + 1}</span>
                    <ImpedanceBadge value={z} />
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Staging / Events */}
        <div className="mt-4 grid grid-cols-1 lg:grid-cols-3 gap-4">
          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Waves className="h-5 w-5" />
                Sleep Staging & Events
              </CardTitle>
              <CardDescription>Summary of last 10 minutes.</CardDescription>
            </CardHeader>

            <CardContent>
              <div className="grid grid-cols-3 gap-3">
                <div className="rounded-2xl border p-3">
                  <div className="text-xs text-slate-500">
                    Detected slow-waves
                  </div>
                  <div className="text-2xl font-semibold">
                    {Math.floor(threshold[0] / 10 + (stimulationOn ? 5 : 3))}
                  </div>
                </div>

                <div className="rounded-2xl border p-3">
                  <div className="text-xs text-slate-500">
                    Stim bursts issued
                  </div>
                  <div className="text-2xl font-semibold">
                    {stimulationOn ? 6 : 0}
                  </div>
                </div>

                <div className="rounded-2xl border p-3">
                  <div className="text-xs text-slate-500">Avg phase error</div>
                  <div className="text-2xl font-semibold">
                    {Math.max(0, latencyMs - 100)} ms
                  </div>
                </div>
              </div>

              <div className="mt-4 rounded-2xl border p-3 text-sm text-slate-600">
                Notes: Stimulation auto-pauses on arousals. BLE dropouts up to
                200 ms tolerated.
              </div>
            </CardContent>
          </Card>

          {/* Event Log */}
          <Card>
            <CardHeader>
              <CardTitle>Event Log</CardTitle>
              <CardDescription>Most recent first.</CardDescription>
            </CardHeader>

            <CardContent>
              <div className="h-64 overflow-auto rounded-2xl border bg-white p-3 text-xs">
                <ul className="space-y-2">
                  {log.map((m, i) => (
                    <li key={i} className="whitespace-pre-wrap">
                      {m}
                    </li>
                  ))}
                </ul>
              </div>
            </CardContent>
          </Card>
        </div>

        <footer className="mt-6 text-center text-xs text-slate-500">
          UI prototype for ECE 445 – Sound Asleep. React.
        </footer>
      </div>
    </TooltipProvider>
  );
}
