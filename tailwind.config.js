/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./public/**/*.{html,js}"  // Simplified: already covers all subdirectories
  ],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        mono: ['"JetBrains Mono"', '"Fira Code"', 'Consolas', 'monospace'],
        sans: ['Inter', 'system-ui', 'sans-serif']
      },
      colors: {
        space: {
          950: '#09090b',
          900: '#0f0f11',
          850: '#121214',
          800: '#18181b',
          border: '#27272a'
        },
        neon: {
          purple: '#a855f7',
          cyan: '#06b6d4',
          green: '#22c55e',
          yellow: '#eab308',
          red: '#ef4444'
        }
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
        "primary": "#a855f7",    // neon-purple
        "secondary": "#22c55e",  // neon-green
        "accent": "#06b6d4",     // neon-cyan
        "neutral": "#18181b",    // space-800
        "base-100": "#09090b",   // space-950
        "info": "#06b6d4",       // neon-cyan
        "success": "#22c55e",    // neon-green
        "warning": "#eab308",    // neon-yellow
        "error": "#ef4444",      // neon-red
      }
    }],
    logs: false  // Disable console logs in production
  }
}
