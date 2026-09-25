/**
 * 编辑器代码块可选语言。
 * 科研场景常用的排前面 —— 这个项目里 Python / R / MATLAB / Julia 出现最多。
 * 插入代码块的菜单和设置页的「默认语言」共用这一份，避免两边各写一套。
 */
export const CODE_LANGS: { value: string; label: string }[] = [
  { value: '', label: '纯文本' },
  { value: 'python', label: 'Python' },
  { value: 'r', label: 'R' },
  { value: 'matlab', label: 'MATLAB' },
  { value: 'julia', label: 'Julia' },
  { value: 'javascript', label: 'JavaScript' },
  { value: 'typescript', label: 'TypeScript' },
  { value: 'bash', label: 'Shell' },
  { value: 'sql', label: 'SQL' },
  { value: 'json', label: 'JSON' },
  { value: 'yaml', label: 'YAML' },
  { value: 'cpp', label: 'C / C++' },
  { value: 'java', label: 'Java' },
  { value: 'latex', label: 'LaTeX' },
]
