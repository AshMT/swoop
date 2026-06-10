/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        paper: '#FAF7F1',
        ink: '#0E0E0E',
        // Monochrome ink accent — keeps existing bg-swoop-* / ring-swoop-* usage working
        swoop: {
          50: '#f6f5f1',
          100: '#eae8e2',
          500: '#3a3a3a',
          600: '#161616',
          700: '#000000',
          900: '#0a0a0a',
        },
      },
      boxShadow: {
        // Die-cut sticker: white cut margin ring + hairline cut edge + lift shadow
        sticker:
          '0 0 0 3px #ffffff, 0 0 0 4px rgba(14,14,14,0.10), 0 10px 24px -8px rgba(14,14,14,0.22)',
        'sticker-sm':
          '0 0 0 2px #ffffff, 0 0 0 3px rgba(14,14,14,0.10), 0 4px 12px -4px rgba(14,14,14,0.20)',
      },
    },
  },
  plugins: [],
};
