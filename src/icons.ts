// Ícones em traço (SVG inline), herdam a cor do texto.
const svg = (d: string, w = 20, sw = 1.8) =>
  '<svg aria-hidden="true" width="' + w + '" height="' + w + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' + sw + '" stroke-linecap="round" stroke-linejoin="round">' + d + '</svg>';

export const ICON = {
  pump: svg('<path d="M4 20V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v15M3 20h12M14 9h2a2 2 0 0 1 2 2v5a1.5 1.5 0 0 0 3 0V8l-3-3M7 7h4"/>'),
  wrench: svg('<path d="M14.7 6.3a4 4 0 0 0-5.4 5.2L4 16.8V20h3.2l5.3-5.3a4 4 0 0 0 5.2-5.4l-2.4 2.4-2.4-.6-.6-2.4z"/>', 18),
  chart: svg('<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>', 20, 2),
  chev: svg('<path d="M9 6l6 6-6 6"/>', 18, 2),
  doc: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>', 18, 2),
  warn: svg('<path d="M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>', 20, 2),
  trendUp: svg('<path d="M3 17l6-6 4 4 8-8M15 7h6v6"/>', 22, 2),
  trendDown: svg('<path d="M3 7l6 6 4-4 8 8M15 17h6v-6"/>', 22, 2),
  check: svg('<path d="M20 6L9 17l-5-5"/>', 20, 2.2),
  lock: '<svg role="img" aria-label="Fixo no início" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
};
