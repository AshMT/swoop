/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  // Class-based so the theme follows the user's explicit choice, falling back
  // to the OS preference on first visit.
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        /*
         * The Australian magpie: pied black and white, a blue-black sheen on
         * the feathers, and a red-brown eye.
         *
         * `slate` is remapped rather than added to, so every neutral in the
         * app — backgrounds, borders, body text — takes on feather-white and
         * ink-black without touching each page.
         */
        slate: {
          50: '#f8f8f5',
          100: '#f0f0eb',
          200: '#e3e3dc',
          300: '#cacac2',
          400: '#9b9c97',
          500: '#6e706f',
          600: '#51545b',
          700: '#3a3e48',
          800: '#252a34',
          900: '#161a22',
          950: '#0b0d12',
        },
        /* The sheen: the teal-to-blue iridescence on a magpie's wing. */
        swoop: {
          50: '#edfafb',
          100: '#d2f1f4',
          200: '#aae3ea',
          300: '#72cdd9',
          400: '#37aec2',
          500: '#1e91a8',
          600: '#18758f',
          700: '#195f76',
          800: '#1b4f62',
          900: '#1b4253',
          950: '#0c2a37',
        },
        /* The eye — reserved for what needs attention now. */
        eye: {
          50: '#fdf4ef',
          100: '#fae4d8',
          200: '#f3c4ac',
          300: '#e99b77',
          400: '#de7048',
          500: '#c9552e',
          600: '#ad4224',
          700: '#8e3420',
          800: '#732d20',
          900: '#5f281e',
        },
      },
      backgroundImage: {
        sheen: 'linear-gradient(135deg, #14b8a6 0%, #2f6fe0 55%, #7c4ddc 100%)',
        'sheen-soft':
          'linear-gradient(135deg, rgba(20,184,166,.14) 0%, rgba(47,111,224,.12) 55%, rgba(124,77,220,.14) 100%)',
      },
      fontFamily: {
        sans: ['Inter var', 'Inter', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      keyframes: {
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'slide-up': {
          from: { opacity: '0', transform: 'translateY(6px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        /* A new ticket arrives the way a magpie does: down and across, then settles. */
        'swoop-in': {
          '0%': { opacity: '0', transform: 'translate(-14px, -10px) rotate(-1.5deg)' },
          '60%': { opacity: '1', transform: 'translate(2px, 1px) rotate(0.3deg)' },
          '100%': { opacity: '1', transform: 'translate(0, 0) rotate(0)' },
        },
        glide: {
          '0%': { transform: 'translate(-10px, 6px) rotate(-8deg)', opacity: '0' },
          '20%': { opacity: '1' },
          '50%': { transform: 'translate(0, -2px) rotate(0deg)' },
          '80%': { opacity: '1' },
          '100%': { transform: 'translate(10px, 6px) rotate(8deg)', opacity: '0' },
        },
        shimmer: {
          '0%': { backgroundPosition: '0% 50%' },
          '100%': { backgroundPosition: '200% 50%' },
        },
      },
      animation: {
        'fade-in': 'fade-in 150ms ease-out',
        'slide-up': 'slide-up 180ms ease-out',
        'swoop-in': 'swoop-in 420ms cubic-bezier(0.22, 1, 0.36, 1) both',
        glide: 'glide 1.6s ease-in-out infinite',
        shimmer: 'shimmer 3s linear infinite',
      },
    },
  },
  plugins: [],
};
