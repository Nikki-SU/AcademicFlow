/** @type {import('tailwindcss').Config} */
const appFont = ['"Crimson Pro Variable"', '"LXGW WenKai"', '"Songti SC"', 'STSong', 'serif']

export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        /* preflight 用 sans 设 html */
        sans: appFont,
        /* 代码/LaTeX 区必须等宽：用同族的文楷等宽切版，再兜到系统等宽 */
        mono: ['"LXGW WenKai Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      colors: {
        paper: {
          50: '#FDFBF7',
          100: '#F8F4EC',
          200: '#F0EADD',
          300: '#E4DAC6',
          400: '#D2C3A8',
        },
        ink: {
          50: '#F6F5F3',
          100: '#E9E6E1',
          200: '#D3CEC6',
          300: '#B0A99E',
          400: '#8A8378',
          500: '#6B655C',
          600: '#524D46',
          700: '#3D3934',
          800: '#292521',
          900: '#191613',
        },
        seal: {
          50: '#FBF0ED',
          100: '#F6DED8',
          200: '#ECC0B5',
          300: '#DF9C8C',
          400: '#D07562',
          500: '#BE5442',
          600: '#A63E2E',
          700: '#883226',
          800: '#6C2A20',
          900: '#55241C',
        },
      },
      boxShadow: {
        card: '0 1px 2px rgba(25, 22, 19, 0.05), 0 12px 32px -16px rgba(25, 22, 19, 0.18)',
        lift: '0 2px 4px rgba(25, 22, 19, 0.06), 0 20px 48px -20px rgba(25, 22, 19, 0.24)',
      },
    },
  },
  plugins: [],
}
