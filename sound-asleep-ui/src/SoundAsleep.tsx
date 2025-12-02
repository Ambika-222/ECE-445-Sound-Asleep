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


function useStreamingData(points = 256, hz = 25) {
  const [data, setData] = useState(() =>
    Array.from({ length: points }, (_, i) => ({ t: i, v: 0 }))
  );

  useEffect(() => {
    const id = setInterval(() => {
      setData((prev) => {
        const nextV =
          Math.sin(prev.length / 8 + Math.random() * 0.2) * 0.7 +
          (Math.random() - 0.5) * 0.2;
        const next = [...prev.slice(1), { t: prev[prev.length - 1].t + 1, v: nextV }];
        return next;
      });
    }, 1000 / hz);

    return () => clearInterval(id);
  }, [hz]);

  return data;
}

function ImpedanceBadge({ value }: { value: number }) {
  const color =
    value < 25 ? "bg-emerald-600" :
    value < 60 ? "bg-amber-500" :
    "bg-rose-600";

  return (
    <Badge variant="secondary" className={`text-white ${color}`}>
      {value.toFixed(0)} kΩ
    </Badge>
  );
}

// BLE UUIDs
const EEG_SERVICE_UUID = "00000000-cc7a-482a-984a-7f2ed5b3e58f";
const EEG_CHAR_UUID    = "00000000-8e22-4541-9d4c-21edae82ed19";

type EegPoint = { t: number; v: number };


export default function SoundAsleepUI() {
  const mockSingle = useStreamingData(256, 28);

  // construct 8 mock channels
  const mockEeg: EegPoint[][] = useMemo(() => {
    return Array.from({ length: 8 }, (_, ch) =>
      mockSingle.map((p, idx) => ({
        t: p.t,
        v: p.v + Math.sin(idx * 0.03 + ch) * 0.15,
      }))
    );
  }, [mockSingle]);

  // real 8x256 EEG buffers
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

  const addLog = (m: string) =>
    setLog((prev) => [
      new Date().toLocaleTimeString() + "  " + m,
      ...prev,
    ].slice(0, 40));

  const audioRef = useRef<HTMLAudioElement | null>(null);

  const eegForDisplay = mockDemo ? mockEeg : eeg;

  const handlePair = async () => {
    const navAny = navigator as any;

    if (!navAny.bluetooth) {
      addLog("Web Bluetooth not supported on this device.");
      setPaired(true);
      return;
    }

    try {
      addLog("Requesting BLE EEG device…");

      const device = await navAny.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: [EEG_SERVICE_UUID],
      });

      addLog(`Selected device: ${device.name ?? "Unnamed device"}`);

      const server = await device.gatt?.connect();
      addLog("GATT connected.");

      const service = await server.getPrimaryService(EEG_SERVICE_UUID);
      addLog("EEG service acquired.");

      const characteristic = await service.getCharacteristic(EEG_CHAR_UUID);
      addLog("EEG characteristic acquired.");

      await characteristic.startNotifications();
      addLog("Subscribed to EEG notifications (8× int16).");

      characteristic.addEventListener("characteristicvaluechanged", (event) => {
        const value = (event.target as any).value as DataView;

        if (value.byteLength < 16) {
          addLog(`Invalid packet (${value.byteLength} bytes).`);
          return;
        }

        const channels: number[] = [];

        // decode 8 channels → scale by /100 for float
        for (let i = 0; i < 8; i++) {
          const raw = value.getInt16(i * 2, true);
          channels.push(raw / 100.0);
        }

        // push into rolling buffers
        setEeg((prev) =>
          prev.map((chBuf, chIdx) => {
            const nextT = chBuf[chBuf.length - 1].t + 1;
            return [...chBuf.slice(1), { t: nextT, v: channels[chIdx] }];
          })
        );

        if (mockDemo) setMockDemo(false);

        addLog(`EEG: ${channels.map((x) => x.toFixed(2)).join(", ")}`);
      });

      setPaired(true);
      addLog("Device paired + streaming.");

    } catch (err) {
      addLog("Pair failed: " + (err as Error).message);
    }
  };


  const handleCalibrate = () => {
    const estimate =
      80 +
      Math.round((60 - volume[0]) * 0.6 + Math.random() * 30);

    setLatencyMs(estimate);
    addLog(`Latency calibrated → ${estimate} ms`);
  };

  const triggerTestBurst = async () => {
    addLog("Playing pink noise test…");

    if (!audioRef.current) {
      addLog("Audio not loaded.");
      return;
    }

    try {
      const normalized = Math.min(
        1,
        Math.max(0, (volume[0] - 30) / 50)
      );

      audioRef.current.volume = normalized;

      audioRef.current.currentTime = 0;
      await audioRef.current.play();

      addLog("Pink noise triggered.");

    } catch (err) {
      addLog("Playback error: " + (err as Error).message);
    }
  };


  const impedances = useMemo(
    () =>
      Array.from({ length: 8 }, () => 15 + Math.random() * 80),
    [eegForDisplay[0][eegForDisplay[0].length - 1]?.t]
  );


  return (
    <TooltipProvider>
      <div className="min-h-screen w-full bg-slate-50 text-slate-900 p-6">
        {/* Hidden audio */}
        <audio
          ref={audioRef}
          src="/pink-noise.mp3"
          preload="auto"
          style={{ display: "none" }}
        />

        {/* HEADER */}
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

        {/* MAIN GRID */}
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">

          {/* LEFT COLUMN */}
          <Card className="xl:col-span-1">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Bluetooth className="h-5 w-5" /> Device & Session
              </CardTitle>
              <CardDescription>
                Pair your EEG headband and control the session.
              </CardDescription>
            </CardHeader>

            <CardContent className="space-y-4">

              {/* Pairing */}
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
                    <Bluetooth className="mr-2 h-4 w-4" /> Pair
                  </Button>
                )}
              </div>

              {/* Algorithm / Mock Mode */}
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-2xl border p-3">
                  <div className="mb-1 text-xs text-slate-500">Algorithm</div>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" className="w-full justify-between">
                        {algorithm}
                        <Settings className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>

                    <DropdownMenuContent>
                      <DropdownMenuLabel>Select</DropdownMenuLabel>
                      <DropdownMenuSeparator />
                      <DropdownMenuCheckboxItem
                        checked={algorithm === "YASA"}
                        onCheckedChange={() => setAlgorithm("YASA")}
                      >
                        YASA
                      </DropdownMenuCheckboxItem>
                      <DropdownMenuCheckboxItem
                        checked={algorithm === "CoSleep"}
                        onCheckedChange={() => setAlgorithm("CoSleep")}
                      >
                        CoSleep
                      </DropdownMenuCheckboxItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>

                <div className="rounded-2xl border p-3">
                  <div className="mb-1 text-xs text-slate-500">Mock Demo</div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm">Use prerecorded</span>
                    <Switch checked={mockDemo} onCheckedChange={setMockDemo} />
                  </div>
                </div>
              </div>

              {/* Stimulation */}
              <div className="rounded-2xl border p-3 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-medium flex items-center gap-2">
                    <Headphones className="h-4 w-4" /> Stimulation
                  </div>
                  <Switch
                    checked={stimulationOn}
                    onCheckedChange={setStimulationOn}
                  />
                </div>

                {/* Volume */}
                <div>
                  <div className="text-xs mb-1 text-slate-500">
                    Volume (target 55 dB)
                  </div>
                  <Slider
                    value={volume}
                    onValueChange={setVolume}
                    min={30}
                    max={80}
                    step={1}
                  />
                  <div className="text-xs mt-1 text-slate-500">
                    {volume[0]} dB
                  </div>
                </div>

                {/* Threshold */}
                <div>
                  <div className="text-xs mb-1 text-slate-500">
                    Slow-wave threshold
                  </div>
                  <Slider
                    value={threshold}
                    onValueChange={setThreshold}
                    min={40}
                    max={90}
                    step={1}
                  />
                  <div className="text-xs mt-1 text-slate-500">
                    z-score ≥ {threshold[0]}
                  </div>
                </div>

                <div className="flex gap-2">
                  <Button onClick={triggerTestBurst} className="flex-1">
                    <Play className="mr-2 h-4 w-4" /> Pink-noise test
                  </Button>
                  <Button variant="outline" onClick={handleCalibrate} className="flex-1">
                    <Timer className="mr-2 h-4 w-4" /> Calibrate
                  </Button>
                </div>

                <div className="text-xs text-slate-600">
                  Latency estimate:
                  <span className="font-medium"> {latencyMs} ms</span>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* RIGHT COLUMN — 8 stacked EEG channels */}
          {/* Live EEG – 8 channels, vertical stack */}
<Card className="xl:col-span-2">
  <CardHeader>
    <CardTitle className="flex items-center gap-2">
      <Activity className="h-5 w-5" />
      Live EEG (8 channels)
    </CardTitle>
    <CardDescription>
      Visualizing streamed EEG packets (8 × int16 scaled ÷100)
    </CardDescription>
  </CardHeader>

  <CardContent>
    <div className="flex flex-col gap-4">
      {eegForDisplay.map((channelData, idx) => (
        <div key={idx} className="w-full">
          <div className="text-xs mb-1 text-slate-600 font-medium">
            Channel {idx + 1}
          </div>

          <div className="w-full" style={{ height: "90px" }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={channelData}>
                <XAxis dataKey="t" hide />
                <YAxis
                  domain={["auto", "auto"]}   // <–– ensures visibility even if flat/constant
                  width={30}
                />
                <Line
                  type="monotone"
                  dataKey="v"
                  stroke="#2563eb"
                  strokeWidth={1.5}
                  dot={false}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      ))}
    </div>
  </CardContent>
</Card>

        </div>

        {/* Event Log */}
        <div className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Event Log</CardTitle>
              <CardDescription>Most recent first.</CardDescription>
            </CardHeader>

            <CardContent>
              <div className="h-64 overflow-auto bg-white border rounded-2xl p-3 text-xs">
                <ul className="space-y-2">
                  {log.map((entry, idx) => (
                    <li key={idx}>{entry}</li>
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
