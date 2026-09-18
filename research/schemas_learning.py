"""学习相关 Schema - 完整的请求和响应模型定义"""
from pydantic import BaseModel
from typing import Optional, List
from datetime import datetime


# ========== Word Schemas ==========

class WordBase(BaseModel):
    word_en: str
    word_cn: Optional[str] = None
    definition_en: Optional[str] = None
    definition_cn: Optional[str] = None
    sentence: Optional[str] = None
    doi: Optional[str] = None


class WordCreate(WordBase):
    pass


class WordUpdate(BaseModel):
    word_en: Optional[str] = None
    word_cn: Optional[str] = None
    definition_en: Optional[str] = None
    definition_cn: Optional[str] = None
    sentence: Optional[str] = None
    doi: Optional[str] = None
    status: Optional[str] = None
    streak: Optional[int] = None
    wrong_count: Optional[int] = None
    card_shown: Optional[bool] = None
    correct_types: Optional[List[str]] = None
    ebbinghaus_stage: Optional[int] = None
    next_review: Optional[datetime] = None
    last_review: Optional[datetime] = None


class WordResponse(WordBase):
    id: int
    status: str = "new"
    streak: int = 0
    wrong_count: int = 0
    card_shown: bool = False
    correct_types: List[str] = []
    ebbinghaus_stage: int = 0
    next_review: Optional[datetime] = None
    last_review: Optional[datetime] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True


# ========== LongSentence Schemas ==========

class LongSentenceBase(BaseModel):
    sentence_en: str
    sentence_cn: Optional[str] = None
    doi: Optional[str] = None


class LongSentenceCreate(LongSentenceBase):
    pass


class LongSentenceUpdate(BaseModel):
    sentence_en: Optional[str] = None
    sentence_cn: Optional[str] = None
    doi: Optional[str] = None
    status: Optional[str] = None
    ebbinghaus_stage: Optional[int] = None
    next_review: Optional[datetime] = None
    last_review: Optional[datetime] = None


class LongSentenceResponse(LongSentenceBase):
    id: int
    status: str = "new"
    ebbinghaus_stage: int = 0
    next_review: Optional[datetime] = None
    last_review: Optional[datetime] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True


# ========== TranslationCard Schemas ==========

class TranslationCardBase(BaseModel):
    doi: Optional[str] = None
    original_text: str


class TranslationCardCreate(TranslationCardBase):
    pass


class TranslationCardUpdate(BaseModel):
    doi: Optional[str] = None
    original_text: Optional[str] = None
    user_translation: Optional[str] = None
    ai_score: Optional[int] = None
    ai_feedback: Optional[str] = None
    error_words: Optional[List[str]] = None
    ebbinghaus_stage: Optional[int] = None
    next_review: Optional[datetime] = None
    last_review: Optional[datetime] = None


class TranslationCardResponse(TranslationCardBase):
    id: int
    user_translation: Optional[str] = None
    ai_score: Optional[int] = None
    ai_feedback: Optional[str] = None
    error_words: Optional[List[str]] = None
    ebbinghaus_stage: int = 0
    next_review: Optional[datetime] = None
    last_review: Optional[datetime] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True


# ========== WordList Schemas ==========

class WordListBase(BaseModel):
    name: str
    doi: Optional[str] = None
    word_ids: Optional[List[int]] = None


class WordListCreate(WordListBase):
    pass


class WordListUpdate(BaseModel):
    name: Optional[str] = None
    doi: Optional[str] = None
    word_ids: Optional[List[int]] = None


class WordListResponse(WordListBase):
    id: int
    created_at: Optional[datetime] = None

    class Config:
        from_attributes = True


# ========== SentenceList Schemas ==========

class SentenceListBase(BaseModel):
    name: str
    doi: Optional[str] = None
    sentence_ids: Optional[List[int]] = None


class SentenceListCreate(SentenceListBase):
    pass


class SentenceListUpdate(BaseModel):
    name: Optional[str] = None
    doi: Optional[str] = None
    sentence_ids: Optional[List[int]] = None


class SentenceListResponse(SentenceListBase):
    id: int
    created_at: Optional[datetime] = None

    class Config:
        from_attributes = True


# ========== StudySession Schemas ==========

class StudySessionBase(BaseModel):
    mode: str = "learn"
    queue_length: int = 5
    selected_types: List[str] = ["en_select_cn"]


class StudySessionCreate(StudySessionBase):
    pass


class StudySessionResponse(BaseModel):
    id: int
    mode: str
    queue_length: int
    selected_types: List[str]
    queue: List[int]
    current_word_idx: int
    current_type: str
    wrong_queue: List[int]
    completed_words_in_type: List[int]
    is_active: bool
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True


# ========== StudySettings Schemas ==========

class StudySettingsBase(BaseModel):
    word_queue_length: int = 5
    allow_zhan: bool = True
    master_count: int = 12
    question_types: List[str] = ["en_select_cn"]
    voice_enabled: bool = True


class StudySettingsUpdate(BaseModel):
    word_queue_length: Optional[int] = None
    allow_zhan: Optional[bool] = None
    master_count: Optional[int] = None
    question_types: Optional[List[str]] = None
    voice_enabled: Optional[bool] = None


class StudySettingsResponse(StudySettingsBase):
    id: int
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True


# ========== Learning Question Schemas ==========

class QuestionOption(BaseModel):
    """题目选项"""
    key: str  # A, B, C, D
    value: str
    is_correct: bool = False


class Question(BaseModel):
    """题目"""
    word_id: int
    type: str  # 题型
    type_name: str  # 题型名称
    question: str  # 题目内容
    options: List[str]  # 选项列表
    correct_answer: str  # 正确答案
    word_data: dict  # 单词完整数据（用于显示卡片）
    is_retry: bool = False  # 是否是重做题


class QuestionResponse(BaseModel):
    """题目响应"""
    session_id: int
    mode: str
    total_words: int
    current_idx: int
    current_type: str
    type_name: str
    question: Optional[Question] = None
    is_retry: bool = False


class AnswerSubmit(BaseModel):
    """提交答案"""
    word_id: int
    selected: str  # 选择的答案
    session_id: int


class AnswerResult(BaseModel):
    """答案结果"""
    is_correct: bool
    show_card: bool = False
    correct_answer: Optional[str] = None
    card_data: Optional[dict] = None
    word_status: str = "new"
    streak: int = 0
    type_finished: bool = False
    session_finished: bool = False
    all_types_completed: bool = False


# ========== Study Stats Schemas ==========

class StudyStats(BaseModel):
    """学习统计"""
    total: int = 0
    new: int = 0
    learning: int = 0
    learned: int = 0
    mastered: int = 0
    error_book: int = 0
    today_to_review: int = 0


# ========== Sentence Translation Schemas ==========

class SentenceTranslationSubmit(BaseModel):
    """提交长难句翻译"""
    sentence_id: int
    translation: str


class SentenceTranslationResult(BaseModel):
    """长难句翻译结果"""
    sentence_id: int
    ai_evaluation: str  # AI评价
    is_correct: Optional[bool] = None


class SentenceDueResponse(BaseModel):
    """长难句到期响应"""
    sentence: LongSentenceResponse
    need_translate: bool = True


# ========== Translation Exercise Schemas ==========

class TranslationSubmit(BaseModel):
    """提交翻译练习"""
    card_id: int
    translation: str


class TranslationResult(BaseModel):
    """翻译练习结果"""
    card_id: int
    ai_score: int  # 0-100
    ai_feedback: str  # AI评价和错误分析
    error_words: List[str] = []  # 错词列表，已加入生词本
    next_review_at: Optional[datetime] = None


class TranslationDueResponse(BaseModel):
    """翻译练习到期响应"""
    card: TranslationCardResponse
    need_translate: bool = True
