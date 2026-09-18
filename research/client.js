/**
 * API 客户端 - 封装 axios
 */
import axios from 'axios'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api/v1'

const apiClient = axios.create({
  baseURL: API_BASE_URL,
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
  },
})

// 请求拦截器
apiClient.interceptors.request.use(
  (config) => {
    // 可以在这里添加 token 等认证信息
    return config
  },
  (error) => {
    return Promise.reject(error)
  }
)

// 响应拦截器
apiClient.interceptors.response.use(
  (response) => response.data,
  (error) => {
    console.error('API Error:', error.response?.data || error.message)
    // 保留完整错误信息，让调用方可以访问 error.response.data.detail
    return Promise.reject(error)
  }
)

// ==================== 文献 API ====================
export const literatureAPI = {
  // 文献条目
  listEntries: (params) => apiClient.get('/literature/entries', { params }),
  getEntry: (doi) => apiClient.get(`/literature/entries/${doi}`),
  createEntry: (data) => apiClient.post('/literature/entries', data),
  updateEntry: (doi, data) => apiClient.put(`/literature/entries/${doi}`, data),
  deleteEntry: (doi) => apiClient.delete(`/literature/entries/${doi}`),

  // 文献表
  listTable: (params) => apiClient.get('/literature/table', { params }),
  getTableEntry: (doi) => apiClient.get(`/literature/table/${doi}`),
  createTableEntry: (data) => apiClient.post('/literature/table', data),
  updateTableEntry: (doi, data) => apiClient.put(`/literature/table/${doi}`, data),
  deleteTableEntry: (doi, cascade) => apiClient.delete(`/literature/table/${doi}`, { params: { cascade } }),
  
  // 批量创建文献表
  createTableBatch: (entries) => apiClient.post('/literature/table/batch', entries),
  
  // 文献表搜索
  searchTable: (q, searchNotes, searchContent) => 
    apiClient.get('/literature/table/search', { params: { q, search_notes: searchNotes, search_content: searchContent } }),
  
  // 获取文献详情（含关联状态）
  getTableEntryDetails: (doi) => apiClient.get(`/literature/table/${doi}/details`),
  
  // 导出
  exportTable: (params) => `${API_BASE_URL}/literature/table/export`,
  exportTableByTags: (tags, format = 'xlsx') => 
    `${API_BASE_URL}/literature/table/export-by-tags?tags=${tags}&format=${format}`,
}

// ==================== 追踪 API ====================
export const trackingAPI = {
  listRecords: (params) => apiClient.get('/tracking/records', { params }),
  getRecord: (id) => apiClient.get(`/tracking/records/${id}`),
  createRecord: (data) => apiClient.post('/tracking/records', data),
  createRecordsBatch: (records) => apiClient.post('/tracking/records/batch', records),
  updateRecord: (id, data) => apiClient.put(`/tracking/records/${id}`, data),
  deleteRecord: (id) => apiClient.delete(`/tracking/records/${id}`),
  getByJournal: (journal) => apiClient.get(`/tracking/records/by-journal/${journal}`),
  getByDate: (date) => apiClient.get(`/tracking/records/by-date/${date}`),
  getDates: () => apiClient.get('/tracking/records/dates'),
  
  // 期刊验证
  validateJournals: (journals) => apiClient.post('/tracking/validate-journals', journals),
  
  // CrossRef搜索
  searchByDoi: (doi, translateAbstract = false) => apiClient.get(`/tracking/search/by-doi/${doi}`, { params: { translate_abstract: translateAbstract } }),
  searchByJournal: (journal, keywords = [], fromDate, untilDate, translateAbstract = false) => 
    apiClient.post(`/tracking/search/by-journal`, null, { params: { 
      journal_name: journal, 
      keywords: typeof keywords === 'string' ? keywords : JSON.stringify(keywords),
      from_date: fromDate,
      until_date: untilDate,
      translate_abstract: translateAbstract
    }}),
  
  // DOI直接添加
  addByDoi: (doi, translateTitle = true, translateAbstract = false, trackingDate) => apiClient.post('/tracking/add-by-doi', null, { params: { 
      doi, 
      translate_title: translateTitle,
      translate_abstract: translateAbstract,
      tracking_date: trackingDate
    }}),
  
  // 导出
  exportRecords: (params) => apiClient.get('/tracking/export/csv', { params }),
}

// ==================== 文献卡片 API ====================
export const cardAPI = {
  // 文献卡片
  listCards: (params) => apiClient.get('/cards/literature', { params }),
  getCard: (doi) => apiClient.get(`/cards/literature/${doi}`),
  createCard: (data) => apiClient.post('/cards/literature', data),
  updateCard: (doi, data) => apiClient.put(`/cards/literature/${doi}`, data),
  deleteCard: (doi) => apiClient.delete(`/cards/literature/${doi}`),

  // 提示词模板
  listPromptTemplates: (params) => apiClient.get('/cards/prompt-templates', { params }),
  getPromptTemplate: (id) => apiClient.get(`/cards/prompt-templates/${id}`),
  createPromptTemplate: (data) => apiClient.post('/cards/prompt-templates', data),
  updatePromptTemplate: (id, data) => apiClient.put(`/cards/prompt-templates/${id}`, data),
  deletePromptTemplate: (id) => apiClient.delete(`/cards/prompt-templates/${id}`),

  // 卡片模板
  listTemplates: (params) => apiClient.get('/cards/templates', { params }),
  getTemplate: (id) => apiClient.get(`/cards/templates/${id}`),
  createTemplate: (data) => apiClient.post('/cards/templates', data),
  updateTemplate: (id, data) => apiClient.put(`/cards/templates/${id}`, data),
  deleteTemplate: (id) => apiClient.delete(`/cards/templates/${id}`),
  
  // 使用模板生成卡片
  generateFromTemplate: (templateId, doi) => 
    apiClient.post(`/ai/generate-card-from-template/${templateId}`, null, { params: { doi } }),
}

// ==================== 附件 API ====================
export const attachmentAPI = {
  list: (params) => apiClient.get('/attachments', { params }),
  get: (id) => apiClient.get(`/attachments/${id}`),
  upload: async (doi, file) => {
    const formData = new FormData()
    formData.append('doi', doi)
    formData.append('file', file)
    return apiClient.post('/attachments', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
  },
  uploadWithParse: async (doi, file, parseMode = 'auto') => {
    const formData = new FormData()
    formData.append('doi', doi)
    formData.append('file', file)
    formData.append('parse_mode', parseMode)
    return apiClient.post('/attachments/upload-with-parse', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
  },
  update: (id, data) => apiClient.put(`/attachments/${id}`, data),
  delete: (id) => apiClient.delete(`/attachments/${id}`),
  download: (id) => `${API_BASE_URL}/attachments/${id}/download`,
  getByDoi: (doi) => apiClient.get(`/attachments/by-doi/${doi}`),
  
  // 解析附件
  parse: (id, mode = 'auto') => apiClient.post(`/attachments/${id}/parse`, null, { params: { mode } }),
  
  // 解析并提取
  parseAndExtract: (id, maxSentences = 10, maxWords = 20) => 
    apiClient.post(`/attachments/${id}/parse-and-extract`, null, { 
      params: { max_sentences: maxSentences, max_words: maxWords } 
    }),
  
  // 解析状态
  getParseStatus: (taskId) => apiClient.get(`/attachments/parse-status/${taskId}`),
  
  // 统计
  getStats: () => apiClient.get('/attachments/stats'),
  
  // 批量解析
  batchParse: (ids, mode = 'auto') => apiClient.post('/attachments/batch-parse', null, {
    params: { attachment_ids: ids, mode }
  }),
}

// ==================== 设置 API ====================
export const settingsAPI = {
  // AI配置
  getAiConfig: () => apiClient.get('/settings/ai-config'),
  updateAiConfig: (config) => apiClient.post('/settings/ai-config', config),
  
  // MinerU配置
  getMineruConfig: () => apiClient.get('/settings/mineru-config'),
  updateMineruConfig: (config) => apiClient.post('/settings/mineru-config', config),
  updateMineruToken: (token) => apiClient.post('/settings/mineru-token', null, { params: { token } }),
  checkMineruTokenStatus: () => apiClient.get('/settings/mineru-token-status'),
  
  // 搜索引擎配置
  getSearchEngines: () => apiClient.get('/settings/search-engines'),
  addSearchEngine: (engine) => apiClient.post('/settings/search-engines', engine),
  updateSearchEngine: (id, engine) => apiClient.put(`/settings/search-engines/${id}`, engine),
  deleteSearchEngine: (id) => apiClient.delete(`/settings/search-engines/${id}`),
  resetSearchEngines: () => apiClient.post('/settings/search-engines/reset'),

  // 追踪配置
  getTrackingConfig: () => apiClient.get('/settings/tracking-config'),
  updateTrackingConfig: (config) => apiClient.post('/settings/tracking-config', config),

  // 学习配置
  getLearningConfig: () => apiClient.get('/settings/learning-config'),
  updateLearningConfig: (config) => apiClient.post('/settings/learning-config', config),

  // OCR配置
  getOcrConfig: () => apiClient.get('/settings/ocr-config'),
  updateOcrConfig: (config) => apiClient.post('/settings/ocr-config', config),
}

// ==================== 结构性文献 API ====================
export const structuredAPI = {
  listLiterature: (params) => apiClient.get('/structured/literature', { params }),
  getLiterature: (doi) => apiClient.get(`/structured/literature/${doi}`),
  createLiterature: (data) => apiClient.post('/structured/literature', data),
  updateLiterature: (doi, data) => apiClient.put(`/structured/literature/${doi}`, data),
  deleteLiterature: (doi) => apiClient.delete(`/structured/literature/${doi}`),
  
  // 获取结构化内容（兼容方法）
  getContent: (doi) => apiClient.get(`/structured/literature/${doi}`),
  
  // 保存结构化内容
  saveContent: (doi, data) => apiClient.put(`/structured/literature/${doi}`, data),

  listNotes: (params) => apiClient.get('/structured/notes', { params }),
  getNote: (id) => apiClient.get(`/structured/notes/${id}`),
  createNote: (data) => apiClient.post('/structured/notes', data),
  updateNote: (id, data) => apiClient.put(`/structured/notes/${id}`, data),
  deleteNote: (id) => apiClient.delete(`/structured/notes/${id}`),
  
  // 长难句提取
  extractSentences: (doi, maxSentences) => 
    apiClient.post(`/structured/extract-sentences/${doi}`, null, { params: { max_sentences: maxSentences } }),
  
  // 关键词提取
  extractKeywords: (doi, maxKeywords) => 
    apiClient.post(`/structured/extract-keywords/${doi}`, null, { params: { max_keywords: maxKeywords } }),
}

// ==================== 学习 API（重写版） ====================
export const learningAPI = {
  // ========== 设置 ==========
  getSettings: () => apiClient.get('/learning/settings'),
  updateSettings: (data) => apiClient.put('/learning/settings', data),
  getQuestionTypes: () => apiClient.get('/learning/question-types'),

  // ========== 单词统计 ==========
  getWordStats: () => apiClient.get('/learning/words/stats'),
  getDueWords: (limit = 20) => apiClient.get('/learning/words/due', { params: { limit } }),

  // ========== 单词 CRUD ==========
  listWords: (params) => apiClient.get('/learning/words', { params }),
  getWord: (id) => apiClient.get(`/learning/words/${id}`),
  createWord: (data) => apiClient.post('/learning/words', data),
  updateWord: (id, data) => apiClient.put(`/learning/words/${id}`, data),
  deleteWord: (id) => apiClient.delete(`/learning/words/${id}`),

  // ========== 单词学习会话 ==========
  startStudy: (mode = 'learn', queueLength = 5, wordIds = null) => 
    apiClient.post('/learning/words/start-study', null, { 
      params: { mode, queue_length: queueLength, word_ids: wordIds } 
    }),
  getCurrentQuestion: (sessionId) => apiClient.get(`/learning/words/current-question/${sessionId}`),
  submitAnswer: (sessionId, wordId, selected) => 
    apiClient.post('/learning/words/answer', { session_id: sessionId, word_id: wordId, selected }),
  nextQuestion: (sessionId) => apiClient.get(`/learning/words/next/${sessionId}`),
  zhanWord: (wordId) => apiClient.post(`/learning/words/zhan/${wordId}`),
  getSession: (sessionId) => apiClient.get(`/learning/words/session/${sessionId}`),
  endSession: (sessionId) => apiClient.post(`/learning/words/end-session/${sessionId}`),

  // ========== 长难句统计 ==========
  getSentenceStats: () => apiClient.get('/learning/sentences/stats'),
  getDueSentences: (limit = 10) => apiClient.get('/learning/sentences/due', { params: { limit } }),

  // ========== 长难句 CRUD ==========
  listSentences: (params) => apiClient.get('/learning/sentences', { params }),
  getSentence: (id) => apiClient.get(`/learning/sentences/${id}`),
  createSentence: (data) => apiClient.post('/learning/sentences', data),
  updateSentence: (id, data) => apiClient.put(`/learning/sentences/${id}`, data),
  deleteSentence: (id) => apiClient.delete(`/learning/sentences/${id}`),

  // ========== 长难句学习 ==========
  submitSentenceTranslation: (sentenceId, translation) => 
    apiClient.post('/learning/sentences/submit-translation', { sentence_id: sentenceId, translation }),
  markSentenceMastered: (sentenceId) => apiClient.post(`/learning/sentences/mark-mastered/${sentenceId}`),

  // ========== 翻译练习统计 ==========
  getTranslationStats: () => apiClient.get('/learning/translations/stats'),
  getDueTranslations: (limit = 10) => apiClient.get('/learning/translations/due', { params: { limit } }),

  // ========== 翻译练习 CRUD ==========
  listTranslations: (params) => apiClient.get('/learning/translations', { params }),
  createTranslation: (data) => apiClient.post('/learning/translations', data),
  submitTranslation: (cardId, translation) => 
    apiClient.post('/learning/translations/submit', { card_id: cardId, translation }),
  deleteTranslation: (id) => apiClient.delete(`/learning/translations/${id}`),

  // ========== 单词表/长难句表 ==========
  listWordLists: (params) => apiClient.get('/learning/word-lists', { params }),
  createWordList: (data) => apiClient.post('/learning/word-lists', data),
  deleteWordList: (id) => apiClient.delete(`/learning/word-lists/${id}`),
  
  listSentenceLists: (params) => apiClient.get('/learning/sentence-lists', { params }),
  createSentenceList: (data) => apiClient.post('/learning/sentence-lists', data),
  deleteSentenceList: (id) => apiClient.delete(`/learning/sentence-lists/${id}`),
}

// ==================== 笔记 API ====================
export const noteAPI = {
  listGeneralNotes: (params) => apiClient.get('/notes/general', { params }),
  getGeneralNote: (id) => apiClient.get(`/notes/general/${id}`),
  createGeneralNote: (data) => apiClient.post('/notes/general', data),
  updateGeneralNote: (id, data) => apiClient.put(`/notes/general/${id}`, data),
  deleteGeneralNote: (id) => apiClient.delete(`/notes/general/${id}`),

  listTemplates: (params) => apiClient.get('/notes/templates', { params }),
  getTemplate: (id) => apiClient.get(`/notes/templates/${id}`),
  createTemplate: (data) => apiClient.post('/notes/templates', data),
  updateTemplate: (id, data) => apiClient.put(`/notes/templates/${id}`, data),
  deleteTemplate: (id) => apiClient.delete(`/notes/templates/${id}`),

  // 文件上传
  uploadFile: async (formData) => {
    return apiClient.post('/notes/upload-file', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
  },

  // 笔记图片上传
  uploadImage: async (file) => {
    const formData = new FormData()
    formData.append('file', file)
    const response = await apiClient.post('/notes/upload-image', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
    return response
  },

  // 公式OCR识别
  ocrFormula: async (file, model = 'turbo') => {
    const formData = new FormData()
    formData.append('file', file)
    formData.append('model', model)
    return apiClient.post('/notes/ocr', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
  },
}

// ==================== 组织 API ====================
export const organizationAPI = {
  // 标签
  listTags: (params) => apiClient.get('/organization/tags', { params }),
  getTag: (id) => apiClient.get(`/organization/tags/${id}`),
  createTag: (data) => apiClient.post('/organization/tags', data),
  updateTag: (id, data) => apiClient.put(`/organization/tags/${id}`, data),
  deleteTag: (id) => apiClient.delete(`/organization/tags/${id}`),
  getTagsByDoi: (doi) => apiClient.get(`/organization/tags/by-doi/${doi}`),
  getTagsByName: (name) => apiClient.get(`/organization/tags/by-name/${name}`),
  getAllTagNames: () => apiClient.get('/organization/tags/all-names'),
  batchCreateTags: (tags) => apiClient.post('/organization/tags/batch', tags),

  // 合集
  listCollections: (params) => apiClient.get('/organization/collections', { params }),
  getCollection: (id) => apiClient.get(`/organization/collections/${id}`),
  createCollection: (data) => apiClient.post('/organization/collections', data),
  updateCollection: (id, data) => apiClient.put(`/organization/collections/${id}`, data),
  deleteCollection: (id) => apiClient.delete(`/organization/collections/${id}`),
  getCollectionItems: (id) => apiClient.get(`/organization/collections/${id}/items`),
  addItemToCollection: (id, data) => apiClient.post(`/organization/collections/${id}/items`, data),
  removeItemFromCollection: (id, itemId) => apiClient.delete(`/organization/collections/${id}/items/${itemId}`),
  filterCollectionItems: (id, params) => apiClient.get(`/organization/collections/${id}/filter`, { params }),

  // 期刊合集
  listJournalGroups: (params) => apiClient.get('/organization/journal-groups', { params }),
  getJournalGroup: (id) => apiClient.get(`/organization/journal-groups/${id}`),
  createJournalGroup: (data) => apiClient.post('/organization/journal-groups', data),
  updateJournalGroup: (id, data) => apiClient.put(`/organization/journal-groups/${id}`, data),
  deleteJournalGroup: (id) => apiClient.delete(`/organization/journal-groups/${id}`),
  validateJournalGroup: (id) => apiClient.post(`/organization/journal-groups/${id}/validate`),

  // 关键词合集
  listKeywordGroups: (params) => apiClient.get('/organization/keyword-groups', { params }),
  getKeywordGroup: (id) => apiClient.get(`/organization/keyword-groups/${id}`),
  createKeywordGroup: (data) => apiClient.post('/organization/keyword-groups', data),
  updateKeywordGroup: (id, data) => apiClient.put(`/organization/keyword-groups/${id}`, data),
  deleteKeywordGroup: (id) => apiClient.delete(`/organization/keyword-groups/${id}`),
}

// ==================== AI API ====================
export const aiAPI = {
  // 配置
  configure: (apiKey, apiBase, model) => 
    apiClient.post('/ai/config', null, { params: { api_key: apiKey, api_base: apiBase, model } }),
  test: () => apiClient.post('/ai/test'),
  
  // 翻译
  translate: (text, targetLang) => apiClient.post('/ai/translate', null, { params: { text, target_lang: targetLang } }),
  translateDoi: (doi) => apiClient.post(`/ai/translate-doi`, null, { params: { doi } }),
  
  // 单词
  completeWord: (wordEn, context) => apiClient.post('/ai/complete-word', null, { params: { word_en: wordEn, context } }),
  
  // 长难句
  translateSentence: (sentenceEn) => apiClient.post('/ai/translate-sentence', null, { params: { sentence_en: sentenceEn } }),
  
  // 分句
  splitSentences: (text) => apiClient.post('/ai/split-sentences', null, { params: { text } }),
  
  // 期刊验证
  suggestJournalCorrection: (journalName) => 
    apiClient.post('/ai/suggest-journal-correction', null, { params: { journal_name: journalName } }),
  
  // 术语提取
  extractTerms: (text) => apiClient.post('/ai/extract-terms', null, { params: { text } }),
  
  // 卡片生成
  generateCard: (literatureData, templatePrompt) => 
    apiClient.post('/ai/generate-card', { literature_data: literatureData, template_prompt: templatePrompt }),
  generateCardFromTemplate: (templateId, doi) => 
    apiClient.post(`/ai/generate-card-from-template/${templateId}`, null, { params: { doi } }),
  
  // 翻译评价
  evaluateTranslation: (original, translation) => 
    apiClient.post('/ai/evaluate-translation', { original, translation }),
  
  // 通用对话
  chat: (messages, temperature, maxTokens) => 
    apiClient.post('/ai/chat', { messages, temperature, max_tokens: maxTokens }),
  
  // 笔记辅助
  summarizeContent: (content, maxLength) => 
    apiClient.post('/ai/summarize-content', null, { params: { content, max_length: maxLength } }),
  extractKeyPoints: (content, numPoints) => 
    apiClient.post('/ai/extract-key-points', null, { params: { content, num_points: numPoints } }),
}

// ==================== 备份同步 API ====================
export const backupAPI = {
  createBackup: () => apiClient.post('/backup/create'),
  listBackups: () => apiClient.get('/backup/list'),
  downloadBackup: (filename) => `${API_BASE_URL}/backup/download/${filename}`,
  restoreBackup: async (file) => {
    const formData = new FormData()
    formData.append('file', file)
    return apiClient.post('/backup/restore', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
  },
}

export const syncAPI = {
  // 注意：这些是旧版同步接口，与 syncV2API 共享 /sync/ 前缀
  // 新代码应使用 syncV2API，这里保留仅为 Settings.jsx 兼容
  push: (deviceId, changes) => apiClient.post('/sync/push', { device_id: deviceId, changes }),
  pull: (deviceId, sinceLogId) => apiClient.post('/sync/pull', { device_id: deviceId, since_log_id: sinceLogId }),
  getStatus: () => apiClient.get('/sync/status'),
  resolveConflict: (tableName, recordPk, resolution, localData, remoteData) => 
    apiClient.post('/sync/resolve-conflict', { table_name: tableName, record_pk: recordPk, resolution, local_data: localData, remote_data: remoteData }),
}

// ==================== 配对 API ====================
export const pairingAPI = {
  // 生成配对码
  generateCode: () => apiClient.post('/pairing/generate'),
  // 验证配对码
  verifyCode: (code) => apiClient.post('/pairing/verify', null, { params: { code } }),
  // 连接Hub
  connectWithCode: (code, deviceInfo) => apiClient.post('/pairing/connect', deviceInfo, { params: { code } }),
  // 获取中继状态
  getRelayStatus: () => apiClient.get('/pairing/relay-status'),
  // 配置中继
  configureRelay: (url) => apiClient.post('/pairing/relay-configure', null, { params: { url } }),
}

// ==================== 同步V2 API ====================
export const syncV2API = {
  // 获取同步状态
  getStatus: () => apiClient.get('/sync/status'),
  // 获取设备列表
  getDevices: () => apiClient.get('/sync/devices'),
  // 发现Hub
  discover: () => apiClient.get('/sync/discover'),
  // 注册设备
  register: (data) => apiClient.post('/sync/register', data),
  // 注销设备
  unregister: (deviceId) => apiClient.delete('/sync/devices/' + deviceId),
  // 切换角色
  switchRole: (role, hubUrl) => apiClient.post('/sync/switch-role', { role, hub_url: hubUrl }),
  // 拉取变更
  pull: (deviceId, sinceLogId) => apiClient.post('/sync/pull', { device_id: deviceId, since_log_id: sinceLogId }),
  // 推送变更
  push: (deviceId, changes) => apiClient.post('/sync/push', { device_id: deviceId, changes }),
  // 应用远程变更
  applyRemote: (deviceId, sinceLogId) => apiClient.post('/sync/apply-remote', { device_id: deviceId, since_log_id: sinceLogId }),
  // 获取未同步变更
  getUnsynced: (deviceId) => apiClient.get('/sync/unsynced', { params: { device_id: deviceId } }),
  // 获取冲突列表
  getConflicts: () => apiClient.get('/sync/conflicts'),
  // 解决冲突
  resolveConflict: (tableName, recordPk, resolution, chosenData) => 
    apiClient.post('/sync/resolve-conflict', { table_name: tableName, record_pk: recordPk, resolution, chosen_data: chosenData }),
  // 批量解决冲突
  resolveAllConflicts: (resolution) => apiClient.post('/sync/resolve-all-conflicts', { resolution }),
  // 附件清单 - 暂未实现
}

// ==================== 笔记图片 OCR API ====================
// noteOCRAPI 已合并到 noteAPI，请使用 noteAPI.ocrFormula / settingsAPI.getOcrConfig / settingsAPI.updateOcrConfig
export const noteOCRAPI = {
  // 公式OCR识别（兼容旧引用，等同 noteAPI.ocrFormula）
  recognizeFormula: (file, model = 'turbo') => {
    const formData = new FormData()
    formData.append('file', file)
    formData.append('model', model)
    return apiClient.post('/notes/ocr', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
  },
  // OCR配置已移至 settingsAPI.getOcrConfig / settingsAPI.updateOcrConfig
  getConfig: () => apiClient.get('/settings/ocr-config'),
  updateConfig: (config) => apiClient.post('/settings/ocr-config', config),
}

// ==================== 翻译练习 API（兼容旧版） ====================
export const translationAPI = {
  list: (params) => apiClient.get('/translation/cards', { params }),
  get: (id) => apiClient.get(`/translation/cards/${id}`),
  create: (data) => apiClient.post('/translation/cards', data),
  update: (id, data) => apiClient.put(`/translation/cards/${id}`, data),
  delete: (id) => apiClient.delete(`/translation/cards/${id}`),
  evaluate: (id, translation) => apiClient.post(`/translation/cards/${id}/evaluate`, { translation }),
}

export default apiClient
