/* ...existing code... */
export function detrend(arr, win = 101) {
  // simple moving average subtraction
  const n = arr.length, out = new Array(n);
  const k = Math.floor(win/2);
  let sum = 0;
  for (let i=0;i<n;i++){
    sum += arr[i];
    if (i>=win) sum -= arr[i-win];
    const denom = i<win ? (i+1) : win;
    const ma = sum / denom;
    out[i] = arr[i] - ma;
  }
  return out;
}

export function normalize(arr) {
  const n = arr.length;
  if (!n) return arr.slice();
  let mean=0; for (const v of arr) mean+=v; mean/=n;
  let sd=0; for (const v of arr) sd+=(v-mean)*(v-mean); sd=Math.sqrt(sd/(n||1))||1;
  return arr.map(v => (v-mean)/sd);
}

export class Biquad {
  constructor(type, {fs, f0, Q = 0.707, gain = 0}) {
    this.type = type; this.fs = fs; this.f0 = f0; this.Q = Q; this.gain = gain;
    this.z1 = 0; this.z2 = 0;
    this.updateCoeffs(type, {fs,f0,Q,gain});
  }
  updateCoeffs(type, {fs, f0, Q = 0.707, gain = 0}) {
    this.type = type; this.fs = fs; this.f0 = f0; this.Q = Q; this.gain = gain;
    const A = Math.pow(10, gain/40);
    const w0 = 2*Math.PI*f0/fs, alpha = Math.sin(w0)/(2*Q), cosw0 = Math.cos(w0);
    let b0,b1,b2,a0,a1,a2;
    if (type === "bandpass") {
      b0 =   alpha; b1 = 0; b2 = -alpha;
      a0 = 1 + alpha; a1 = -2*cosw0; a2 = 1 - alpha;
    } else { // default: peaking as fallback
      b0 = 1; b1 = -2*cosw0; b2 = 1;
      a0 = 1 + alpha/A; a1 = -2*cosw0; a2 = 1 - alpha/A;
    }
    this.b0=b0/a0; this.b1=b1/a0; this.b2=b2/a0; this.a1=a1/a0; this.a2=a2/a0;
  }
  process(x) {
    const y = this.b0*x + this.z1;
    this.z1 = this.b1*x - this.a1*y + this.z2;
    this.z2 = this.b2*x - this.a2*y;
    return y;
  }
}

export function estimateHR(x, fs, hrMin=40, hrMax=180) {
  // autocorrelation in lag range mapped from bpm
  const minLag = Math.floor(fs * 60 / hrMax);
  const maxLag = Math.ceil(fs * 60 / hrMin);
  const n = x.length;
  if (n < maxLag + 1) return [NaN, NaN];

  // normalize
  const xn = normalize(x);
  // autocorr
  const ac = new Array(maxLag+1).fill(0);
  for (let lag=minLag; lag<=maxLag; lag++){
    let s=0;
    for (let i=lag; i<n; i++) s += xn[i]*xn[i-lag];
    ac[lag] = s/(n-lag);
  }
  // find peak
  let peakLag = minLag, peakVal = -Infinity;
  for (let lag=minLag; lag<=maxLag; lag++){
    if (ac[lag] > peakVal){ peakVal = ac[lag]; peakLag = lag; }
  }
  // simple confidence: peak prominence vs neighbors
  const nb = 2;
  let neigh = 0, cnt=0;
  for (let d=1; d<=nb; d++){
    const l = Math.max(minLag, peakLag-d), r = Math.min(maxLag, peakLag+d);
    neigh += (ac[l] + ac[r]) / 2; cnt+=1;
  }
  const base = (neigh/(cnt||1));
  const conf = Math.max(0, Math.min(1, (peakVal - base) / (Math.abs(peakVal)+1e-6)));

  const freq = fs / peakLag; // Hz
  const bpm = freq * 60;
  return [bpm, conf];
}
/* ...existing code... */

