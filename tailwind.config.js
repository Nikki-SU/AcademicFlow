/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      /*
       * 字体分两档，各管一件事：
       *   sans    —— UI 骨架（导航/按钮/表单/表格）。小字号下最清晰，也最省。
       *   content —— 内容面（阅读正文、标题、空状态、封面、预览）。
       *              西文与数字落在 Crimson Pro（老式衬线，编辑感），
       *              中文回落到霞鹜文楷 —— 浏览器按字符逐字选第一支有该字形的字体，
       *              所以顺序写成「先 Crimson 再 WenKai」，中英自动分工。
       */
      fontFamily: {
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          '"Segoe UI"',
          '"PingFang SC"',
          '"Hiragino Sans GB"',
          '"Microsoft YaHei"',
          '"Helvetica Neue"',
          'Arial',
          'sans-serif',
        ],
        content: [
          '"Crimson Pro Variable"',
          '"LXGW WenKai"',
          '"Songti SC"',
          'STSong',
          '"Noto Serif SC"',
          'serif',
        ],
      },
      colors: {
        /* 纸：暖白。页面底、卡片面、信息块都用它，避免纯白发冷。 */
        paper: {
          50: '#FDFBF7',
          100: '#F8F4EC',
          200: '#F0EADD',
          300: '#E4DAC6',
          400: '#D2C3A8',
        },
        /* 墨：暖调近黑。正文、边框、主按钮，替代原来的 slate。 */
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
        /* 朱砂：印章式的红，只做强调（图标底、链接、聚焦环、错误），不铺面积。 */
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
        /* 纸片感：一层贴边的接触阴影 + 一层大而淡的投影，避免"糊成一团"的厚阴影。 */
        card: '0 1px 2px rgba(25, 22, 19, 0.05), 0 12px 32px -16px rgba(25, 22, 19, 0.18)',
        lift: '0 2px 4px rgba(25, 22, 19, 0.06), 0 20px 48px -20px rgba(25, 22, 19, 0.24)',
      },
    },
  },
  plugins: [],
}
