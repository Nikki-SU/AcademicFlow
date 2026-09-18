/**
 * 块语法回归测试：node scripts/test-blocks.mjs
 *
 * 守的是历史上真出过的那类事故——"产物残缺却判 success"。
 * 核对三件事：
 *   1. 往返恒等：parse ∘ serialize 逐字还原
 *   2. 内容守恒：切块 / 重排编号都不动一个字符
 *   3. 前后端口径一致：译文按 ID（或紧邻）回挂，旧格式仍能读
 */
import assert from 'node:assert/strict'
import {
  parseBlocks, serializeBlocks, renumber, readDocument, readAnyDocument,
  legacyToBlocks, stripMarkers, contentFingerprint, blockId, isTranslatable, metaOf, parseMeta,
} from '../src/services/blocks.mjs'

let pass = 0
const ok = (name) => { pass++; console.log(`  ok  ${name}`) }

// ---------- 1. 往返恒等：parse ∘ serialize ----------
const doc = [
  '⟨⟨⟨文字·标题·1·1⟩⟩⟩From Powder to Technical Body⟨⟨⟨/⟩⟩⟩\n\n',
  '⟨⟨⟨文字·正文·0·2⟩⟩⟩Intro paragraph with $x^2$ and ![img](images/a.jpg).⟨⟨⟨/⟩⟩⟩\n\n',
  '⟨⟨⟨列表·1·3⟩⟩⟩- first\n- second⟨⟨⟨/⟩⟩⟩\n\n',
  '⟨⟨⟨图·3·1⟩⟩⟩![Figure 1](images/f1.jpg)⟨⟨⟨/⟩⟩⟩\n',
  '⟨⟨⟨图注·3·2⟩⟩⟩Figure 1. Caption text.⟨⟨⟨/⟩⟩⟩\n',
  '⟨⟨⟨表·3·3⟩⟩⟩| a | b |\n|---|---|\n| 1 | 2 |⟨⟨⟨/⟩⟩⟩\n',
  '⟨⟨⟨公式·3·4⟩⟩⟩$$E = mc^2$$⟨⟨⟨/⟩⟩⟩\n',
  '⟨⟨⟨引文⟩⟩⟩“A quoted sentence.”⟨⟨⟨/⟩⟩⟩\n',
  '⟨⟨⟨译文@2⟩⟩⟩第一段译文。⟨⟨⟨/⟩⟩⟩\n',
  '⟨⟨⟨译文⟩⟩⟩引文的中文。⟨⟨⟨/⟩⟩⟩\n',
  '⟨⟨⟨文献⟩⟩⟩[1] A. Author, J. Name, 2020.⟨⟨⟨/⟩⟩⟩\n',
].join('')

const r1 = parseBlocks(doc)
assert.equal(r1.warnings.length, 0, `不该有告警: ${r1.warnings}`)
assert.equal(serializeBlocks(r1.items), doc, 'parse∘serialize 必须逐字恒等')
assert.equal(serializeBlocks(parseBlocks(serializeBlocks(r1.items)).items), doc, '必须幂等')
ok('往返恒等（11 个块，含全部块类型）')

// ---------- 2. 元信息 ⇄ 节点 ----------
const nodes = r1.items.filter(i => i.t === 'block').map(i => i.node)
assert.deepEqual(nodes.map(blockId), ['1', '2', '3', '3·1', '3·2', '3·3', '3·4', null, null, null, null])
assert.deepEqual(nodes.map(metaOf), [
  '文字·标题·1·1', '文字·正文·0·2', '列表·1·3', '图·3·1', '图注·3·2', '表·3·3', '公式·3·4',
  '引文', '译文@2', '译文', '文献',
])
assert.equal(parseMeta('文字·正文·7·3')?.level, 0, '正文的级别归一化为 0')
assert.equal(parseMeta('瞎写的东西'), null)
assert.equal(parseMeta('文字·正文·0·1').n, 1)
ok('元信息 ⇄ 节点 双向一致')

// 可翻译集合：正文/标题/列表/表/图注/引文 翻；图/公式/文献 不翻
assert.deepEqual(nodes.map(n => isTranslatable(n)), [
  true, true, true, false, true, true, false, true, false, false, false,
])
ok('可翻译集合符合约定')

// ---------- 3. renumber：内容零改动 + 编号重排 ----------
const messy = [
  '⟨⟨⟨文字·正文·0·77⟩⟩⟩A⟨⟨⟨/⟩⟩⟩\n',
  '⟨⟨⟨图·99·42⟩⟩⟩![x](images/x.jpg)⟨⟨⟨/⟩⟩⟩\n',
  '⟨⟨⟨文字·标题·3·5⟩⟩⟩T⟨⟨⟨/⟩⟩⟩\n',
  '⟨⟨⟨表·1·8⟩⟩⟩| a |\n|---|⟨⟨⟨/⟩⟩⟩\n',
  '⟨⟨⟨译文@77⟩⟩⟩译文A⟨⟨⟨/⟩⟩⟩\n',
  '⟨⟨⟨译文@1·8⟩⟩⟩表译文⟨⟨⟨/⟩⟩⟩\n',
].join('')
const fpBefore = contentFingerprint(messy)
const numbered = serializeBlocks(renumber(parseBlocks(messy).items))
assert.equal(contentFingerprint(numbered), fpBefore, 'renumber 不得改动任何内容')
const nb = parseBlocks(numbered).items.filter(i => i.t === 'block').map(i => i.node)
assert.deepEqual(nb.map(blockId), ['1', '1·1', '2', '2·1', null, null])
assert.equal(nb[2].level, 3, '标题级别保留')
assert.equal(nb[4].ref, '1', '译文@77 → 译文@1')
assert.equal(nb[5].ref, '2·1', '译文@1·8 → 译文@2·1')
// 已成型的文档再重排应当稳定
assert.equal(serializeBlocks(renumber(parseBlocks(doc).items)), doc)
ok('renumber 无损、编号与译文引用同步重定向、幂等')

// 浮动块共享序号：同一锚点内 图/表/图注/公式 共用一个序列
const floats = '⟨⟨⟨文字·正文·0·1⟩⟩⟩P⟨⟨⟨/⟩⟩⟩⟨⟨⟨图·1·9⟩⟩⟩![a](x)⟨⟨⟨/⟩⟩⟩⟨⟨⟨表·1·9⟩⟩⟩|a|⟨⟨⟨/⟩⟩⟩⟨⟨⟨公式·1·9⟩⟩⟩$$x$$⟨⟨⟨/⟩⟩⟩'
const fn = serializeBlocks(renumber(parseBlocks(floats).items))
assert.deepEqual(
  parseBlocks(fn).items.filter(i => i.t === 'block').map(i => blockId(i.node)),
  ['1', '1·1', '1·2', '1·3'],
)
ok('浮动块同锚点内共享序号')

// ---------- 4. readDocument：译文配对 ----------
const rd = readDocument(doc)
const rdBlocks = rd.items.filter(i => i.t === 'block')
assert.equal(rdBlocks.find(b => b.id === '2')?.cn, '第一段译文。', '按 ID 配对')
assert.equal(rdBlocks.find(b => b.node.kind === 'note').cn, '引文的中文。', '无编号块按紧邻配对')
assert.equal(rdBlocks.filter(b => b.node.kind === 'translation').length, 0, '译文块不该出现在渲染序列里')
assert.equal(rd.warnings.length, 0)
ok('readDocument 译文配对（@ID + 紧邻）')

// ---------- 5. 容错：绝不丢字 ----------
const broken = 'head⟨⟨⟨文字·正文·0·1⟩⟩⟩body⟨⟨⟨乱码·X⟩⟩⟩tail'
const rb = parseBlocks(broken)
assert.equal(rb.items.filter(i => i.t === 'text').map(i => i.content).join(''), 'head')
assert.ok(rb.warnings.length >= 1, '无法识别的标记要有告警')
const rbOnce = serializeBlocks(rb.items)
assert.ok(rbOnce.includes('body') && rbOnce.includes('tail'), '内容一个都不能丢')
assert.ok(rbOnce.includes('⟨⟨⟨乱码·X⟩⟩⟩'), '无法识别的标记按普通文本保留')
assert.equal(serializeBlocks(parseBlocks(rbOnce).items), rbOnce, 'serialize∘parse 幂等')
ok('容错：碎片 / 未知标记全部字面保留')

const noClose = '⟨⟨⟨文字·正文·0·1⟩⟩⟩abc'
const rnc = parseBlocks(noClose)
assert.equal(rnc.items.find(i => i.t === 'block').content, 'abc', '缺闭合符时内容仍完整')
assert.ok(rnc.warnings.some(w => w.includes('缺少闭合符')))
const surplus = '⟨⟨⟨/⟩⟩⟩abc'
assert.ok(parseBlocks(surplus).items.some(i => i.t === 'text' && i.content.includes('⟨⟨⟨/⟩⟩⟩')))
ok('容错：缺闭合符 / 多余闭合符')

// ---------- 6. 旧格式读取兼容 ----------
const legacy = [
  '<!-- PARA en 1/2 -->\nPara one text\n\n',
  '<!-- PARA en 2/2 -->\nPara two text\n\n',
  '<!-- IMG between 2 and 3 -->\n![F1](images/f1.jpg)\n\n',
  '<!-- TABLE between 2 and 3 -->\n| a | b |\n|---|---|\n',
  '<!-- TABLE cn 2-3 -->\n| 甲 | 乙 |\n',
  '<!-- REF ALL -->\n[1] Ref entry\n',
].join('')
assert.ok(legacyToBlocks(legacy).includes('⟨⟨⟨文字·正文·0·1⟩⟩⟩'), '旧标记应被转换')
assert.equal(legacyToBlocks(doc), null, '新语法不该被旧适配器接管')
const rl = readAnyDocument(legacy)
const lBlocks = rl.items.filter(i => i.t === 'block')
assert.equal(lBlocks.filter(b => b.node.kind === 'flow').length, 2)
assert.equal(lBlocks.find(b => b.node.kind === 'float' && b.node.type === '表').cn.trim(), '| 甲 | 乙 |')
assert.ok(lBlocks.some(b => b.node.kind === 'note' && b.node.type === '文献'), 'REF ALL → 文献块')
assert.equal(rl.warnings.length, 0, `旧格式不该有告警: ${rl.warnings}`)
assert.equal(readAnyDocument(doc).items.length, rd.items.length, '新语法路径不受影响')
ok('旧格式（PARA / IMG / TABLE / REF）读取兼容')

// ---------- 7. stripMarkers / 纯文本 / 空 ----------
assert.equal(stripMarkers(doc).includes('⟨⟨⟨'), false, 'stripMarkers 去掉全部标记')
assert.equal(stripMarkers(doc).includes('第一段译文。'), true, '剥标记不剥内容')
assert.equal(serializeBlocks(parseBlocks('').items), '')
assert.equal(readDocument('plain text only').items.length, 1)
assert.equal(readAnyDocument('').items.length, 0)
ok('stripMarkers / 空文档 / 纯文本')

console.log(`\n全部通过：${pass} 组`)
