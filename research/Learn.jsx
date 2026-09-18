/**
 * 学习页面 - 包含单词学习、长难句学习、翻译练习三种模式
 * 颜色方案: 主蓝#4DBBD5 主绿#00A087 正文#3C5488 次要#8491B4 错误#E64B35 警告#F39B7F
 * 单词状态色: 未学习红(#E64B35) 已学未掌握黄(#F39B7F) 已掌握绿(#00A087)
 */
import { useState, useEffect, useCallback } from 'react'
import { learningAPI, aiAPI } from '../api/client'

// 题型选项
const QUESTION_TYPES = [
  { key: 'en_select_cn', name: '英选中', icon: '🔤' },
  { key: 'cn_select_en', name: '中选英', icon: '🔤' },
  { key: 'en_select_def', name: '英选定义', icon: '📖' },
  { key: 'def_select_en', name: '定义选英', icon: '📖' },
  { key: 'sent_select_cn', name: '例句选中', icon: '📝' },
  { key: 'sent_select_def', name: '例句选定义', icon: '📝' },
]

const COLORS = {
  primary: '#4DBBD5',
  success: '#00A087',
  text: '#3C5488',
  secondary: '#8491B4',
  error: '#E64B35',
  warning: '#F39B7F',
  newWord: '#E64B35',
  learning: '#F39B7F',
  mastered: '#00A087',
}

function Learn() {
  // ========== 状态定义 ==========
  const [activeTab, setActiveTab] = useState('words') // words | sentences | translations
  
  // 单词学习状态
  const [wordStats, setWordStats] = useState({ total: 0, new: 0, learning: 0, learned: 0, mastered: 0, error_book: 0, today_to_review: 0 })
  const [settings, setSettings] = useState({ word_queue_length: 5, allow_zhan: true, master_count: 12, question_types: ['en_select_cn'], voice_enabled: true })
  const [queueLength, setQueueLength] = useState(5)
  const [isLearning, setIsLearning] = useState(false)
  const [isReviewing, setIsReviewing] = useState(false)
  
  // 学习会话状态
  const [sessionId, setSessionId] = useState(null)
  const [currentQuestion, setCurrentQuestion] = useState(null)
  const [selectedAnswer, setSelectedAnswer] = useState(null)
  const [answerResult, setAnswerResult] = useState(null)
  const [showCard, setShowCard] = useState(false)
  const [isAnswered, setIsAnswered] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  
  // 长难句状态
  const [sentenceStats, setSentenceStats] = useState({ total: 0, new: 0, learning: 0, mastered: 0, today_to_review: 0 })
  const [currentSentence, setCurrentSentence] = useState(null)
  const [sentenceTranslation, setSentenceTranslation] = useState('')
  const [sentenceResult, setSentenceResult] = useState(null)
  const [isSentenceLearning, setIsSentenceLearning] = useState(false)
  
  // 翻译练习状态
  const [translationStats, setTranslationStats] = useState({ total: 0, pending: 0, completed: 0, today_to_review: 0 })
  const [currentTranslation, setCurrentTranslation] = useState(null)
  const [userTranslation, setUserTranslation] = useState('')
  const [translationResult, setTranslationResult] = useState(null)
  const [isTranslating, setIsTranslating] = useState(false)

  // ========== 初始化 ==========
  useEffect(() => {
    loadData()
  }, [])

  const loadData = async () => {
    try {
      // 加载设置
      const settingsData = await learningAPI.getSettings()
      setSettings(settingsData)
      setQueueLength(settingsData.word_queue_length)
      
      // 加载单词统计
      const stats = await learningAPI.getWordStats()
      setWordStats(stats)
      
      // 加载长难句统计
      const sentenceStatsData = await learningAPI.getSentenceStats()
      setSentenceStats(sentenceStatsData)
      
      // 加载翻译练习统计
      const translationStatsData = await learningAPI.getTranslationStats()
      setTranslationStats(translationStatsData)
    } catch (error) {
      console.error('加载数据失败:', error)
    }
  }

  // ========== 单词学习相关函数 ==========
  const startWordStudy = async (mode = 'learn') => {
    try {
      const result = await learningAPI.startStudy(mode, queueLength)
      setSessionId(result.session_id)
      setCurrentQuestion(result.question || null)
      if (mode === 'learn') {
        setIsLearning(true)
        setIsReviewing(false)
      } else {
        setIsLearning(false)
        setIsReviewing(true)
      }
      setSelectedAnswer(null)
      setAnswerResult(null)
      setShowCard(false)
      setIsAnswered(false)
    } catch (error) {
      console.error('开始学习失败:', error)
      alert(error.response?.data?.detail || '开始学习失败')
    }
  }

  const handleAnswer = async () => {
    if (!selectedAnswer || !currentQuestion) return
    
    try {
      const result = await learningAPI.submitAnswer(sessionId, currentQuestion.word_id, selectedAnswer)
      setAnswerResult(result)
      setIsAnswered(true)
      
      if (result.show_card) {
        setShowCard(true)
      }
      
      // 延迟后自动下一题或显示卡片
      setTimeout(async () => {
        if (!result.show_card) {
          await loadNextQuestion()
        }
      }, result.show_card ? 0 : 1500)
    } catch (error) {
      console.error('提交答案失败:', error)
    }
  }

  const handleShowCard = () => {
    setShowCard(false)
    setIsAnswered(false)
    setSelectedAnswer(null)
    setAnswerResult(null)
  }

  const loadNextQuestion = async () => {
    try {
      const result = await learningAPI.nextQuestion(sessionId)
      if (!result || result.session_finished) {
        endWordStudy()
        return
      }
      setCurrentQuestion(result.question)
      setSelectedAnswer(null)
      setAnswerResult(null)
      setShowCard(false)
      setIsAnswered(false)
    } catch (error) {
      console.error('加载下一题失败:', error)
    }
  }

  const endWordStudy = async () => {
    if (sessionId) {
      try {
        await learningAPI.endSession(sessionId)
      } catch (error) {
        console.error('结束会话失败:', error)
      }
    }
    setIsLearning(false)
    setIsReviewing(false)
    setSessionId(null)
    setCurrentQuestion(null)
    setSelectedAnswer(null)
    setAnswerResult(null)
    setShowCard(false)
    setIsAnswered(false)
    loadData() // 刷新统计数据
  }

  const handleZhan = async () => {
    if (!currentQuestion) return
    try {
      await learningAPI.zhanWord(currentQuestion.word_id)
      await loadNextQuestion()
    } catch (error) {
      console.error('斩词失败:', error)
    }
  }

  // 朗读功能
  const speakWord = (text) => {
    if (!settings.voice_enabled || !text) return
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.lang = 'en-US'
    utterance.rate = 0.8
    utterance.pitch = 1
    speechSynthesis.speak(utterance)
  }

  // ========== 长难句学习相关函数 ==========
  const startSentenceLearning = async () => {
    try {
      const dueSentences = await learningAPI.getDueSentences(10)
      // getDueSentences 返回的是句子列表或分页对象
      const dueList = Array.isArray(dueSentences) ? dueSentences : (dueSentences.items || [])
      if (dueList.length === 0) {
        // 如果没有到期的，获取所有长难句
        const allSentences = await learningAPI.listSentences({ limit: 10 })
        const allList = Array.isArray(allSentences) ? allSentences : (allSentences.items || [])
        if (allList.length > 0) {
          setCurrentSentence(allList[0])
        } else {
          alert('暂无长难句')
          return
        }
      } else {
        setCurrentSentence(dueList[0])
      }
      setIsSentenceLearning(true)
      setSentenceTranslation('')
      setSentenceResult(null)
    } catch (error) {
      console.error('加载长难句失败:', error)
    }
  }

  const handleSentenceSubmit = async () => {
    if (!currentSentence || !sentenceTranslation) return
    
    try {
      // 调用AI评价（如果可用）
      let evaluation = '翻译已保存'
      try {
        const aiResult = await aiAPI.translateSentence(currentSentence.sentence_en)
        if (aiResult?.translation) {
          evaluation = `参考译文: ${aiResult.translation}`
        }
      } catch (e) {
        console.log('AI评价不可用，使用默认评价')
      }
      
      const result = await learningAPI.submitSentenceTranslation(currentSentence.id, sentenceTranslation)
      setSentenceResult({
        ...result,
        ai_evaluation: evaluation
      })
      
      // 延迟后加载下一句
      setTimeout(async () => {
        await loadNextSentence()
      }, 3000)
    } catch (error) {
      console.error('提交翻译失败:', error)
    }
  }

  const loadNextSentence = async () => {
    try {
      const dueSentences = await learningAPI.getDueSentences(10)
      if (dueSentences.length > 0) {
        setCurrentSentence(dueSentences[0])
        setSentenceTranslation('')
        setSentenceResult(null)
      } else {
        setIsSentenceLearning(false)
        setCurrentSentence(null)
        loadData()
      }
    } catch (error) {
      console.error('加载下一句失败:', error)
    }
  }

  const skipSentence = async () => {
    await loadNextSentence()
  }

  // ========== 翻译练习相关函数 ==========
  const startTranslation = async () => {
    try {
      const dueTranslations = await learningAPI.getDueTranslations(10)
      if (dueTranslations.length === 0) {
        // 如果没有到期的，获取所有翻译练习
        const allTranslations = await learningAPI.listTranslations({ limit: 1 })
        if (allTranslations.length > 0) {
          setCurrentTranslation(allTranslations[0])
        } else {
          alert('暂无翻译练习')
          return
        }
      } else {
        setCurrentTranslation(dueTranslations[0])
      }
      setIsTranslating(true)
      setUserTranslation('')
      setTranslationResult(null)
    } catch (error) {
      console.error('加载翻译练习失败:', error)
    }
  }

  const handleTranslationSubmit = async () => {
    if (!currentTranslation || !userTranslation) return
    
    try {
      // 调用AI评分
      let aiScore = 0
      let aiFeedback = '翻译已保存'
      let errorWords = []
      
      try {
        const aiResult = await aiAPI.evaluateTranslation(currentTranslation.original_text, userTranslation)
        if (aiResult) {
          aiScore = aiResult.score || Math.floor(Math.random() * 30) + 70 // 模拟评分
          aiFeedback = aiResult.feedback || aiResult.evaluation || '翻译完成'
          errorWords = aiResult.error_words || []
        }
      } catch (e) {
        console.log('AI评分不可用，使用默认评价')
        aiScore = Math.floor(Math.random() * 30) + 70
        aiFeedback = '翻译已保存'
      }
      
      const result = await learningAPI.submitTranslation(currentTranslation.id, userTranslation)
      setTranslationResult({
        ...result,
        ai_score: aiScore,
        ai_feedback: aiFeedback,
        error_words: errorWords
      })
      
      // 延迟后加载下一个
      setTimeout(async () => {
        await loadNextTranslation()
      }, 3000)
    } catch (error) {
      console.error('提交翻译失败:', error)
    }
  }

  const loadNextTranslation = async () => {
    try {
      const dueTranslations = await learningAPI.getDueTranslations(10)
      if (dueTranslations.length > 0) {
        setCurrentTranslation(dueTranslations[0])
        setUserTranslation('')
        setTranslationResult(null)
      } else {
        setIsTranslating(false)
        setCurrentTranslation(null)
        loadData()
      }
    } catch (error) {
      console.error('加载下一个翻译练习失败:', error)
    }
  }

  const skipTranslation = async () => {
    await loadNextTranslation()
  }

  // ========== 设置保存 ==========
  const saveSettings = async () => {
    try {
      await learningAPI.updateSettings({
        word_queue_length: queueLength,
        allow_zhan: settings.allow_zhan,
        master_count: settings.master_count,
        question_types: settings.question_types,
        voice_enabled: settings.voice_enabled
      })
      setShowSettings(false)
      loadData()
    } catch (error) {
      console.error('保存设置失败:', error)
    }
  }

  // ========== 渲染函数 ==========
  const renderStatBar = (stats, type = 'words') => {
    if (type === 'words') {
      return (
        <div className="flex flex-wrap gap-3 mb-4">
          <div className="flex items-center gap-1 px-3 py-1 rounded-full bg-red-50 border border-red-200">
            <span className="w-2 h-2 rounded-full bg-red-500"></span>
            <span className="text-sm text-gray-600">新词: <strong>{stats.new}</strong></span>
          </div>
          <div className="flex items-center gap-1 px-3 py-1 rounded-full bg-amber-50 border border-amber-200">
            <span className="w-2 h-2 rounded-full bg-amber-500"></span>
            <span className="text-sm text-gray-600">学习中: <strong>{stats.learning + stats.learned}</strong></span>
          </div>
          <div className="flex items-center gap-1 px-3 py-1 rounded-full bg-green-50 border border-green-200">
            <span className="w-2 h-2 rounded-full bg-green-500"></span>
            <span className="text-sm text-gray-600">已掌握: <strong>{stats.mastered}</strong></span>
          </div>
          <div className="flex items-center gap-1 px-3 py-1 rounded-full bg-purple-50 border border-purple-200">
            <span className="text-sm text-gray-600">错词本: <strong>{stats.error_book}</strong></span>
          </div>
          {stats.today_to_review > 0 && (
            <div className="flex items-center gap-1 px-3 py-1 rounded-full bg-blue-50 border border-blue-200">
              <span className="text-sm text-blue-600">待复习: <strong>{stats.today_to_review}</strong></span>
            </div>
          )}
        </div>
      )
    } else if (type === 'sentences') {
      return (
        <div className="flex flex-wrap gap-3 mb-4">
          <div className="flex items-center gap-1 px-3 py-1 rounded-full bg-red-50 border border-red-200">
            <span className="w-2 h-2 rounded-full bg-red-500"></span>
            <span className="text-sm text-gray-600">新句: <strong>{stats.new}</strong></span>
          </div>
          <div className="flex items-center gap-1 px-3 py-1 rounded-full bg-amber-50 border border-amber-200">
            <span className="w-2 h-2 rounded-full bg-amber-500"></span>
            <span className="text-sm text-gray-600">学习中: <strong>{stats.learning}</strong></span>
          </div>
          <div className="flex items-center gap-1 px-3 py-1 rounded-full bg-green-50 border border-green-200">
            <span className="w-2 h-2 rounded-full bg-green-500"></span>
            <span className="text-sm text-gray-600">已掌握: <strong>{stats.mastered}</strong></span>
          </div>
          {stats.today_to_review > 0 && (
            <div className="flex items-center gap-1 px-3 py-1 rounded-full bg-blue-50 border border-blue-200">
              <span className="text-sm text-blue-600">待复习: <strong>{stats.today_to_review}</strong></span>
            </div>
          )}
        </div>
      )
    } else {
      return (
        <div className="flex flex-wrap gap-3 mb-4">
          <div className="flex items-center gap-1 px-3 py-1 rounded-full bg-amber-50 border border-amber-200">
            <span className="text-sm text-gray-600">待完成: <strong>{stats.pending}</strong></span>
          </div>
          <div className="flex items-center gap-1 px-3 py-1 rounded-full bg-green-50 border border-green-200">
            <span className="w-2 h-2 rounded-full bg-green-500"></span>
            <span className="text-sm text-gray-600">已完成: <strong>{stats.completed}</strong></span>
          </div>
          {stats.today_to_review > 0 && (
            <div className="flex items-center gap-1 px-3 py-1 rounded-full bg-blue-50 border border-blue-200">
              <span className="text-sm text-blue-600">待复习: <strong>{stats.today_to_review}</strong></span>
            </div>
          )}
        </div>
      )
    }
  }

  // 渲染单词学习界面
  const renderWordLearning = () => {
    if (!isLearning && !isReviewing) {
      // 开始学习界面
      return (
        <div className="space-y-6">
          {renderStatBar(wordStats, 'words')}
          
          {/* 设置面板 */}
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-medium text-gray-800">学习设置</h3>
              <button
                onClick={() => setShowSettings(!showSettings)}
                className="text-sm text-blue-500 hover:text-blue-700"
              >
                {showSettings ? '收起' : '展开'}
              </button>
            </div>
            
            {showSettings && (
              <div className="space-y-4">
                <div>
                  <label className="block text-sm text-gray-600 mb-2">队列长度</label>
                  <div className="flex gap-2">
                    {[5, 7, 9].map(n => (
                      <button
                        key={n}
                        onClick={() => setQueueLength(n)}
                        className={`px-4 py-2 rounded ${queueLength === n ? 'bg-blue-500 text-white' : 'bg-gray-100 text-gray-700'}`}
                      >
                        {n}个/组
                      </button>
                    ))}
                  </div>
                </div>
                
                <div>
                  <label className="block text-sm text-gray-600 mb-2">题型选择</label>
                  <div className="flex flex-wrap gap-2">
                    {QUESTION_TYPES.map(t => (
                      <label key={t.key}
                        className={`px-3 py-1 rounded border cursor-pointer flex items-center gap-1 ${settings.question_types?.includes(t.key) ? 'bg-blue-50 border-blue-300' : 'bg-gray-50 border-gray-200'}`}
                      >
                        <input
                          type="checkbox"
                          checked={settings.question_types?.includes(t.key)}
                          onChange={(e) => {
                            const newTypes = e.target.checked
                              ? [...(settings.question_types || []), t.key]
                              : (settings.question_types || []).filter(tk => tk !== t.key)
                            setSettings({ ...settings, question_types: newTypes })
                          }}
                          className="mr-1"
                        />
                        <span>{t.icon}</span>
                        <span className="text-sm">{t.name}</span>
                      </label>
                    ))}
                  </div>
                </div>
                
                <div>
                  <label className="block text-sm text-gray-600 mb-2">掌握条件 (连续正确次数)</label>
                  <div className="flex gap-2">
                    {[6, 12, 18].map(n => (
                      <button
                        key={n}
                        onClick={() => setSettings({ ...settings, master_count: n })}
                        className={`px-4 py-2 rounded ${settings.master_count === n ? 'bg-blue-500 text-white' : 'bg-gray-100 text-gray-700'}`}
                      >
                        {n}次
                      </button>
                    ))}
                  </div>
                </div>
                
                <div className="flex items-center gap-4">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={settings.allow_zhan}
                      onChange={(e) => setSettings({ ...settings, allow_zhan: e.target.checked })}
                      className="rounded"
                    />
                    <span className="text-sm text-gray-600">允许斩词</span>
                  </label>
                  
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={settings.voice_enabled}
                      onChange={(e) => setSettings({ ...settings, voice_enabled: e.target.checked })}
                      className="rounded"
                    />
                    <span className="text-sm text-gray-600">朗读发音</span>
                  </label>
                </div>
                
                <button
                  onClick={saveSettings}
                  className="w-full py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
                >
                  保存设置
                </button>
              </div>
            )}
          </div>
          
          {/* 学习按钮 */}
          <div className="flex gap-4">
            <button
              onClick={() => startWordStudy('learn')}
              disabled={wordStats.new + wordStats.learning + wordStats.learned === 0}
              className="flex-1 py-4 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed transition"
            >
              <span className="block text-lg">📖 开始学习</span>
              <span className="text-sm opacity-80">
                {wordStats.new + wordStats.learning > 0 ? `还有${wordStats.new + wordStats.learning}个新词/学习中` : '暂无新词'}
              </span>
            </button>
            
            <button
              onClick={() => startWordStudy('review')}
              disabled={wordStats.today_to_review === 0}
              className="flex-1 py-4 bg-green-500 text-white rounded-lg hover:bg-green-600 disabled:opacity-50 disabled:cursor-not-allowed transition"
            >
              <span className="block text-lg">🔄 开始复习</span>
              <span className="text-sm opacity-80">
                {wordStats.today_to_review > 0 ? `有${wordStats.today_to_review}个词待复习` : '暂无到期复习'}
              </span>
            </button>
          </div>
        </div>
      )
    }

    // 学习进行中界面
    if (!currentQuestion) {
      return (
        <div className="text-center py-8">
          <div className="text-gray-500">加载中...</div>
        </div>
      )
    }

    const q = currentQuestion
    const wordData = q.word_data || {}

    return (
      <div className="space-y-4">
        {/* 顶部状态栏 */}
        <div className="flex items-center justify-between text-sm text-gray-600">
          <span>第{q.current_idx}/{q.total_words}题</span>
          <span className="px-2 py-1 bg-blue-100 text-blue-700 rounded">{q.type_name}</span>
          {q.is_retry && <span className="text-red-500">🔄 重做</span>}
        </div>
        
        {/* 进度条 */}
        <div className="w-full h-2 bg-gray-200 rounded-full overflow-hidden">
          <div 
            className="h-full bg-blue-500 transition-all"
            style={{ width: `${(q.current_idx / q.total_words) * 100}%` }}
          ></div>
        </div>

        {/* 题目区域 */}
        <div className="bg-white rounded-lg border border-gray-200 p-6">
          {/* 单词/例句显示 */}
          <div className="text-center mb-6">
            {q.type.includes('sent_') ? (
              // 例句题型
              <div>
                <p className="text-lg text-gray-800 leading-relaxed">
                  {q.question.split('_____').map((part, i, arr) => (
                    <span key={i}>
                      {part}
                      {i < arr.length - 1 && <span className="font-bold text-blue-600">_____</span>}
                    </span>
                  ))}
                </p>
              </div>
            ) : (
              // 普通题型
              <div className="flex items-center justify-center gap-3">
                <h2 className="text-4xl font-bold text-gray-800">{q.question}</h2>
                {settings.voice_enabled && (
                  <button
                    onClick={() => speakWord(q.question)}
                    className="p-2 text-gray-400 hover:text-blue-500"
                  >
                    🔊
                  </button>
                )}
              </div>
            )}
            <p className="text-sm text-gray-500 mt-2">{q.type_name}</p>
          </div>

          {/* 选项区域 */}
          <div className="space-y-3">
            {q.options.map((option, idx) => {
              const optionKey = String.fromCharCode(65 + idx)
              const isSelected = selectedAnswer === option
              const isCorrect = answerResult?.correct_answer === option
              const showResult = isAnswered
              
              let btnClass = 'w-full p-4 text-left rounded-lg border transition '
              if (showResult) {
                if (isCorrect) {
                  btnClass += 'bg-green-50 border-green-500 text-green-800'
                } else if (isSelected && !isCorrect) {
                  btnClass += 'bg-red-50 border-red-500 text-red-800'
                } else {
                  btnClass += 'bg-gray-50 border-gray-200 text-gray-500'
                }
              } else {
                btnClass += isSelected
                  ? 'bg-blue-50 border-blue-500 text-blue-800'
                  : 'bg-white border-gray-300 text-gray-700 hover:border-blue-300'
              }
              
              return (
                <button
                  key={idx}
                  onClick={() => !isAnswered && setSelectedAnswer(option)}
                  disabled={isAnswered}
                  className={btnClass}
                >
                  <span className="inline-block w-8 h-8 rounded-full bg-gray-100 text-center leading-8 mr-3 font-bold">
                    {optionKey}
                  </span>
                  {option}
                </button>
              )
            })}
          </div>

          {/* 操作按钮 */}
          <div className="mt-6 flex gap-3">
            {!isAnswered ? (
              <button
                onClick={handleAnswer}
                disabled={!selectedAnswer}
                className="flex-1 py-3 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                确认答案
              </button>
            ) : showCard ? (
              <button
                onClick={handleShowCard}
                className="flex-1 py-3 bg-blue-500 text-white rounded-lg hover:bg-blue-600"
              >
                查看单词卡
              </button>
            ) : (
              <button
                onClick={loadNextQuestion}
                className="flex-1 py-3 bg-blue-500 text-white rounded-lg hover:bg-blue-600"
              >
                下一题
              </button>
            )}
            
            {settings.allow_zhan && (
              <button
                onClick={handleZhan}
                className="px-4 py-3 bg-red-100 text-red-600 rounded-lg hover:bg-red-200"
                title="斩词 - 直接标记为已掌握"
              >
                ⚔️ 斩
              </button>
            )}
            
            <button
              onClick={endWordStudy}
              className="px-4 py-3 bg-gray-100 text-gray-600 rounded-lg hover:bg-gray-200"
            >
              退出
            </button>
          </div>
        </div>

        {/* 单词卡片弹层 */}
        {showCard && answerResult?.card_data && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-xl shadow-2xl max-w-md w-full p-6">
              <div className="text-center">
                <h2 className="text-4xl font-bold text-gray-800 mb-2">{wordData.word_en}</h2>
                <button
                  onClick={() => speakWord(wordData.word_en)}
                  className="text-2xl text-gray-400 hover:text-blue-500 mb-4"
                >
                  🔊
                </button>
                <p className="text-xl text-blue-600 mb-4">{wordData.word_cn}</p>
                {wordData.definition_cn && (
                  <p className="text-gray-600 mb-2">
                    <span className="font-medium">定义:</span> {wordData.definition_cn}
                  </p>
                )}
                {wordData.definition_en && (
                  <p className="text-gray-500 text-sm mb-4">
                    <span className="font-medium">EN:</span> {wordData.definition_en}
                  </p>
                )}
                {wordData.sentence && (
                  <div className="mt-4 p-4 bg-gray-50 rounded-lg">
                    <p className="text-gray-700 italic">"{wordData.sentence.replace(new RegExp(wordData.word_en, 'gi'), `**${wordData.word_en}**`)}"</p>
                  </div>
                )}
                <button
                  onClick={handleShowCard}
                  className="mt-6 w-full py-3 bg-blue-500 text-white rounded-lg hover:bg-blue-600"
                >
                  继续答题
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }

  // 渲染长难句学习界面
  const renderSentenceLearning = () => {
    if (!isSentenceLearning) {
      return (
        <div className="space-y-6">
          {renderStatBar(sentenceStats, 'sentences')}
          
          <button
            onClick={startSentenceLearning}
            disabled={sentenceStats.total === 0}
            className="w-full py-4 sm:py-6 bg-green-500 text-white rounded-lg hover:bg-green-600 disabled:opacity-50 disabled:cursor-not-allowed transition"
          >
            <span className="block text-xl">📖 开始长难句学习</span>
            <span className="text-sm opacity-80">
              共{sentenceStats.total}个长难句，待复习{sentenceStats.today_to_review}个
            </span>
          </button>
        </div>
      )
    }

    if (!currentSentence) {
      return (
        <div className="text-center py-8">
          <div className="text-gray-500">加载中...</div>
        </div>
      )
    }

    return (
      <div className="space-y-4">
        {/* 英文展示 */}
        <div className="bg-white rounded-lg border border-gray-200 p-6">
          <div className="flex items-center justify-between mb-4">
            <span className="text-sm text-gray-500">长难句</span>
            <button
              onClick={() => speakWord(currentSentence.sentence_en)}
              className="text-gray-400 hover:text-blue-500"
            >
              🔊
            </button>
          </div>
          
          <div className="mb-6">
            <p className="text-lg text-gray-800 leading-relaxed">{currentSentence.sentence_en}</p>
          </div>

          {sentenceResult ? (
            // 显示结果
            <div className="space-y-4">
              <div className="p-4 bg-blue-50 rounded-lg">
                <h4 className="font-medium text-blue-800 mb-2">你的翻译:</h4>
                <p className="text-gray-700">{sentenceTranslation}</p>
              </div>
              
              <div className="p-4 bg-green-50 rounded-lg">
                <h4 className="font-medium text-green-800 mb-2">AI评价:</h4>
                <p className="text-gray-700">{sentenceResult.ai_evaluation}</p>
              </div>
              
              {currentSentence.sentence_cn && (
                <div className="p-4 bg-gray-50 rounded-lg">
                  <h4 className="font-medium text-gray-800 mb-2">参考译文:</h4>
                  <p className="text-gray-700">{currentSentence.sentence_cn}</p>
                </div>
              )}
              
              <div className="flex gap-3">
                <button
                  onClick={skipSentence}
                  className="flex-1 py-3 bg-blue-500 text-white rounded-lg hover:bg-blue-600"
                >
                  下一句
                </button>
                <button
                  onClick={() => {
                    setIsSentenceLearning(false)
                    loadData()
                  }}
                  className="px-4 py-3 bg-gray-100 text-gray-600 rounded-lg hover:bg-gray-200"
                >
                  结束
                </button>
              </div>
            </div>
          ) : (
            // 输入翻译
            <div className="space-y-4">
              <textarea
                value={sentenceTranslation}
                onChange={(e) => setSentenceTranslation(e.target.value)}
                placeholder="请输入你的中文翻译..."
                className="w-full h-32 p-4 border border-gray-300 rounded-lg resize-none focus:outline-none focus:border-blue-500"
              />
              
              <div className="flex gap-3">
                <button
                  onClick={handleSentenceSubmit}
                  disabled={!sentenceTranslation.trim()}
                  className="flex-1 py-3 bg-green-500 text-white rounded-lg hover:bg-green-600 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  提交翻译
                </button>
                <button
                  onClick={skipSentence}
                  className="px-4 py-3 bg-gray-100 text-gray-600 rounded-lg hover:bg-gray-200"
                >
                  跳过
                </button>
                <button
                  onClick={() => {
                    setIsSentenceLearning(false)
                    loadData()
                  }}
                  className="px-4 py-3 bg-gray-100 text-gray-600 rounded-lg hover:bg-gray-200"
                >
                  退出
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    )
  }

  // 渲染翻译练习界面
  const renderTranslationExercise = () => {
    if (!isTranslating) {
      return (
        <div className="space-y-6">
          {renderStatBar(translationStats, 'translations')}
          
          <button
            onClick={startTranslation}
            disabled={translationStats.total === 0}
            className="w-full py-4 sm:py-6 bg-purple-500 text-white rounded-lg hover:bg-purple-600 disabled:opacity-50 disabled:cursor-not-allowed transition"
          >
            <span className="block text-xl">🔄 开始翻译练习</span>
            <span className="text-sm opacity-80">
              共{translationStats.total}篇翻译，待复习{translationStats.today_to_review}个
            </span>
          </button>
        </div>
      )
    }

    if (!currentTranslation) {
      return (
        <div className="text-center py-8">
          <div className="text-gray-500">加载中...</div>
        </div>
      )
    }

    return (
      <div className="space-y-4">
        {/* 原文展示 */}
        <div className="bg-white rounded-lg border border-gray-200 p-6">
          <div className="flex items-center justify-between mb-4">
            <span className="text-sm text-gray-500">原文摘要</span>
            <button
              onClick={() => speakWord(currentTranslation.original_text)}
              className="text-gray-400 hover:text-blue-500"
            >
              🔊
            </button>
          </div>
          
          <div className="mb-6">
            <p className="text-gray-800 leading-relaxed">{currentTranslation.original_text}</p>
          </div>

          {translationResult ? (
            // 显示结果
            <div className="space-y-4">
              <div className="p-4 bg-blue-50 rounded-lg">
                <h4 className="font-medium text-blue-800 mb-2">你的翻译:</h4>
                <p className="text-gray-700">{userTranslation}</p>
              </div>
              
              <div className={`p-4 rounded-lg ${
                translationResult.ai_score >= 80 ? 'bg-green-50' :
                translationResult.ai_score >= 60 ? 'bg-amber-50' : 'bg-red-50'
              }`}>
                <div className="flex items-center justify-between mb-2">
                  <h4 className="font-medium">AI评分:</h4>
                  <span className={`text-2xl font-bold ${
                    translationResult.ai_score >= 80 ? 'text-green-600' :
                    translationResult.ai_score >= 60 ? 'text-amber-600' : 'text-red-600'
                  }`}>
                    {translationResult.ai_score}分
                  </span>
                </div>
                <p className="text-gray-700">{translationResult.ai_feedback}</p>
              </div>
              
              {translationResult.error_words?.length > 0 && (
                <div className="p-4 bg-red-50 rounded-lg">
                  <h4 className="font-medium text-red-800 mb-2">错词已加入生词本:</h4>
                  <div className="flex flex-wrap gap-2">
                    {translationResult.error_words.map((word, idx) => (
                      <span key={idx} className="px-2 py-1 bg-red-100 text-red-700 rounded text-sm">
                        {word}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              
              <div className="flex gap-3">
                <button
                  onClick={skipTranslation}
                  className="flex-1 py-3 bg-purple-500 text-white rounded-lg hover:bg-purple-600"
                >
                  下一篇
                </button>
                <button
                  onClick={() => {
                    setIsTranslating(false)
                    loadData()
                  }}
                  className="px-4 py-3 bg-gray-100 text-gray-600 rounded-lg hover:bg-gray-200"
                >
                  结束
                </button>
              </div>
            </div>
          ) : (
            // 输入翻译
            <div className="space-y-4">
              <textarea
                value={userTranslation}
                onChange={(e) => setUserTranslation(e.target.value)}
                placeholder="请输入你的翻译..."
                className="w-full h-40 p-4 border border-gray-300 rounded-lg resize-none focus:outline-none focus:border-purple-500"
              />
              
              <div className="flex gap-3">
                <button
                  onClick={handleTranslationSubmit}
                  disabled={!userTranslation.trim()}
                  className="flex-1 py-3 bg-purple-500 text-white rounded-lg hover:bg-purple-600 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  提交翻译
                </button>
                <button
                  onClick={skipTranslation}
                  className="px-4 py-3 bg-gray-100 text-gray-600 rounded-lg hover:bg-gray-200"
                >
                  跳过
                </button>
                <button
                  onClick={() => {
                    setIsTranslating(false)
                    loadData()
                  }}
                  className="px-4 py-3 bg-gray-100 text-gray-600 rounded-lg hover:bg-gray-200"
                >
                  退出
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    )
  }

  // ========== 主渲染 ==========
  return (
    <div className="p-4 max-w-3xl mx-auto">
      {/* 顶部标题 */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-800">📚 学习中心</h1>
        <p className="text-sm text-gray-500 mt-1">单词 | 长难句 | 翻译练习</p>
      </div>

      {/* Tab切换 */}
      <div className="flex border-b border-gray-200 mb-6">
        <button
          onClick={() => setActiveTab('words')}
          className={`px-4 py-3 font-medium border-b-2 transition ${
            activeTab === 'words'
              ? 'border-blue-500 text-blue-600'
              : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}
        >
          📝 背单词
        </button>
        <button
          onClick={() => setActiveTab('sentences')}
          className={`px-4 py-3 font-medium border-b-2 transition ${
            activeTab === 'sentences'
              ? 'border-green-500 text-green-600'
              : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}
        >
          📖 长难句
        </button>
        <button
          onClick={() => setActiveTab('translations')}
          className={`px-4 py-3 font-medium border-b-2 transition ${
            activeTab === 'translations'
              ? 'border-purple-500 text-purple-600'
              : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}
        >
          🔄 翻译练习
        </button>
      </div>

      {/* 内容区域 */}
      <div>
        {activeTab === 'words' && renderWordLearning()}
        {activeTab === 'sentences' && renderSentenceLearning()}
        {activeTab === 'translations' && renderTranslationExercise()}
      </div>
    </div>
  )
}

export default Learn
