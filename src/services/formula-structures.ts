/**
 * 公式结构模板 —— 底部工具条「结构」按钮往「公式输入框」里插的东西
 * ------------------------------------------------------------
 * 结论先说：**看板不自己画公式，看板就是 KaTeX 的输出。**
 *
 * 为什么推翻原来的做法（原来是自己画的一套「视觉树」）：
 *   原来分数用 `border-bottom` 当分数线、根号用字符 `√` + 上边线、字体用等宽，
 *   而正文和「已有公式」的预览走的是 KaTeX。同一段 LaTeX 在两处必然长得不一样：
 *   分数线只有分子那么宽、根号形状不对、变量不斜体。用户看到的就是
 *   「输入一个样，预览一个样」。
 *   而且那套视觉树与 LaTeX 的往返是有损的：空槽（点了「上标」还没打字）
 *   序列化时会被丢掉 —— 看板里明明有个小格子，插进正文后结构直接消失。
 *
 * 现在的分工（见 UX_DETAILS.md「公式看板就是真渲染」）：
 *   - 看板：KaTeX 渲染，和正文同一个引擎、同一个版本 → 天生一致，
 *     不需要靠调 CSS 去「像」；
 *   - 输入框：唯一的编辑入口。结构按钮往它里面插一段**带占位符的 LaTeX**；
 *   - 占位符插完立刻被选中：直接打字就替换掉它；不打字它也是个看得见的空框。
 *
 * 为什么占位符用 `\square` 而不是 `{}`：`\frac{}{}` 在 KaTeX 里渲染成一条
 * 零宽度的线，「点了根号什么也没发生」。`\square` 是真盒子，点了就看得见结构。
 */

/** 模板里的槽位标记（1 个字符，不会出现在用户输入里）。插进输入框前换成 FORMULA_PLACEHOLDER */
const SLOT = '\u0000'

/** 槽位占位符：KaTeX 认识、且看得见的空框 */
export const FORMULA_PLACEHOLDER = '\\square'

export interface FormulaStructure {
  label: string
  /**
   * 生成模板。`selected` 是输入框里选中的源码 —— 有就填进**第一个**槽位
   * （Word 行为：选中 x 点分数 → x 成了分子），没有就全是占位符。
   */
  build: (selected: string) => string
}

const P = SLOT

/** 根号。单独导出：工具条「运算」组里的 `√` 也要走它（裸字符 √ 永远长不成真根号） */
export const SQRT_STRUCTURE: FormulaStructure = {
  label: '根号',
  build: (s) => `\\sqrt{${s || P}}`,
}

export const FORMULA_STRUCTURES: FormulaStructure[] = [
  { label: '分数', build: (s) => `\\frac{${s || P}}{${P}}` },
  SQRT_STRUCTURE,
  // 上下标的底**必须加花括号**：选中的内容本身可能已经带下标（`\alpha_{1}`），
  // 直接拼会得到 `\alpha_{1}_{\square}` —— 双下标，KaTeX 直接报错。
  // `{x}^{2}` 与 `x^{2}` 渲染完全一样，所以套上花括号没有任何副作用。
  { label: '上标', build: (s) => `${s ? `{${s}}` : P}^{${P}}` },
  { label: '下标', build: (s) => `${s ? `{${s}}` : P}_{${P}}` },
  { label: '上下标', build: (s) => `${s ? `{${s}}` : P}_{${P}}^{${P}}` },
  { label: '求和', build: (s) => `\\sum_{${s || P}}^{${P}}` },
  { label: '积分', build: (s) => `\\int_{${s || P}}^{${P}}` },
  { label: '极限', build: (s) => `\\lim_{${s || 'x'} \\to ${P}}` },
  { label: '正体', build: (s) => `\\mathrm{${s || P}}` },
  { label: '矩阵', build: (s) => `\\begin{matrix}${s || P} & ${P} \\\\ ${P} & ${P}\\end{matrix}` },
]

/**
 * 把模板里的槽位换成真占位符，并算出「插完之后该选中哪一段」。
 *
 * 选中的是**第一个剩下的槽位**：`build()` 已经把用户选中的内容填进第一个槽位了，
 * 所以第一个剩下的槽位就是用户接下来要填的那个（点分数且没选中内容 → 选中分子）。
 */
export function expandStructure(template: string): { tex: string; selStart: number; selEnd: number } {
  const at = template.indexOf(SLOT)
  const tex = template.split(SLOT).join(FORMULA_PLACEHOLDER)
  if (at === -1) return { tex, selStart: tex.length, selEnd: tex.length }
  // indexOf 的定义保证 at 之前没有槽位，所以替换不会改变 at 前面的长度
  return { tex, selStart: at, selEnd: at + FORMULA_PLACEHOLDER.length }
}
