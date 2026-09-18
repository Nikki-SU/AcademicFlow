"""
学习服务 - 完整的单词学习、长难句学习、翻译练习逻辑实现
艾宾浩斯复习间隔: [1, 3, 7, 14, 30, 60, 90, 180] 天
"""
import json
import random
from datetime import datetime, timedelta
from typing import List, Dict, Any, Optional, Tuple
from sqlalchemy.orm import Session

from models.learning import Word, LongSentence, TranslationCard, StudySession, StudySettings
from schemas.learning import (
    Question, QuestionResponse, AnswerResult,
    StudyStats, SentenceTranslationResult, TranslationResult
)


# 艾宾浩斯复习间隔（天）
ANKI_INTERVALS = [1, 3, 7, 14, 30, 60, 90, 180]

# 六种题型定义
QUESTION_TYPES = {
    "en_select_cn": {
        "name": "英选中",
        "question_field": "word_en",
        "answer_field": "word_cn",
        "question_label": "选择中文翻译"
    },
    "cn_select_en": {
        "name": "中选英",
        "question_field": "word_cn",
        "answer_field": "word_en",
        "question_label": "选择英文单词"
    },
    "en_select_def": {
        "name": "英选定义",
        "question_field": "word_en",
        "answer_field": "definition_cn",
        "question_label": "选择定义"
    },
    "def_select_en": {
        "name": "定义选英",
        "question_field": "definition_cn",
        "answer_field": "word_en",
        "question_label": "选择单词"
    },
    "sent_select_cn": {
        "name": "例句选中",
        "question_field": "sentence",
        "answer_field": "word_cn",
        "question_label": "选择中文翻译",
        "blank": True,
        "blank_word": "word_en"
    },
    "sent_select_def": {
        "name": "例句选定义",
        "question_field": "sentence",
        "answer_field": "definition_cn",
        "question_label": "选择定义",
        "blank": True,
        "blank_word": "word_en"
    },
}


class StudyService:
    """学习服务"""

    def __init__(self, db: Session):
        self.db = db

    # ========== 设置相关 ==========

    def get_or_create_settings(self) -> StudySettings:
        """获取或创建设置"""
        settings = self.db.query(StudySettings).first()
        if not settings:
            settings = StudySettings(
                word_queue_length=5,
                allow_zhan=True,
                master_count=12,
                question_types='["en_select_cn"]',
                voice_enabled=True
            )
            self.db.add(settings)
            self.db.commit()
            self.db.refresh(settings)
        return settings

    def update_settings(self, **kwargs) -> StudySettings:
        """更新设置"""
        settings = self.get_or_create_settings()
        for key, value in kwargs.items():
            if hasattr(settings, key):
                # 处理 question_types 列表
                if key == "question_types":
                    value = json.dumps(value) if isinstance(value, list) else value
                setattr(settings, key, value)
        self.db.commit()
        self.db.refresh(settings)
        return settings

    # ========== 艾宾浩斯相关 ==========

    def calculate_next_review(self, stage: int) -> Optional[datetime]:
        """根据艾宾浩斯阶段计算下次复习时间"""
        if stage >= len(ANKI_INTERVALS):
            return None  # 已掌握，无需复习
        days = ANKI_INTERVALS[stage]
        return datetime.now() + timedelta(days=days)

    def advance_ebbinghaus(self, word: Word) -> Tuple[int, Optional[datetime]]:
        """推进艾宾浩斯阶段，返回(新阶段, 下次复习时间)"""
        new_stage = min(word.ebbinghaus_stage + 1, len(ANKI_INTERVALS) - 1)
        next_review = self.calculate_next_review(new_stage)
        return new_stage, next_review

    # ========== 单词队列相关 ==========

    def get_learning_queue(self, queue_length: int) -> List[int]:
        """
        获取学习队列
        优先级: learning状态 > new状态
        """
        # 1. 先取learning状态的词（已开始但未完成）
        learning_words = self.db.query(Word).filter(
            Word.status == "learning"
        ).order_by(Word.updated_at.asc()).limit(queue_length).all()

        queue = [w.id for w in learning_words]

        # 2. 如果不足，补充new状态的词
        if len(queue) < queue_length:
            need_more = queue_length - len(queue)
            new_words = self.db.query(Word).filter(
                Word.status == "new"
            ).order_by(Word.created_at.asc()).limit(need_more).all()
            queue.extend([w.id for w in new_words])

        return queue

    def get_review_queue(self, queue_length: int = 20) -> List[int]:
        """
        获取复习队列
        取learned/mastered状态且到达复习时间的词
        """
        now = datetime.now()
        due_words = self.db.query(Word).filter(
            Word.status.in_(["learned", "mastered"]),
            Word.next_review != None,
            Word.next_review <= now
        ).order_by(Word.next_review.asc()).limit(queue_length).all()

        return [w.id for w in due_words]

    def get_error_book_queue(self, queue_length: int = 20) -> List[int]:
        """获取错词本队列（错3次以上）"""
        error_words = self.db.query(Word).filter(
            Word.wrong_count >= 3
        ).order_by(Word.wrong_count.desc()).limit(queue_length).all()

        return [w.id for w in error_words]

    def get_word_stats(self) -> StudyStats:
        """获取单词学习统计"""
        stats = StudyStats(
            total=self.db.query(Word).count(),
            new=self.db.query(Word).filter(Word.status == "new").count(),
            learning=self.db.query(Word).filter(Word.status == "learning").count(),
            learned=self.db.query(Word).filter(Word.status == "learned").count(),
            mastered=self.db.query(Word).filter(Word.status == "mastered").count(),
            error_book=self.db.query(Word).filter(Word.wrong_count >= 3).count(),
        )
        
        # 计算今天需要复习的词
        now = datetime.now()
        today_due = self.db.query(Word).filter(
            Word.status.in_(["learned", "mastered"]),
            Word.next_review != None,
            Word.next_review <= now
        ).count()
        stats.today_to_review = today_due
        
        return stats

    # ========== 题目生成 ==========

    def generate_question(
        self,
        word_id: int,
        q_type: str,
        mode: str,
        all_word_ids: List[int]
    ) -> Optional[Question]:
        """生成一道题目"""
        word = self.db.query(Word).filter(Word.id == word_id).first()
        if not word:
            return None

        type_config = QUESTION_TYPES.get(q_type)
        if not type_config:
            return None

        # 获取问题和答案字段
        question_field = type_config["question_field"]
        answer_field = type_config["answer_field"]

        # 复习时定义题型用英文定义
        if q_type in ["en_select_def", "sent_select_def"] and mode == "review":
            answer_field = "definition_en"

        # 获取值
        question_value = getattr(word, question_field, "") or ""
        correct_answer = getattr(word, answer_field, "") or ""

        # 检查是否有值，没有则跳过
        if not question_value or not correct_answer:
            return None

        # 例句题型需要挖空
        if type_config.get("blank"):
            blank_word = getattr(word, type_config.get("blank_word", "word_en"), "") or ""
            if blank_word:
                question_value = question_value.replace(blank_word, "_____", 1)

        # 生成干扰项
        distractors = self._generate_distractors(
            correct_answer, all_word_ids, answer_field, exclude_word_id=word_id
        )

        # 组合选项（1正确 + 3干扰）
        options = [correct_answer] + distractors[:3]
        random.shuffle(options)

        return Question(
            word_id=word_id,
            type=q_type,
            type_name=type_config["name"],
            question=question_value,
            options=options,
            correct_answer=correct_answer,
            word_data={
                "word_en": word.word_en,
                "word_cn": word.word_cn,
                "definition_en": word.definition_en,
                "definition_cn": word.definition_cn,
                "sentence": word.sentence
            }
        )

    def _generate_distractors(
        self,
        correct: str,
        all_word_ids: List[int],
        field: str,
        exclude_word_id: int,
        count: int = 3
    ) -> List[str]:
        """生成干扰项"""
        distractors = []
        candidates = self.db.query(Word).filter(
            Word.id.in_([wid for wid in all_word_ids if wid != exclude_word_id])
        ).all()

        for word in candidates:
            value = getattr(word, field, "") or ""
            if value and value.strip() and value != correct and value not in distractors:
                distractors.append(value)
                if len(distractors) >= count:
                    break

        return distractors

    # ========== 学习会话 ==========

    def start_study_session(
        self,
        mode: str,
        queue_length: int,
        selected_types: List[str]
    ) -> StudySession:
        """开始学习会话"""
        # 获取队列
        if mode == "learn":
            queue = self.get_learning_queue(queue_length)
        elif mode == "review":
            queue = self.get_review_queue(queue_length)
        else:  # error_book
            queue = self.get_error_book_queue(queue_length)

        if not queue:
            raise ValueError("没有可用的单词")

        # 清理旧会话
        self.db.query(StudySession).filter(StudySession.is_active == True).update({
            "is_active": False
        })

        # 创建新会话
        first_type = selected_types[0] if selected_types else "en_select_cn"
        session = StudySession(
            mode=mode,
            queue_length=queue_length,
            selected_types=json.dumps(selected_types),
            queue=json.dumps(queue),
            current_word_idx=0,
            current_type=first_type,
            wrong_queue=json.dumps([]),
            completed_words_in_type=json.dumps([]),
            is_active=True
        )
        self.db.add(session)
        self.db.commit()
        self.db.refresh(session)

        return session

    def get_current_question(self, session_id: int) -> Optional[QuestionResponse]:
        """获取当前题目"""
        session = self.db.query(StudySession).filter(
            StudySession.id == session_id,
            StudySession.is_active == True
        ).first()

        if not session:
            return None

        queue = json.loads(session.queue) if isinstance(session.queue, str) else session.queue
        wrong_queue = json.loads(session.wrong_queue) if isinstance(session.wrong_queue, str) else session.wrong_queue

        if not queue:
            return None

        # 如果有错题队列，优先做错题
        current_word_id = wrong_queue[0] if wrong_queue else queue[session.current_word_idx]

        question = self.generate_question(
            current_word_id,
            session.current_type,
            session.mode,
            queue
        )

        return QuestionResponse(
            session_id=session.id,
            mode=session.mode,
            total_words=len(queue),
            current_idx=session.current_word_idx + 1,
            current_type=session.current_type,
            type_name=QUESTION_TYPES.get(session.current_type, {}).get("name", ""),
            question=question,
            is_retry=len(wrong_queue) > 0
        )

    def submit_answer(
        self,
        session_id: int,
        word_id: int,
        selected: str
    ) -> AnswerResult:
        """提交答案"""
        session = self.db.query(StudySession).filter(
            StudySession.id == session_id,
            StudySession.is_active == True
        ).first()

        if not session:
            raise ValueError("会话不存在或已结束")

        queue = json.loads(session.queue) if isinstance(session.queue, str) else session.queue
        wrong_queue = json.loads(session.wrong_queue) if isinstance(session.wrong_queue, str) else session.wrong_queue
        completed = json.loads(session.completed_words_in_type) if isinstance(session.completed_words_in_type, str) else session.completed_words_in_type
        selected_types = json.loads(session.selected_types) if isinstance(session.selected_types, str) else session.selected_types

        # 获取题目
        question = self.generate_question(
            word_id, session.current_type, session.mode, queue
        )

        if not question:
            raise ValueError("题目生成失败")

        is_correct = (selected == question.correct_answer)

        # 获取单词
        word = self.db.query(Word).filter(Word.id == word_id).first()
        if not word:
            raise ValueError("单词不存在")

        # 获取设置
        settings = self.get_or_create_settings()
        master_count = settings.master_count

        # 解析已完成的题型
        try:
            correct_types = json.loads(word.correct_types) if isinstance(word.correct_types, str) else word.correct_types
        except:
            correct_types = []

        if is_correct:
            # ========== 答对 ==========
            
            # 从错题队列移除
            if word_id in wrong_queue:
                wrong_queue.remove(word_id)
                session.wrong_queue = json.dumps(wrong_queue)

            # 更新连续正确次数
            word.streak += 1

            # 记录答对的题型
            if session.current_type not in correct_types:
                correct_types.append(session.current_type)
                word.correct_types = json.dumps(correct_types)

            # 检查是否完成本轮所有题型
            all_types_completed = all(t in correct_types for t in selected_types)

            # 第一阶段完成条件（学习模式 + 题型全部完成）
            if all_types_completed and session.mode == "learn":
                # 推进艾宾浩斯
                new_stage, next_review = self.advance_ebbinghaus(word)
                word.ebbinghaus_stage = new_stage
                word.next_review = next_review
                word.last_review = datetime.now()
                word.status = "learned" if word.status != "mastered" else "mastered"

                # 检查是否掌握（连续正确次数达标）
                if word.streak >= master_count:
                    word.status = "mastered"
                    word.ebbinghaus_stage = len(ANKI_INTERVALS) - 1
                    word.next_review = None

            # 如果是重做题，加入完成列表
            if word_id not in completed:
                completed.append(word_id)
                session.completed_words_in_type = json.dumps(completed)

            # 检查当前题型是否完成
            type_finished = len(completed) >= len(queue)

            # 检查会话是否结束
            session_finished = (
                type_finished and 
                selected_types.index(session.current_type) >= len(selected_types) - 1
            )

            if session_finished:
                session.is_active = False

            self.db.commit()

            return AnswerResult(
                is_correct=True,
                show_card=False,
                correct_answer=question.correct_answer,
                word_status=word.status,
                streak=word.streak,
                type_finished=type_finished,
                session_finished=session_finished,
                all_types_completed=all_types_completed
            )

        else:
            # ========== 答错 ==========
            
            # 重置连续正确次数
            word.streak = 0
            
            # 错误次数+1
            word.wrong_count += 1
            
            # 标记需要显示卡片（学习模式第一阶段）
            show_card = (session.mode == "learn" and session.current_type == selected_types[0] and not word.card_shown)
            
            if show_card:
                word.card_shown = True
                word.status = "learning"

            # 加入错题队列（如果还没在）
            if word_id not in wrong_queue:
                wrong_queue.append(word_id)
                session.wrong_queue = json.dumps(wrong_queue)

            self.db.commit()

            return AnswerResult(
                is_correct=False,
                show_card=show_card,
                correct_answer=question.correct_answer,
                card_data=question.word_data,
                word_status=word.status,
                streak=word.streak,
                type_finished=False,
                session_finished=False
            )

    def next_question(self, session_id: int) -> Optional[QuestionResponse]:
        """切换到下一题"""
        session = self.db.query(StudySession).filter(
            StudySession.id == session_id,
            StudySession.is_active == True
        ).first()

        if not session:
            return None

        queue = json.loads(session.queue) if isinstance(session.queue, str) else session.queue
        wrong_queue = json.loads(session.wrong_queue) if isinstance(session.wrong_queue, str) else session.wrong_queue
        selected_types = json.loads(session.selected_types) if isinstance(session.selected_types, str) else session.selected_types

        # 如果还有错题，继续做错题
        if wrong_queue:
            return self.get_current_question(session_id)

        # 当前题型已完成所有词
        if session.current_word_idx >= len(queue) - 1:
            # 检查是否还有下一题型
            current_type_idx = selected_types.index(session.current_type) if session.current_type in selected_types else 0
            if current_type_idx < len(selected_types) - 1:
                # 切换到下一题型
                session.current_type = selected_types[current_type_idx + 1]
                session.current_word_idx = 0
                session.completed_words_in_type = json.dumps([])
                session.wrong_queue = json.dumps([])
                self.db.commit()
                return self.get_current_question(session_id)
            else:
                # 所有题型完成，结束会话
                session.is_active = False
                self.db.commit()
                return None
        else:
            # 同一题型的下一词
            session.current_word_idx += 1
            self.db.commit()
            return self.get_current_question(session_id)

    def zhan_word(self, word_id: int) -> Word:
        """斩词（直接标记为已掌握）"""
        settings = self.get_or_create_settings()
        if not settings.allow_zhan:
            raise ValueError("当前设置不允许斩词")

        word = self.db.query(Word).filter(Word.id == word_id).first()
        if not word:
            raise ValueError("单词不存在")

        word.status = "mastered"
        word.streak = settings.master_count
        word.ebbinghaus_stage = len(ANKI_INTERVALS) - 1
        word.next_review = None
        self.db.commit()
        self.db.refresh(word)

        return word

    # ========== 长难句学习 ==========

    def get_sentence_stats(self) -> Dict:
        """获取长难句统计"""
        return {
            "total": self.db.query(LongSentence).count(),
            "new": self.db.query(LongSentence).filter(LongSentence.status == "new").count(),
            "learning": self.db.query(LongSentence).filter(LongSentence.status == "learning").count(),
            "mastered": self.db.query(LongSentence).filter(LongSentence.status == "mastered").count(),
            "today_to_review": self.db.query(LongSentence).filter(
                LongSentence.status == "mastered",
                LongSentence.next_review != None,
                LongSentence.next_review <= datetime.now()
            ).count()
        }

    def get_due_sentences(self, limit: int = 10) -> List[LongSentence]:
        """获取到期复习的长难句"""
        return self.db.query(LongSentence).filter(
            LongSentence.next_review != None,
            LongSentence.next_review <= datetime.now()
        ).order_by(LongSentence.next_review.asc()).limit(limit).all()

    def submit_sentence_translation(
        self,
        sentence_id: int,
        translation: str,
        ai_evaluation: str = None
    ) -> SentenceTranslationResult:
        """提交长难句翻译"""
        sentence = self.db.query(LongSentence).filter(LongSentence.id == sentence_id).first()
        if not sentence:
            raise ValueError("长难句不存在")

        # 更新状态
        sentence.status = "mastered"
        new_stage, next_review = self.calculate_next_review(sentence.ebbinghaus_stage + 1)
        sentence.ebbinghaus_stage = new_stage
        sentence.next_review = next_review
        sentence.last_review = datetime.now()

        self.db.commit()

        return SentenceTranslationResult(
            sentence_id=sentence_id,
            ai_evaluation=ai_evaluation or "翻译已保存",
            is_correct=True
        )

    def mark_sentence_mastered(self, sentence_id: int) -> LongSentence:
        """标记长难句为已掌握"""
        sentence = self.db.query(LongSentence).filter(LongSentence.id == sentence_id).first()
        if not sentence:
            raise ValueError("长难句不存在")

        sentence.status = "mastered"
        sentence.ebbinghaus_stage = len(ANKI_INTERVALS) - 1
        sentence.next_review = None
        sentence.last_review = datetime.now()

        self.db.commit()
        self.db.refresh(sentence)

        return sentence

    # ========== 翻译练习 ==========

    def get_translation_stats(self) -> Dict:
        """获取翻译练习统计"""
        return {
            "total": self.db.query(TranslationCard).count(),
            "pending": self.db.query(TranslationCard).filter(
                TranslationCard.user_translation == None
            ).count(),
            "completed": self.db.query(TranslationCard).filter(
                TranslationCard.user_translation != None
            ).count(),
            "today_to_review": self.db.query(TranslationCard).filter(
                TranslationCard.next_review != None,
                TranslationCard.next_review <= datetime.now()
            ).count()
        }

    def get_due_translations(self, limit: int = 10) -> List[TranslationCard]:
        """获取到期复习的翻译练习"""
        return self.db.query(TranslationCard).filter(
            TranslationCard.next_review != None,
            TranslationCard.next_review <= datetime.now()
        ).order_by(TranslationCard.next_review.asc()).limit(limit).all()

    def submit_translation(
        self,
        card_id: int,
        translation: str,
        ai_score: int = None,
        ai_feedback: str = None,
        error_words: List[str] = None
    ) -> TranslationResult:
        """提交翻译练习"""
        card = self.db.query(TranslationCard).filter(TranslationCard.id == card_id).first()
        if not card:
            raise ValueError("翻译卡片不存在")

        # 更新卡片
        card.user_translation = translation
        card.ai_score = ai_score
        card.ai_feedback = ai_feedback
        card.error_words = error_words or []

        # 将错误词汇加入生词本
        if error_words:
            for word_text in error_words:
                existing = self.db.query(Word).filter(Word.word_en == word_text).first()
                if not existing:
                    new_word = Word(
                        word_en=word_text,
                        status="new",
                        wrong_count=3  # 翻译中出错的词直接标记为错词
                    )
                    self.db.add(new_word)

        # 推进艾宾浩斯
        new_stage, next_review = self.calculate_next_review(card.ebbinghaus_stage + 1)
        card.ebbinghaus_stage = new_stage
        card.next_review = next_review
        card.last_review = datetime.now()

        self.db.commit()

        return TranslationResult(
            card_id=card_id,
            ai_score=ai_score or 0,
            ai_feedback=ai_feedback or "翻译已保存",
            error_words=error_words or [],
            next_review_at=next_review
        )
