from docx import Document
from docx.shared import Pt
from docx.enum.text import WD_ALIGN_PARAGRAPH

doc = Document()

doc.add_heading('Word 转 PDF 保真度测试文档', level=0)
doc.add_paragraph('用于验证 word→PDF→MinerU 管线是否丢内容、是否乱结构。')

doc.add_heading('一级标题：研究背景', level=1)
doc.add_paragraph('这是第一段正文，包含中文与 English 混排，验证字体回退与换行是否正常。')
doc.add_paragraph('这是第二段正文，句末有标点；含引号「引号」、括号（括号）、百分号 50%、货币 ¥100、数学 α β γ。')

doc.add_heading('二级标题：相关工作', level=2)
doc.add_paragraph('下列为无序列表：', style=None)
for item in ['第一条无序列表项', '第二条无序列表项', '第三条无序列表项']:
    doc.add_paragraph(item, style='List Bullet')

doc.add_paragraph('下列为有序列表：')
for item in ['第一步：采集数据', '第二步：预处理', '第三步：建模']:
    doc.add_paragraph(item, style='List Number')

doc.add_heading('三级标题：方法细节', level=3)
doc.add_paragraph('有序列表嵌套段落：')
p = doc.add_paragraph('这是一个带 kaiti 强调的段落结构。')
p.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY

doc.add_heading('表格测试', level=2)
table = doc.add_table(rows=3, cols=3)
table.style = 'Table Grid'
hdr = table.rows[0].cells
hdr[0].text = '方法'
hdr[1].text = '准确率'
hdr[2].text = '备注'
rows = [
    ('基线模型', '82.1%', '无预训练'),
    ('本文方法', '91.4%', '含数据增强'),
]
for i, (a, b, c) in enumerate(rows, start=1):
    cells = table.rows[i].cells
    cells[0].text = a
    cells[1].text = b
    cells[2].text = c

doc.add_heading('代码与公式区', level=2)
doc.add_paragraph('inline 代码：print("hello world")')
doc.add_paragraph('公式示意：E = mc^2')

doc.add_heading('结语', level=1)
doc.add_paragraph('以上内容用于核对：标题层级、段落、列表、表格、中英混排、标点符号。')

doc.save('/workspace/tmp_wordtest/test_fidelity.docx')
print('saved /workspace/tmp_wordtest/test_fidelity.docx')
