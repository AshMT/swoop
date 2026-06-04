/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        swoop: {
          50: '#f0f4ff',
          100: '#e0e9ff',
          500: '#4f6ef7',
          600: '#3b55e6',
          700: '#2e44cc',
          900: '#1a2980',
        },
      },
    },
  },
  plugins: [],
};
