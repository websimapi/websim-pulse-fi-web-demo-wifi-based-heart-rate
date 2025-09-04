import Chart from "chart.js/auto";
import { Biquad, detrend, estimateHR, normalize } from "./dsp.js";

/* ...existing code... */
const el = id => document.getElementById(id);
const serialBtn = el("serialBtn");
/* add BLE button */ const bleBtn = el("bleBtn");
const fileInput = el("fileInput");
const demoBtn = el("demoBtn");
const bpmEl = el("bpm"), confEl = el("conf"), winEl = el("win");
const fsInput = el("fs"), winRange = el("winSec"), hrMinEl = el("hrMin"), hrMaxEl = el("hrMax");

let fs = Number(fsInput.value);
let rawBuf = [];
let filtBuf = [];
let running = false;
let serialPort, reader;
/* BLE state */ let bleDevice=null, bleChar=null, bleLine="";

const MAX_PLOT_S = 30;
const maxPlotN = () => Math.floor(MAX_PLOT_S * fs);

const signalChart = new Chart(el("signalChart").getContext("2d"), {
  type: "line",
  data: { labels: [], datasets: [{ data: [], borderColor: "#111", pointRadius: 0, tension: .1 }] },
  options: baseChartOpts()
});
const filteredChart = new Chart(el("filteredChart").getContext("2d"), {
  type: "line",
  data: { labels: [], datasets: [{ data: [], borderColor: "#555", pointRadius: 0, tension: .1 }] },
  options: baseChartOpts()
});

function baseChartOpts(){
  return {
    responsive: true,
    animation: { duration: 0 },
    scales: { x: { display:false }, y: { ticks:{ color:"#6a6a6a" }, grid:{ color:"#eee" } } },
    plugins: { legend: { display: false } }
  };
}

function updateCharts() {
  const N = Math.min(rawBuf.length, maxPlotN());
  const labels = Array.from({length:N}, (_,i)=>i);
  signalChart.data.labels = labels;
  signalChart.data.datasets[0].data = rawBuf.slice(-N);
  signalChart.update("none");
  filteredChart.data.labels = labels;
  filteredChart.data.datasets[0].data = filtBuf.slice(-N);
  filteredChart.update("none");
}

function processAndEstimate() {
  const winSec = Number(winRange.value);
  winEl.textContent = winSec;
  if (filtBuf.length < winSec * fs) return;
  const segment = filtBuf.slice(-Math.floor(winSec * fs));
  const [bpm, conf] = estimateHR(segment, fs, Number(hrMinEl.value), Number(hrMaxEl.value));
  bpmEl.textContent = isFinite(bpm) ? Math.round(bpm) : "—";
  confEl.textContent = isFinite(conf) ? conf.toFixed(2) : "—";
}

function pushSamples(samples) {
  rawBuf.push(...samples);
  if (rawBuf.length > maxPlotN()*2) rawBuf.splice(0, rawBuf.length - maxPlotN()*2);

  // filtering pipeline
  const x = normalize(detrend(samples));
  bp.updateCoeffs("bandpass", { fs, f0: 1.85, Q: 0.707, gain: 0 }); // center ~1.85 Hz midband
  const y = x.map(s => bp.process(s));
  filtBuf.push(...y);
  if (filtBuf.length > maxPlotN()*2) filtBuf.splice(0, filtBuf.length - maxPlotN()*2);

  updateCharts();
  processAndEstimate();
}

const bp = new Biquad("bandpass", { fs, f0: 1.85, Q: 0.707, gain: 0 });

fsInput.addEventListener("change", () => {
  fs = Number(fsInput.value);
});

winRange.addEventListener("input", () => {
  winEl.textContent = winRange.value;
  processAndEstimate();
});

serialBtn.addEventListener("click", async () => {
  try {
    if (!("serial" in navigator)) {
      alert("WebSerial not supported on this device/browser.");
      return;
    }
    serialPort = await navigator.serial.requestPort();
    await serialPort.open({ baudRate: 115200 });
    const decoder = new TextDecoderStream();
    const readableClosed = serialPort.readable.pipeTo(decoder.writable);
    reader = decoder.readable.getReader();
    running = true;
    readSerialLoop();
  } catch (e) {
    console.error(e);
    alert("Serial connection failed.");
  }
});

bleBtn.addEventListener("click", async () => {
  try { bleBtn.disabled = true; await connectBLE(); } catch(e){ console.error(e); alert("Bluetooth connection failed."); } finally { bleBtn.disabled = false; }
});

async function readSerialLoop() {
  let line = "";
  while (running && reader) {
    const { value, done } = await reader.read();
    if (done) break;
    line += value;
    const parts = line.split(/\r?\n/);
    line = parts.pop() || "";
    for (const p of parts) {
      const s = parseSampleLine(p);
      if (s) pushSamples(s);
    }
  }
}

function parseSampleLine(p) {
  // Accept JSON lines: {"fs":100,"m":[...]}
  // or CSV numbers per line, or single float per line
  try {
    if (p.trim().startsWith("{")) {
      const obj = JSON.parse(p);
      if (obj.fs) { fs = Number(obj.fs); fsInput.value = fs; }
      if (Array.isArray(obj.m)) return obj.m.map(Number);
    } else if (p.includes(",")) {
      return p.split(",").map(Number).filter(n=>isFinite(n));
    } else {
      const v = Number(p.trim());
      if (isFinite(v)) return [v];
    }
  } catch {}
  return null;
}

fileInput.addEventListener("change", async (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  const text = await f.text();
  const obj = JSON.parse(text);
  if (obj.fs) { fs = Number(obj.fs); fsInput.value = fs; }
  rawBuf = []; filtBuf = [];
  pushSamples(obj.data || obj.m || []);
});

demoBtn.addEventListener("click", async () => {
  const resp = await fetch("./testdata.json");
  const obj = await resp.json();
  if (obj.fs) { fs = Number(obj.fs); fsInput.value = fs; }
  rawBuf = []; filtBuf = [];
  // Stream in chunks to simulate live
  const chunk = 50;
  for (let i=0; i<obj.data.length; i+=chunk) {
    pushSamples(obj.data.slice(i, i+chunk));
    await sleep(50); // ~simulate 100 Hz
  }
});

async function connectBLE(){
  if (!navigator.bluetooth) { alert("Web Bluetooth not supported on this device/browser."); return; }
  const NUS_SERVICE = "6e400001-b5a3-f393-e0a9-e50e24dcca9e", NUS_CHAR_TX = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";
  try {
    if (bleDevice?.gatt?.connected) bleDevice.gatt.disconnect();
    bleDevice = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: [NUS_SERVICE] });
    const server = await bleDevice.gatt.connect();
    bleDevice.addEventListener("gattserverdisconnected", () => { console.warn("BLE disconnected"); });
    const service = await server.getPrimaryService(NUS_SERVICE);
    bleChar = await service.getCharacteristic(NUS_CHAR_TX);
    await bleChar.startNotifications();
    bleChar.addEventListener("characteristicvaluechanged", onBleNotify);
  } catch (e) { throw e; }
}

function onBleNotify(ev){
  const v = ev.target.value;
  const text = new TextDecoder().decode(v);
  bleLine += text;
  const parts = bleLine.split(/\r?\n/);
  bleLine = parts.pop() || "";
  for (const p of parts) {
    const s = parseSampleLine(p);
    if (s) pushSamples(s);
  }
}

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }