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
      /*
       * 界面字号：全部引用 index.css :root 的 --ui-text-*（流体 clamp）。
       * 只新增 ui-* 键，不动 xs/sm/base 等默认档 —— 正文与编辑器用的是默认档，
       * 这里不会波及它们，markdown 写作 / LaTeX 编译的字号保持精确。
       */
      fontSize: {
        'ui-2xs': ['var(--ui-text-2xs)', { lineHeight: '1.35' }],
        'ui-xs': ['var(--ui-text-xs)', { lineHeight: '1.4' }],
        'ui-sm': ['var(--ui-text-sm)', { lineHeight: '1.5' }],
      },
      /*
       * 界面尺寸：引用 index.css :root 的 --ui-*。
       * 生成 w-/h-/p-/m-/gap- 等工具类，值都是 clamp()，随视口等比伸缩。
       */
      spacing: {
        'ui-gap-sm': 'var(--ui-gap-sm)',
        'ui-gap': 'var(--ui-gap)',
        'ui-gap-lg': 'var(--ui-gap-lg)',
        'ui-indent': 'var(--ui-indent)',
        'ui-axis': 'var(--ui-axis)',
        'ui-icon': 'var(--ui-icon)',
        'ui-icon-sm': 'var(--ui-icon-sm)',
        'ui-dot': 'var(--ui-dot)',
        'ui-lane': 'var(--ui-lane)',
        /* 面板页头固定高度：三栏面板的横线靠它对齐（唯一来源） */
        'ui-header': 'var(--ui-header)',
        /* 页面内容统一纵向页边距（唯一来源） */
        'ui-page': 'var(--ui-page-y)',
      },
      /*
       * 圆角：全站只认这三档，杜绝各处即兴写 rounded-lg / md / xl 造成参差。
       *   card        面板 / 卡片 / 弹窗外壳
       *   control     按钮 / 输入框 / 页签外层
       *   control-sm  段控件内层按钮（比外壳小一档，同视觉圆心）
       * 默认档（none/sm/DEFAULT/md/lg/xl/2xl/3xl/full）仍在，但界面组件一律用上面三档。
       */
      borderRadius: {
        card: '0.75rem',
        control: '0.5rem',
        'control-sm': '0.375rem',
      },
      /*
       * 全站多栏比例模板（唯一来源）
       * -------------------------------------------------
       * 分栏比例也以页面宽（vw）为参照，且**严格满足层级数学约束**：
       *   列宽和 + 列间距和 = 页面可用宽（100vw - 左右页边距 2×2.5vw）
       * 每列用 calc 从「可用宽 - gap 和」按比例切分，绝不溢出、不留白。
       * 想全局调比例，改这里一处即可；页面侧只写 `lg:grid-cols-ratio-121` 这种语义类。
       */
      gridTemplateColumns: {
        'ratio-14': 'minmax(0, calc((100vw - 5vw - var(--ui-gap)) * 1 / 5)) minmax(0, calc((100vw - 5vw - var(--ui-gap)) * 4 / 5))',
        'ratio-111': 'repeat(3, minmax(0, calc((100vw - 5vw - 2 * var(--ui-gap)) / 3)))',
        'ratio-121': 'minmax(0, calc((100vw - 5vw - 2 * var(--ui-gap)) / 4)) minmax(0, calc((100vw - 5vw - 2 * var(--ui-gap)) * 2 / 4)) minmax(0, calc((100vw - 5vw - 2 * var(--ui-gap)) / 4))',
        'ratio-115-115': 'minmax(0, calc((100vw - 5vw - 2 * var(--ui-gap)) / 4)) minmax(0, calc((100vw - 5vw - 2 * var(--ui-gap)) * 1.5 / 4)) minmax(0, calc((100vw - 5vw - 2 * var(--ui-gap)) * 1.5 / 4))',
        'ratio-112': 'minmax(0, calc((100vw - 5vw - 2 * var(--ui-gap)) / 4)) minmax(0, calc((100vw - 5vw - 2 * var(--ui-gap)) / 4)) minmax(0, calc((100vw - 5vw - 2 * var(--ui-gap)) * 2 / 4))',
        'ratio-122': 'minmax(0, calc((100vw - 5vw - 2 * var(--ui-gap)) / 5)) minmax(0, calc((100vw - 5vw - 2 * var(--ui-gap)) * 2 / 5)) minmax(0, calc((100vw - 5vw - 2 * var(--ui-gap)) * 2 / 5))',
        'ratio-131': 'minmax(0, calc((100vw - 5vw - 2 * var(--ui-gap)) / 5)) minmax(0, calc((100vw - 5vw - 2 * var(--ui-gap)) * 3 / 5)) minmax(0, calc((100vw - 5vw - 2 * var(--ui-gap)) / 5))',
        'ratio-113': 'minmax(0, calc((100vw - 5vw - 2 * var(--ui-gap)) / 5)) minmax(0, calc((100vw - 5vw - 2 * var(--ui-gap)) / 5)) minmax(0, calc((100vw - 5vw - 2 * var(--ui-gap)) * 3 / 5))',
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
        /*
         * 荧光笔色板（全站唯一色源，取值见 index.css :root 的 --hl-*）。
         * 每支笔四档：实色 / -ink 落纸半透明 / -soft 卡片淡底 / -deep 深墨。
         * 所有标注类界面（正文高亮、批注卡、紧急死线）都从这里取色，不再各写。
         */
        hl: {
          yellow: 'var(--hl-yellow)',
          'yellow-ink': 'var(--hl-yellow-ink)',
          'yellow-soft': 'var(--hl-yellow-soft)',
          'yellow-deep': 'var(--hl-yellow-deep)',
          green: 'var(--hl-green)',
          'green-ink': 'var(--hl-green-ink)',
          'green-soft': 'var(--hl-green-soft)',
          'green-deep': 'var(--hl-green-deep)',
          blue: 'var(--hl-blue)',
          'blue-ink': 'var(--hl-blue-ink)',
          'blue-soft': 'var(--hl-blue-soft)',
          'blue-deep': 'var(--hl-blue-deep)',
          purple: 'var(--hl-purple)',
          'purple-ink': 'var(--hl-purple-ink)',
          'purple-soft': 'var(--hl-purple-soft)',
          'purple-deep': 'var(--hl-purple-deep)',
          red: 'var(--hl-red)',
          'red-ink': 'var(--hl-red-ink)',
          'red-soft': 'var(--hl-red-soft)',
          'red-deep': 'var(--hl-red-deep)',
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
