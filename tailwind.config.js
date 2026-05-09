/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  // Class-based dark mode: <html class="dark"> activates dark variants
  // and switches the CSS-variable values defined in src/index.css.
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // AidFlow Pro design tokens — driven by CSS variables.
        //
        // Palette source: colorhunt.co/palette/222831393e4600adb5eeeeee
        //   #222831 — darkest (dark page bg)
        //   #393E46 — dark gray (dark cards)
        //   #00ADB5 — teal (brand accent, same in both modes)
        //   #EEEEEE — light gray (light cards / dark mode text)
        //
        // The slate scale is INVERTED for light mode so existing classes
        // like `text-slate-100` (originally a light-on-dark utility) still
        // produce a sensible colour without needing per-file refactors.
        // Dark-mode values are simply the original Tailwind defaults.
        //
        // Each variable is stored as an "R G B" triplet so Tailwind's
        // `<alpha-value>` placeholder can apply opacity (e.g. `bg-slate-700/40`).
        priority: {
          critical: '#ef4444', // red-500   — score 80-100
          high: '#f97316',     // orange-500 — score 60-79
          medium: '#eab308',   // yellow-500 — score 40-59
          normal: '#22c55e',   // green-500  — score <40
        },
        brand: {
          DEFAULT: 'rgb(var(--brand) / <alpha-value>)',
          dark:    'rgb(var(--brand-dark) / <alpha-value>)',
        },
        accent: {
          DEFAULT: 'rgb(var(--accent) / <alpha-value>)',
        },
        ai: '#8b5cf6',        // violet-500 — Gemma 4 / AI accent (kept distinct)
        warn: '#f59e0b',      // amber-500 — offline banner
        surface: {
          DEFAULT: 'rgb(var(--surface) / <alpha-value>)',
          deep:    'rgb(var(--surface-deep) / <alpha-value>)',
          light:   'rgb(var(--surface-light) / <alpha-value>)',
        },
        slate: {
          100: 'rgb(var(--slate-100) / <alpha-value>)',
          200: 'rgb(var(--slate-200) / <alpha-value>)',
          300: 'rgb(var(--slate-300) / <alpha-value>)',
          400: 'rgb(var(--slate-400) / <alpha-value>)',
          500: 'rgb(var(--slate-500) / <alpha-value>)',
          600: 'rgb(var(--slate-600) / <alpha-value>)',
          700: 'rgb(var(--slate-700) / <alpha-value>)',
          800: 'rgb(var(--slate-800) / <alpha-value>)',
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
