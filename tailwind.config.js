/** @type {import('tailwindcss').Config} */
const appFont = ['"Crimson Pro Variable"', '"LXGW WenKai"', '"Songti SC"', 'STSong', 'serif']

export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        /* preflight 用 sans 设 html */
        sans: appFont,
        /*
         * 代码 / LaTeX 相关一律等宽。
         * 字族栈**必须西文等宽在前**：以前的写法把「LXGW WenKai Mono」排在第一位，
         * 而文楷等宽自带一套西文字面 —— 于是每一处 font-mono 里的英文和数字
         * （字数、模板 documentclass、DOI、哈希…）都长得像中文楷体，跟正文的
         * Crimson 割裂得很明显。
         * 现在西文走系统等宽（ui-monospace → SFMono → Menlo → Consolas），
         * 中文没有这些字形的字符再落到文楷等宽兜底（保证代码里中文注释仍然对齐），
         * 最后 monospace 保底。
         * 全站唯一来源是 index.css :root 里的 --font-mono，这里只引用它。
         */
        mono: ['var(--font-mono)'],
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
