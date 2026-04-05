// tailwind.config.js
/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        display: ['Playfair Display', 'Georgia', 'serif'],
        body:    ['DM Sans', 'system-ui', 'sans-serif'],
        mono:    ['DM Mono', 'Courier New', 'monospace'],
      },
      colors: {
        accent:  '#1a6b4a',
        canvas:  '#f5f3ee',
        card:    '#faf9f6',
        inset:   '#eeecea',
      },
    },
  },
  plugins: [],
};
