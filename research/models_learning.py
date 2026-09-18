"""
学习相关模型 - 包含单词学习、长难句学习、翻译练习的完整数据模型
"""
from sqlalchemy import Column, Integer, String, Text, DateTime, Boolean, JSON
from sqlalchemy.sql import func
from database import Base


class Word(Base):
    """单词"""
    __tablename__ = "words"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    word_en = Column(String(255), nullable=False)
    word_cn = Column(String(255), nullable=True)
    definition_en = Column(Text, nullable=True)
    definition_cn = Column(Text, nullable=True)
    sentence = Column(Text, nullable=True)
    doi = Column(String(255), nullable=True, index=True)
    status = Column(String(20), default="new")  # new/learning/learned/mastered
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
    
    # 学习进度字段
    streak = Column(Integer, default=0)  # 连续正确次数
    wrong_count = Column(Integer, default=0)  # 错误次数
    card_shown = Column(Boolean, default=False)  # 第一阶段是否已展示卡片
    correct_types = Column(Text, default='[]')  # 已答对的题型JSON数组
    ebbinghaus_stage = Column(Integer, default=0)  # 当前艾宾浩斯阶段0-7
    next_review = Column(DateTime(timezone=True), nullable=True)  # 下次复习时间
    last_review = Column(DateTime(timezone=True), nullable=True)  # 上次复习时间


class LongSentence(Base):
    """长难句"""
    __tablename__ = "long_sentences"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    sentence_en = Column(Text, nullable=False)
    sentence_cn = Column(Text, nullable=True)
    doi = Column(String(255), nullable=True, index=True)
    status = Column(String(20), default="new")  # new/learning/mastered
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
    
    # 学习进度字段
    ebbinghaus_stage = Column(Integer, default=0)  # 当前艾宾浩斯阶段0-7
    next_review = Column(DateTime(timezone=True), nullable=True)  # 下次复习时间
    last_review = Column(DateTime(timezone=True), nullable=True)  # 上次复习时间


class TranslationCard(Base):
    """翻译练习卡片"""
    __tablename__ = "translation_cards"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    doi = Column(String(255), nullable=True, index=True)
    original_text = Column(Text, nullable=False)
    user_translation = Column(Text, nullable=True)
    ai_score = Column(Integer, nullable=True)  # AI评分 0-100
    ai_feedback = Column(Text, nullable=True)  # AI评价
    error_words = Column(JSON, nullable=True)  # 错词列表(加入生词本)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
    
    # 学习进度字段
    ebbinghaus_stage = Column(Integer, default=0)  # 当前艾宾浩斯阶段0-7
    next_review = Column(DateTime(timezone=True), nullable=True)  # 下次复习时间
    last_review = Column(DateTime(timezone=True), nullable=True)  # 上次复习时间


class WordList(Base):
    """单词表"""
    __tablename__ = "word_lists"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    name = Column(String(255), nullable=False)
    doi = Column(String(255), nullable=True, index=True)
    word_ids = Column(JSON, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class SentenceList(Base):
    """长难句表"""
    __tablename__ = "sentence_lists"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    name = Column(String(255), nullable=False)
    doi = Column(String(255), nullable=True, index=True)
    sentence_ids = Column(JSON, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class StudySession(Base):
    """学习会话"""
    __tablename__ = "study_sessions"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    mode = Column(String(20), default="learn")  # learn/review/error_book
    queue_length = Column(Integer, default=5)
    selected_types = Column(Text, default='["en_select_cn"]')  # JSON数组
    queue = Column(Text, default='[]')  # JSON数组-词ID列表
    current_word_idx = Column(Integer, default=0)
    current_type = Column(String(50), default="en_select_cn")
    wrong_queue = Column(Text, default='[]')  # JSON数组
    completed_words_in_type = Column(Text, default='[]')  # JSON数组
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class StudySettings(Base):
    """学习设置"""
    __tablename__ = "study_settings"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    word_queue_length = Column(Integer, default=5)  # 队列长度
    allow_zhan = Column(Boolean, default=True)  # 允许斩功能
    master_count = Column(Integer, default=12)  # 掌握条件-连续正确次数
    question_types = Column(Text, default='["en_select_cn"]')  # 启用的题型
    voice_enabled = Column(Boolean, default=True)  # 朗读发音开关
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class SentenceStudyStatus(Base):
    """长难句学习状态"""
    __tablename__ = "sentence_study_status"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    sentence_id = Column(Integer, nullable=False, index=True)
    status = Column(String(20), default="new")  # new/studying/learned/mastered
    review_stage = Column(Integer, default=0)  # 当前复习阶段
    next_review_at = Column(DateTime(timezone=True), nullable=True)  # 下次复习时间
    last_review_at = Column(DateTime(timezone=True), nullable=True)  # 上次复习时间
    learned_at = Column(DateTime(timezone=True), nullable=True)  # 学习完成时间
    mastered_at = Column(DateTime(timezone=True), nullable=True)  # 掌握时间
    error_count = Column(Integer, default=0)  # 错误次数
    in_error_book = Column(Boolean, default=False)  # 是否在错题本
    card_shown = Column(Boolean, default=False)  # 是否已展示卡片
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
