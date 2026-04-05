// tailwind.config.js
/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        accent:    'var(--accent)',
        surface:   'var(--bg-surface)',
        elevated:  'var(--bg-elevated)',
        border:    'var(--bg-border)',
        'text-primary':   'var(--text-primary)',
        'text-secondary': 'var(--text-secondary)',
        'text-muted':     'var(--text-muted)',
        'status-ok':      'var(--status-ok)',
        'status-warn':    'var(--status-warn)',
        'status-error':   'var(--status-error)',
      },
      fontFamily: {
        ui:   ['IBM Plex Sans', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
      borderRadius: {
        sm: 'var(--radius-sm)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
      },
    },
  },
  plugins: [],
};
