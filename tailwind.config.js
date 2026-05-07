/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // AidFlow Pro design tokens.
        //
        // Palette inspired by a dark-teal product launch aesthetic: surfaces
        // are deep, slightly cool near-blacks; the brand accent is a muted
        // teal-cyan that echoes the cyan glow on tech product hero shots.
        // Priority colours stay bright/saturated since they signal urgency
        // and need to remain instantly distinguishable.
        priority: {
          critical: '#ef4444', // red-500   — score 80-100
          high: '#f97316',     // orange-500 — score 60-79
          medium: '#eab308',   // yellow-500 — score 40-59
          normal: '#22c55e',   // green-500  — score <40
        },
        brand: {
          DEFAULT: '#0891b2', // cyan-600 — muted teal-cyan, primary accent
          dark: '#0e7490',    // cyan-700 — hover / pressed
        },
        ai: '#8b5cf6',        // violet-500 — Gemma 4 / AI accent (kept distinct)
        warn: '#f59e0b',      // amber-500 — offline banner
        surface: {
          DEFAULT: '#0f1923', // near-black with a cool teal undertone
          deep: '#070d14',    // page background — almost pure black
          light: '#1a2632',   // hover / raised panels
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        arabic: ['"Noto Sans Arabic"', 'Tahoma', 'sans-serif'],
      },
      minHeight: {
        touch: '44px',
      },
      minWidth: {
        touch: '44px',
      },
    },
  },
  plugins: [],
};
