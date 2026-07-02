"use client";
/* QR generator ported from the prototype (byte mode, ECC M, versions 1–6). */
import { useEffect, useRef } from "react";

const EXP = new Array<number>(256), LOG = new Array<number>(256);
(() => { let x = 1; for (let i = 0; i < 256; i++) { EXP[i] = x; if (i < 255) LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; } })();
const mul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : EXP[(LOG[a] + LOG[b]) % 255]);
function genPoly(n: number) { let p = [1]; for (let i = 0; i < n; i++) { const np = new Array(p.length + 1).fill(0); for (let j = 0; j < p.length; j++) { np[j] ^= p[j]; np[j + 1] ^= mul(p[j], EXP[i]); } p = np; } return p; }
function ecc(data: number[], n: number) { const gen = genPoly(n); const res = data.concat(new Array(n).fill(0)); for (let i = 0; i < data.length; i++) { const c = res[i]; if (c !== 0) for (let j = 0; j < gen.length; j++) res[i + j] ^= mul(gen[j], c); } return res.slice(data.length); }
const SPEC: Record<number, [number, number, [number, number][]]> = { 1: [16, 10, [[1, 16]]], 2: [28, 16, [[1, 28]]], 3: [44, 26, [[1, 44]]], 4: [64, 18, [[2, 32]]], 5: [86, 24, [[2, 43]]], 6: [108, 16, [[4, 27]]] };
const ALIGN: Record<number, number[]> = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34] };
function pickVersion(len: number) { for (let v = 1; v <= 6; v++) if (SPEC[v][0] >= len + 2) return v; return 6; }

function encode(text: string) {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) { const cc = text.charCodeAt(i); if (cc < 128) bytes.push(cc); else { const enc = unescape(encodeURIComponent(text[i])); for (let k = 0; k < enc.length; k++) bytes.push(enc.charCodeAt(k)); } }
  const version = pickVersion(bytes.length); const [dataCw, ecCw, blocks] = SPEC[version];
  const bits: number[] = []; const push = (val: number, n: number) => { for (let i = n - 1; i >= 0; i--) bits.push((val >> i) & 1); };
  push(4, 4); push(bytes.length, 8); bytes.forEach((b) => push(b, 8));
  const cap = dataCw * 8; if (bits.length + 4 <= cap) push(0, 4); while (bits.length % 8) bits.push(0);
  const cws: number[] = []; for (let i = 0; i < bits.length; i += 8) { let b = 0; for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j]; cws.push(b); }
  let pad = 0xec; while (cws.length < dataCw) { cws.push(pad); pad = pad === 0xec ? 0x11 : 0xec; }
  const dBlocks: number[][] = [], eBlocks: number[][] = []; let idx = 0;
  blocks.forEach(([cnt, per]) => { for (let b = 0; b < cnt; b++) { const blk = cws.slice(idx, idx + per); idx += per; dBlocks.push(blk); eBlocks.push(ecc(blk, ecCw)); } });
  const maxD = Math.max(...dBlocks.map((b) => b.length)); const finalCw: number[] = [];
  for (let i = 0; i < maxD; i++) dBlocks.forEach((b) => { if (i < b.length) finalCw.push(b[i]); });
  for (let i = 0; i < ecCw; i++) eBlocks.forEach((b) => finalCw.push(b[i]));
  const fbits: number[] = []; finalCw.forEach((b) => { for (let i = 7; i >= 0; i--) fbits.push((b >> i) & 1); });
  return { version, fbits };
}

export function buildQr(text: string): number[][] {
  const { version, fbits } = encode(text); const size = 17 + 4 * version;
  const m: (number | null)[][] = [], res: boolean[][] = [];
  for (let i = 0; i < size; i++) { m.push(new Array(size).fill(null)); res.push(new Array(size).fill(false)); }
  const set = (r: number, c: number, v: boolean | number) => { m[r][c] = v ? 1 : 0; res[r][c] = true; };
  const finder = (r: number, c: number) => { for (let i = -1; i <= 7; i++) for (let j = -1; j <= 7; j++) { const rr = r + i, cc = c + j; if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue; const inR = (i >= 0 && i <= 6 && (j === 0 || j === 6)) || (j >= 0 && j <= 6 && (i === 0 || i === 6)) || (i >= 2 && i <= 4 && j >= 2 && j <= 4); set(rr, cc, inR); } };
  finder(0, 0); finder(0, size - 7); finder(size - 7, 0);
  for (let i = 8; i < size - 8; i++) { if (m[6][i] === null) set(6, i, i % 2 === 0); if (m[i][6] === null) set(i, 6, i % 2 === 0); }
  const ap = ALIGN[version];
  for (let a = 0; a < ap.length; a++) for (let b = 0; b < ap.length; b++) { const r = ap[a], c = ap[b]; if (m[r][c] !== null) continue; for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) { const on = Math.abs(i) === 2 || Math.abs(j) === 2 || (i === 0 && j === 0); set(r + i, c + j, on); } }
  set(size - 8, 8, 1);
  for (let i = 0; i <= 8; i++) { if (m[8][i] === null) res[8][i] = true; if (m[i][8] === null) res[i][8] = true; }
  for (let i = 0; i < 7; i++) if (m[8][size - 1 - i] === null) res[8][size - 1 - i] = true;
  for (let i = 0; i < 8; i++) if (m[size - 1 - i][8] === null) res[size - 1 - i][8] = true;
  let di = 0, up = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let t = 0; t < size; t++) { const row = up ? size - 1 - t : t; for (let c = 0; c < 2; c++) { const cc = col - c; if (res[row][cc]) continue; const bit = di < fbits.length ? fbits[di] : 0; di++; m[row][cc] = bit; res[row][cc] = true; } }
    up = !up;
  }
  const maskFn = (k: number, r: number, c: number) => { switch (k) { case 0: return (r + c) % 2 === 0; case 1: return r % 2 === 0; case 2: return c % 3 === 0; case 3: return (r + c) % 3 === 0; case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0; case 5: return ((r * c) % 2) + ((r * c) % 3) === 0; case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0; default: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0; } };
  const fixed: boolean[][] = []; for (let r = 0; r < size; r++) { fixed.push([]); for (let c = 0; c < size; c++) fixed[r].push(false); }
  const finderMark = (r: number, c: number) => { for (let i = -1; i <= 7; i++) for (let j = -1; j <= 7; j++) { const rr = r + i, cc = c + j; if (rr >= 0 && cc >= 0 && rr < size && cc < size) fixed[rr][cc] = true; } };
  finderMark(0, 0); finderMark(0, size - 7); finderMark(size - 7, 0);
  for (let i = 0; i < size; i++) { fixed[6][i] = true; fixed[i][6] = true; }
  for (let a = 0; a < ap.length; a++) for (let b = 0; b < ap.length; b++) { const r = ap[a], c = ap[b]; for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) if (r + i >= 0 && c + j >= 0 && r + i < size && c + j < size) fixed[r + i][c + j] = true; }
  fixed[size - 8][8] = true;
  for (let i = 0; i <= 8; i++) { fixed[8][i] = true; fixed[i][8] = true; }
  for (let i = 0; i < 7; i++) fixed[8][size - 1 - i] = true;
  for (let i = 0; i < 8; i++) fixed[size - 1 - i][8] = true;
  const applyMask = (k: number) => { const g: number[][] = []; for (let r = 0; r < size; r++) { g.push([]); for (let c = 0; c < size; c++) { let v = (m[r][c] || 0) as number; if (!fixed[r][c] && maskFn(k, r, c)) v ^= 1; g[r].push(v); } } return g; };
  const penalty = (g: number[][]) => {
    let p = 0;
    for (let r = 0; r < size; r++) { let run = 1; for (let c = 1; c < size; c++) { if (g[r][c] === g[r][c - 1]) { run++; if (run === 5) p += 3; else if (run > 5) p++; } else run = 1; } }
    for (let c = 0; c < size; c++) { let run = 1; for (let r = 1; r < size; r++) { if (g[r][c] === g[r - 1][c]) { run++; if (run === 5) p += 3; else if (run > 5) p++; } else run = 1; } }
    for (let r = 0; r < size - 1; r++) for (let c = 0; c < size - 1; c++) if (g[r][c] === g[r][c + 1] && g[r][c] === g[r + 1][c] && g[r][c] === g[r + 1][c + 1]) p += 3;
    let dark = 0; g.forEach((row) => row.forEach((v) => { if (v) dark++; }));
    p += Math.floor(Math.abs((dark / (size * size)) * 100 - 50) / 5) * 10;
    return p;
  };
  let best = 0, bestP = Infinity, bestG: number[][] = [];
  for (let k = 0; k < 8; k++) { const g = applyMask(k); const p = penalty(g); if (p < bestP) { bestP = p; best = k; bestG = g; } }
  const fmtData = (0b00 << 3) | best;
  let rem = fmtData; for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >> 9) & 1 ? 0x537 : 0);
  const fmt = ((fmtData << 10) | rem) ^ 0x5412;
  const fb: number[] = []; for (let i = 0; i < 15; i++) fb.push((fmt >> i) & 1);
  for (let i = 0; i <= 5; i++) bestG[8][i] = fb[i];
  bestG[8][7] = fb[6]; bestG[8][8] = fb[7]; bestG[7][8] = fb[8];
  for (let i = 9; i < 15; i++) bestG[14 - i][8] = fb[i];
  for (let i = 0; i < 8; i++) bestG[size - 1 - i][8] = fb[i];
  for (let i = 8; i < 15; i++) bestG[8][size - 15 + i] = fb[i];
  bestG[size - 8][8] = 1;
  return bestG;
}

export function Qr({ text, size = 120, dark = "#12211c", light = "#fff" }: { text: string; size?: number; dark?: string; light?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current; if (!cv) return;
    const g = buildQr(text); const n = g.length; const quiet = 2; const scale = Math.max(2, Math.floor(size / (n + quiet * 2)));
    const dim = (n + quiet * 2) * scale;
    cv.width = dim; cv.height = dim;
    const cx = cv.getContext("2d")!;
    cx.fillStyle = light; cx.fillRect(0, 0, dim, dim);
    cx.fillStyle = dark;
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (g[r][c]) cx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
  }, [text, size, dark, light]);
  return <canvas ref={ref} style={{ width: size, height: size, borderRadius: 8 }} />;
}
