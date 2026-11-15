/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./public/**/*.{html,js}"  // Simplified: already covers all subdirectories
  ],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        // B612 was drawn for cockpit displays; it carries every readout. Plex Sans carries prose and controls.
        display: ['B612', '"IBM Plex Sans"', 'system-ui', 'sans-serif'],
        mono: ['"B612 Mono"', 'ui-monospace', 'Menlo', 'monospace'],
        sans: ['"IBM Plex Sans"', 'system-ui', '-apple-system', 'sans-serif']
      },
      colors: {
        // Near-black panel surfaces, darkest first. Token names are referenced from markup and JS; keep them.
        space: {
          950: '#0b0c0d',
          900: '#111214',
          850: '#16181a',
          800: '#1c1e21',
          700: '#27292d',
          border: '#27292d'
        },
        // Glass-cockpit colour code. Each hue means one thing:
        //   purple (legacy name) -> cyan: things you set (buttons, toggles, inputs, focus)
        //   magenta: the one current thing (active nav)
        //   green / yellow / red: normal / caution / warning
        neon: {
          purple: '#4cc9d6',
          cyan: '#4cc9d6',
          magenta: '#d45bc2',
          green: '#6fcf6a',
          yellow: '#f2a93b',
          red: '#ee5a4f'
        },
        // Model families: tints that never collide with a status colour
        family: {
          claude: '#4cc9d6',
          gemini: '#d9c39a',
          other: '#9aa7b0'
        },
        white: '#eceae4',
        // Neutral greys with a faint warmth, matched to the panel and its off-white lettering
        gray: {
          50: '#f6f5f1',
          100: '#eceae4',
          200: '#dcdad4',
          300: '#c4c2bc',
          400: '#a3a19c',
          500: '#87857f',
          600: '#6a6964',
          700: '#4d4d4a',
          800: '#1f2124',
          900: '#111214',
          950: '#0b0c0d'
        },
        // Stock hues still referenced in markup, pulled onto the cockpit code.
        // `extend` deep-merges, so unlisted shades keep Tailwind's defaults.
        red: { 300: '#f7a59e', 400: '#f27e74', 500: '#ee5a4f', 600: '#d4463c', 800: '#6e2a25', 900: '#45201d' },
        yellow: { 400: '#f6c06a', 500: '#f2a93b', 600: '#cf8c26' },
        amber: { 100: '#fcebcc', 200: '#f9d99d', 300: '#f6c06a', 400: '#f4b552', 500: '#f2a93b' },
        green: { 400: '#93dc8f', 500: '#6fcf6a' },
        emerald: { 400: '#93dc8f', 500: '#6fcf6a' },
        blue: { 400: '#7fdbe4', 500: '#4cc9d6' },
        purple: { 400: '#7fdbe4', 500: '#4cc9d6', 600: '#2fa3b0' },
        cyan: { 400: '#7fdbe4', 500: '#4cc9d6', 600: '#2fa3b0' }
      }
    }
  },
  plugins: [
    require('@tailwindcss/forms'),
    require('daisyui')
  ],
  daisyui: {
    themes: [{
      antigravity: {
        "primary": "#4cc9d6",
        "primary-content": "#0b0c0d",
        "secondary": "#6fcf6a",
        "accent": "#d45bc2",
        "neutral": "#1c1e21",
        "neutral-content": "#c4c2bc",
        "base-100": "#0b0c0d",
        "base-200": "#111214",
        "base-300": "#1c1e21",
        "base-content": "#c4c2bc",
        "info": "#4cc9d6",
        "success": "#6fcf6a",
        "warning": "#f2a93b",
        "error": "#ee5a4f",
        "--rounded-box": "0.625rem",
        "--rounded-btn": "0.375rem",
        "--rounded-badge": "999px",
        "--animation-btn": "0.15s",
        "--btn-focus-scale": "1",
        "--border-btn": "1px",
      }
    }],
    logs: false  // Disable console logs in production
  }
}
