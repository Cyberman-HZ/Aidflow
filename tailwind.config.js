/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // AidFlow Pro design tokens (per PDF Section 12)
        priority: {
          critical: '#ef4444', // red-500   — score 80-100
          high: '#f97316',     // orange-500 — score 60-79
          medium: '#eab308',   // yellow-500 — score 40-59
          normal: '#22c55e',   // green-500  — score <40
        },
        brand: {
          DEFAULT: '#0ea5e9', // sky-500
          dark: '#0369a1',
        },
        ai: '#8b5cf6',        // violet-500 — Gemma 4 / AI accent
        warn: '#f59e0b',      // amber-500 — offline banner
        surface: {
          DEFAULT: '#1e293b', // slate-800
          deep: '#0f172a',    // slate-900
          light: '#334155',   // slate-700
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
