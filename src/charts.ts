// Gráficos em SVG, desenhados a partir das séries. Cores vêm dos tokens CSS (tema claro e escuro).
import type { Interval } from './calc';
import type { MonthSpend } from './indicators';
import { monthShort } from './indicators';

const nf = (n: number, d: number) => n.toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });
const dm = (iso: string) => iso.slice(8, 10) + '/' + iso.slice(5, 7);
const short = (n: number) => (n >= 1000 ? 'R$ ' + nf(n / 1000, 1).replace(',0', '') + ' mil' : 'R$ ' + Math.round(n));
const empty = (msg: string) => '<p class="chart-empty">' + msg + '</p>';

/** Gasto por mês: combustível e manutenção empilhados. */
export function monthBars(data: MonthSpend[]): string {
  if (!data.some((d) => d.fuel + d.maint > 0)) return empty('Nenhum gasto registrado no período.');
  const W = 340, H = 190, top = 22, base = 160;
  const max = Math.max(...data.map((d) => d.fuel + d.maint));
  const slot = W / data.length;
  const bw = Math.min(44, slot * 0.6);
  const y = (v: number) => ((base - top) * v) / max;
  const label = data.map((d) => monthShort(d.key) + (d.partial ? '*' : '')).join(', ');
  let s = '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Gasto por mês: ' + label + '">';
  s += '<line x1="0" x2="' + W + '" y1="' + base + '" y2="' + base + '" class="c-axis"/>';
  data.forEach((d, i) => {
    const cx = slot * i + slot / 2, x = cx - bw / 2;
    const hf = y(d.fuel), hm = y(d.maint);
    if (hf > 0) s += '<rect x="' + x.toFixed(1) + '" y="' + (base - hf).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + hf.toFixed(1) + '" class="c-fuel" rx="' + (hm > 0 ? 0 : 5) + '"/>';
    if (hm > 0) s += '<rect x="' + x.toFixed(1) + '" y="' + (base - hf - hm).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + hm.toFixed(1) + '" class="c-maint" rx="5"/>';
    const tot = d.fuel + d.maint;
    if (tot > 0) s += '<text x="' + cx.toFixed(1) + '" y="' + (base - hf - hm - 6).toFixed(1) + '" text-anchor="middle" class="c-val">' + short(tot) + '</text>';
    s += '<text x="' + cx.toFixed(1) + '" y="' + (base + 18) + '" text-anchor="middle" class="c-lbl">' + monthShort(d.key) + (d.partial ? '*' : '') + '</text>';
  });
  return s + '</svg>';
}

/** Preço pago por litro em cada abastecimento, com a média tracejada. */
export function priceLine(pts: { date: string; price: number; fuel: string }[]): string {
  if (pts.length < 2) return empty('São necessários 2 abastecimentos no período.');
  const W = 340, H = 170, pl = 12, pr = 12, top = 26, base = 136;
  const vs = pts.map((p) => p.price);
  let mn = Math.min(...vs), mx = Math.max(...vs);
  const pad = (mx - mn) * 0.2 || 0.1;
  mn -= pad;
  mx += pad;
  const x = (i: number) => pl + ((W - pl - pr) * i) / (pts.length - 1);
  const y = (v: number) => top + ((base - top) * (mx - v)) / (mx - mn);
  const avg = vs.reduce((a, b) => a + b, 0) / vs.length;
  const iMin = vs.indexOf(Math.min(...vs));
  let s = '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Preço por litro em ' + pts.length + ' abastecimentos, de R$ ' + nf(vs[0], 2) + ' a R$ ' + nf(vs[vs.length - 1], 2) + '">';
  s += '<line x1="' + pl + '" x2="' + (W - pr) + '" y1="' + y(avg).toFixed(1) + '" y2="' + y(avg).toFixed(1) + '" class="c-avg"/>';
  s += '<polyline points="' + pts.map((p, i) => x(i).toFixed(1) + ',' + y(p.price).toFixed(1)).join(' ') + '" class="c-line"/>';
  pts.forEach((p, i) => {
    s += '<circle cx="' + x(i).toFixed(1) + '" cy="' + y(p.price).toFixed(1) + '" r="' + (i === pts.length - 1 ? 5 : 3.5) + '" class="' + (p.fuel === 'etanol' ? 'c-dot-eth' : 'c-dot') + '"/>';
  });
  const lab = (i: number, anchor: string, dy: number) =>
    '<text x="' + x(i).toFixed(1) + '" y="' + (y(vs[i]) + dy).toFixed(1) + '" text-anchor="' + anchor + '" class="c-val">' + nf(vs[i], 2) + '</text>';
  s += lab(0, 'start', -10) + lab(pts.length - 1, 'end', -10);
  if (iMin !== 0 && iMin !== pts.length - 1) s += lab(iMin, 'middle', 20);
  const dates = [0, Math.floor((pts.length - 1) / 2), pts.length - 1].filter((v, i, a) => a.indexOf(v) === i);
  dates.forEach((i, k) => {
    const anchor = k === 0 ? 'start' : i === pts.length - 1 ? 'end' : 'middle';
    s += '<text x="' + x(i).toFixed(1) + '" y="' + (H - 4) + '" text-anchor="' + anchor + '" class="c-lbl">' + dm(pts[i].date) + '</text>';
  });
  return s + '</svg>';
}

/** km/l por tanque, com a média do carro. */
export function kmlBars(list: Interval[], avg: number): string {
  if (!list.length) return empty('São necessários 2 tanques cheios no período.');
  const data = list.slice(-12);
  const W = 340, H = 180, top = 22, base = 150;
  const max = Math.max(...data.map((d) => d.kml), avg) * 1.1;
  const slot = W / data.length;
  const bw = Math.min(40, slot * 0.7);
  const y = (v: number) => base - ((base - top) * v) / max;
  let s = '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="km/l por tanque, média ' + nf(avg, 2) + '">';
  s += '<line x1="0" x2="' + W + '" y1="' + base + '" y2="' + base + '" class="c-axis"/>';
  data.forEach((d, i) => {
    const cx = slot * i + slot / 2;
    const cls = d.fuel === 'etanol' ? 'c-bar-eth' : i === data.length - 1 ? 'c-bar-last' : 'c-bar';
    s += '<rect x="' + (cx - bw / 2).toFixed(1) + '" y="' + y(d.kml).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + (base - y(d.kml)).toFixed(1) + '" rx="5" class="' + cls + '"/>';
    s += '<text x="' + cx.toFixed(1) + '" y="' + (y(d.kml) - 6).toFixed(1) + '" text-anchor="middle" class="c-val">' + nf(d.kml, 1) + '</text>';
    if (data.length <= 8 || i % 2 === data.length % 2) s += '<text x="' + cx.toFixed(1) + '" y="' + (base + 18) + '" text-anchor="middle" class="c-lbl">' + dm(d.date) + '</text>';
  });
  s += '<line x1="0" x2="' + W + '" y1="' + y(avg).toFixed(1) + '" y2="' + y(avg).toFixed(1) + '" class="c-avg"/>';
  return s + '</svg>';
}

/** Mini barras do Início: últimos tanques, o mais recente em destaque. */
export function sparkBars(list: Interval[]): string {
  const data = list.slice(-8);
  if (data.length < 2) return '';
  const min = Math.min(...data.map((d) => d.kml)) * 0.8;
  const max = Math.max(...data.map((d) => d.kml));
  return data
    .map((d, i) => '<span class="' + (i === data.length - 1 ? 'on' : '') + '" style="height:' + Math.round(10 + ((d.kml - min) / (max - min || 1)) * 34) + 'px"></span>')
    .join('');
}
