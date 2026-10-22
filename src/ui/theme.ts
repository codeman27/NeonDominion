/** Neon Grid design tokens (ARCHITECTURE.md §9.1). CSS mirrors these as custom properties in main.css. */
export const NEON = {
  bg: '#07010f',
  mag: '#ff2bd6',
  cyan: '#19f6ff',
  sun: '#ffb800',
  lime: '#39ff14',
  txt: '#ece6ff',
  dim: '#9b8cc4',
  /** Index 0 is always the local human. */
  players: ['#19f6ff', '#ff2bd6', '#39ff14', '#ffb800', '#a463ff', '#ff4b4b', '#f4f4ff', '#00ffa3'],
  /** Map-lab continent tints; chosen to stay distinguishable on the dark background. */
  continents: ['#ff2bd6', '#19f6ff', '#ffb800', '#39ff14', '#a463ff', '#ff6b4b', '#e8e8ff'],
  fontDisplay: "'Orbitron', 'Segoe UI', sans-serif",
  fontMono: "'Share Tech Mono', ui-monospace, monospace",
} as const;
