"""学习相关 API 路由 - 包含单词学习、长难句学习、翻译练习的完整API"""
from fastapi import APIRouter, Depends, HTTPException, Path, Body
from sqlalchemy.orm import Session
from typing import List, Optional
from datetime import datetime

from database import get_db
from models.learning import Word, LongSentence, TranslationCard, WordList, SentenceList, StudySession, StudySettings
from schemas.learning import (
    WordCreate, WordUpdate, WordResponse,
    LongSentenceCreate, LongSentenceUpdate, LongSentenceResponse,
    TranslationCardCreate, TranslationCardUpdate, TranslationCardResponse,
    WordListCreate, WordListUpdate, WordListResponse,
    SentenceListCreate, SentenceListUpdate, SentenceListResponse,
    StudySettingsBase, StudySettingsUpdate, StudySettingsResponse,
    QuestionResponse, AnswerSubmit, AnswerResult, StudyStats,
    SentenceTranslationSubmit, SentenceTranslationResult, SentenceDueResponse,
    TranslationSubmit, TranslationResult, TranslationDueResponse
)
from services.study_service import StudyService, QUESTION_TYPES

router = APIRouter(prefix="/learning", tags=["学习"])

# ========== 学习服务依赖 ==========

def get_study_service(db: Session = Depends(get_db)) -> StudyService:
    return StudyService(db)


def get_settings_data(db: Session = Depends(get_db)) -> dict:
    """获取学习设置的依赖函数"""
    service = StudyService(db)
    settings = service.get_or_create_settings()
    return {
        "id": settings.id,
        "word_queue_length": settings.word_queue_length,
        "allow_zhan": settings.allow_zhan,
        "master_count": settings.master_count,
        "question_types": settings.question_types if isinstance(settings.question_types, list) else [],
        "voice_enabled": settings.voice_enabled,
        "created_at": settings.created_at,
        "updated_at": settings.updated_at
    }


# ========== 设置 API ==========

@router.get("/settings", response_model=StudySettingsResponse)
def get_settings(service: StudyService = Depends(get_study_service)):
    """获取学习设置"""
    settings = service.get_or_create_settings()
    return StudySettingsResponse(
        id=settings.id,
        word_queue_length=settings.word_queue_length,
        allow_zhan=settings.allow_zhan,
        master_count=settings.master_count,
        question_types=settings.question_types if isinstance(settings.question_types, list) else [],
        voice_enabled=settings.voice_enabled,
        created_at=settings.created_at,
        updated_at=settings.updated_at
    )


@router.put("/settings", response_model=StudySettingsResponse)
def update_settings(
    data: StudySettingsUpdate,
    service: StudyService = Depends(get_study_service)
):
    """更新学习设置"""
    update_data = data.model_dump(exclude_unset=True)
    settings = service.update_settings(**update_data)
    return StudySettingsResponse(
        id=settings.id,
        word_queue_length=settings.word_queue_length,
        allow_zhan=settings.allow_zhan,
        master_count=settings.master_count,
        question_types=settings.question_types if isinstance(settings.question_types, list) else [],
        voice_enabled=settings.voice_enabled,
        created_at=settings.created_at,
        updated_at=settings.updated_at
    )


@router.get("/question-types")
def get_question_types():
    """获取所有题型定义"""
    return [
        {"key": key, "name": config["name"], "label": config.get("question_label", "")}
        for key, config in QUESTION_TYPES.items()
    ]


# ========== 单词统计 API ==========

@router.get("/words/stats", response_model=StudyStats)
def get_word_stats(service: StudyService = Depends(get_study_service)):
    """获取单词学习统计"""
    return service.get_word_stats()


@router.get("/words/due")
def get_due_words(
    limit: int = 20,
    service: StudyService = Depends(get_study_service)
):
    """获取到期复习的单词"""
    return service.get_review_queue(limit)


# ========== 单词 CRUD ==========

@router.get("/words", response_model=List[WordResponse])
def list_words(
    skip: int = 0, 
    limit: int = 100, 
    status: str = None, 
    db: Session = Depends(get_db)
):
    """获取单词列表"""
    query = db.query(Word)
    if status:
        query = query.filter(Word.status == status)
    words = query.offset(skip).limit(limit).all()
    return [
        WordResponse(
            id=w.id,
            word_en=w.word_en,
            word_cn=w.word_cn,
            definition_en=w.definition_en,
            definition_cn=w.definition_cn,
            sentence=w.sentence,
            doi=w.doi,
            status=w.status,
            streak=w.streak,
            wrong_count=w.wrong_count,
            card_shown=w.card_shown,
            correct_types=w.correct_types if isinstance(w.correct_types, list) else [],
            ebbinghaus_stage=w.ebbinghaus_stage,
            next_review=w.next_review,
            last_review=w.last_review,
            created_at=w.created_at,
            updated_at=w.updated_at
        )
        for w in words
    ]


@router.get("/words/{word_id}", response_model=WordResponse)
def get_word(word_id: int = Path(...), db: Session = Depends(get_db)):
    """获取单词详情"""
    word = db.query(Word).filter(Word.id == word_id).first()
    if not word:
        raise HTTPException(status_code=404, detail="单词不存在")
    return WordResponse(
        id=word.id,
        word_en=word.word_en,
        word_cn=word.word_cn,
        definition_en=word.definition_en,
        definition_cn=word.definition_cn,
        sentence=word.sentence,
        doi=word.doi,
        status=word.status,
        streak=word.streak,
        wrong_count=word.wrong_count,
        card_shown=word.card_shown,
        correct_types=word.correct_types if isinstance(word.correct_types, list) else [],
        ebbinghaus_stage=word.ebbinghaus_stage,
        next_review=word.next_review,
        last_review=word.last_review,
        created_at=word.created_at,
        updated_at=word.updated_at
    )


@router.post("/words", response_model=WordResponse)
def create_word(data: WordCreate, db: Session = Depends(get_db)):
    """创建单词"""
    word = Word(**data.model_dump())
    db.add(word)
    db.commit()
    db.refresh(word)
    return WordResponse(
        id=word.id,
        word_en=word.word_en,
        word_cn=word.word_cn,
        definition_en=word.definition_en,
        definition_cn=word.definition_cn,
        sentence=word.sentence,
        doi=word.doi,
        status=word.status,
        streak=word.streak,
        wrong_count=word.wrong_count,
        card_shown=word.card_shown,
        correct_types=word.correct_types if isinstance(word.correct_types, list) else [],
        ebbinghaus_stage=word.ebbinghaus_stage,
        next_review=word.next_review,
        last_review=word.last_review,
        created_at=word.created_at,
        updated_at=word.updated_at
    )


@router.put("/words/{word_id}", response_model=WordResponse)
def update_word(word_id: int = Path(...), data: WordUpdate = Body(...), db: Session = Depends(get_db)):
    """更新单词"""
    word = db.query(Word).filter(Word.id == word_id).first()
    if not word:
        raise HTTPException(status_code=404, detail="单词不存在")
    
    update_data = data.model_dump(exclude_unset=True)
    for key, value in update_data.items():
        if key == "correct_types" and isinstance(value, list):
            import json
            value = json.dumps(value)
        setattr(word, key, value)
    
    db.commit()
    db.refresh(word)
    return WordResponse(
        id=word.id,
        word_en=word.word_en,
        word_cn=word.word_cn,
        definition_en=word.definition_en,
        definition_cn=word.definition_cn,
        sentence=word.sentence,
        doi=word.doi,
        status=word.status,
        streak=word.streak,
        wrong_count=word.wrong_count,
        card_shown=word.card_shown,
        correct_types=word.correct_types if isinstance(word.correct_types, list) else [],
        ebbinghaus_stage=word.ebbinghaus_stage,
        next_review=word.next_review,
        last_review=word.last_review,
        created_at=word.created_at,
        updated_at=word.updated_at
    )


@router.delete("/words/{word_id}")
def delete_word(word_id: int = Path(...), db: Session = Depends(get_db)):
    """删除单词"""
    word = db.query(Word).filter(Word.id == word_id).first()
    if not word:
        raise HTTPException(status_code=404, detail="单词不存在")
    db.delete(word)
    db.commit()
    return {"message": "删除成功"}


# ========== 单词学习会话 API ==========

@router.post("/words/start-study")
def start_word_study(
    mode: str = "learn",  # learn/review/error_book
    queue_length: int = 5,
    word_ids: Optional[List[int]] = None,
    service: StudyService = Depends(get_study_service),
    settings: dict = Depends(get_settings_data)
):
    """开始单词学习会话"""
    # 获取启用的题型
    selected_types = settings.question_types if settings.question_types else ["en_select_cn"]
    
    try:
        session = service.start_study_session(mode, queue_length, selected_types)
        question = service.get_current_question(session.id)
        return {
            "session_id": session.id,
            "mode": session.mode,
            "queue_length": session.queue_length,
            "selected_types": selected_types,
            "queue": session.queue if isinstance(session.queue, list) else [],
            "question": question.model_dump() if question else None,
            "settings": {
                "allow_zhan": settings.allow_zhan,
                "master_count": settings.master_count,
                "voice_enabled": settings.voice_enabled
            }
        }
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/words/current-question/{session_id}")
def get_current_question(
    session_id: int,
    service: StudyService = Depends(get_study_service)
):
    """获取当前题目"""
    question = service.get_current_question(session_id)
    if not question:
        return {"session_finished": True, "message": "学习完成"}
    return question.model_dump()


@router.post("/words/answer")
def submit_answer(
    data: AnswerSubmit,
    service: StudyService = Depends(get_study_service)
):
    """提交答案"""
    try:
        result = service.submit_answer(data.session_id, data.word_id, data.selected)
        return result.model_dump()
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/words/next/{session_id}")
def next_question(
    session_id: int = Path(...),
    service: StudyService = Depends(get_study_service)
):
    """下一题"""
    question = service.next_question(session_id)
    if not question:
        return {"session_finished": True, "message": "学习完成"}
    return question.model_dump()


@router.post("/words/zhan/{word_id}")
def zhan_word(
    word_id: int = Path(...),
    service: StudyService = Depends(get_study_service)
):
    """斩词"""
    try:
        word = service.zhan_word(word_id)
        return {
            "success": True,
            "word_id": word.id,
            "status": word.status,
            "streak": word.streak
        }
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/words/session/{session_id}")
def get_session(
    session_id: int = Path(...),
    db: Session = Depends(get_db)
):
    """获取学习会话状态"""
    session = db.query(StudySession).filter(StudySession.id == session_id).first()
    if not session:
        raise HTTPException(status_code=404, detail="会话不存在")
    
    import json
    return {
        "id": session.id,
        "mode": session.mode,
        "queue_length": session.queue_length,
        "selected_types": session.selected_types if isinstance(session.selected_types, list) else json.loads(session.selected_types),
        "queue": session.queue if isinstance(session.queue, list) else json.loads(session.queue),
        "current_word_idx": session.current_word_idx,
        "current_type": session.current_type,
        "wrong_queue": session.wrong_queue if isinstance(session.wrong_queue, list) else json.loads(session.wrong_queue),
        "completed_words_in_type": session.completed_words_in_type if isinstance(session.completed_words_in_type, list) else json.loads(session.completed_words_in_type),
        "is_active": session.is_active
    }


@router.post("/words/end-session/{session_id}")
def end_session(
    session_id: int = Path(...),
    db: Session = Depends(get_db)
):
    """结束学习会话"""
    session = db.query(StudySession).filter(StudySession.id == session_id).first()
    if not session:
        raise HTTPException(status_code=404, detail="会话不存在")
    session.is_active = False
    db.commit()
    return {"success": True, "message": "会话已结束"}


# ========== 长难句 API ==========

@router.get("/sentences/stats")
def get_sentence_stats(service: StudyService = Depends(get_study_service)):
    """获取长难句统计"""
    return service.get_sentence_stats()


@router.get("/sentences/due")
def get_due_sentences(
    limit: int = 10,
    service: StudyService = Depends(get_study_service)
):
    """获取到期复习的长难句"""
    sentences = service.get_due_sentences(limit)
    return [
        {
            "id": s.id,
            "sentence_en": s.sentence_en,
            "sentence_cn": s.sentence_cn,
            "status": s.status,
            "ebbinghaus_stage": s.ebbinghaus_stage,
            "next_review": s.next_review
        }
        for s in sentences
    ]


@router.get("/sentences", response_model=List[LongSentenceResponse])
def list_long_sentences(
    skip: int = 0, 
    limit: int = 100, 
    status: str = None, 
    db: Session = Depends(get_db)
):
    """获取长难句列表"""
    query = db.query(LongSentence)
    if status:
        query = query.filter(LongSentence.status == status)
    sentences = query.offset(skip).limit(limit).all()
    return [
        LongSentenceResponse(
            id=s.id,
            sentence_en=s.sentence_en,
            sentence_cn=s.sentence_cn,
            doi=s.doi,
            status=s.status,
            ebbinghaus_stage=s.ebbinghaus_stage,
            next_review=s.next_review,
            last_review=s.last_review,
            created_at=s.created_at,
            updated_at=s.updated_at
        )
        for s in sentences
    ]


@router.post("/sentences", response_model=LongSentenceResponse)
def create_long_sentence(data: LongSentenceCreate, db: Session = Depends(get_db)):
    """创建长难句"""
    sentence = LongSentence(**data.model_dump())
    db.add(sentence)
    db.commit()
    db.refresh(sentence)
    return LongSentenceResponse(
        id=sentence.id,
        sentence_en=sentence.sentence_en,
        sentence_cn=sentence.sentence_cn,
        doi=sentence.doi,
        status=sentence.status,
        ebbinghaus_stage=sentence.ebbinghaus_stage,
        next_review=sentence.next_review,
        last_review=sentence.last_review,
        created_at=sentence.created_at,
        updated_at=sentence.updated_at
    )


@router.put("/sentences/{sentence_id}", response_model=LongSentenceResponse)
def update_long_sentence(
    sentence_id: int = Path(...), 
    data: LongSentenceUpdate = Body(...), 
    db: Session = Depends(get_db)
):
    """更新长难句"""
    sentence = db.query(LongSentence).filter(LongSentence.id == sentence_id).first()
    if not sentence:
        raise HTTPException(status_code=404, detail="长难句不存在")
    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(sentence, key, value)
    db.commit()
    db.refresh(sentence)
    return LongSentenceResponse(
        id=sentence.id,
        sentence_en=sentence.sentence_en,
        sentence_cn=sentence.sentence_cn,
        doi=sentence.doi,
        status=sentence.status,
        ebbinghaus_stage=sentence.ebbinghaus_stage,
        next_review=sentence.next_review,
        last_review=sentence.last_review,
        created_at=sentence.created_at,
        updated_at=sentence.updated_at
    )


@router.post("/sentences/submit-translation")
async def submit_sentence_translation(
    data: SentenceTranslationSubmit,
    service: StudyService = Depends(get_study_service)
):
    """提交长难句翻译（含AI评价）"""
    try:
        # 获取原句
        sentence = service.db.query(LongSentence).filter(LongSentence.id == data.sentence_id).first()
        
        ai_evaluation = None
        if sentence:
            try:
                from services.ai_service import get_ai_service
                ai = get_ai_service()
                
                prompt = f"""请评价以下学术英语长难句的翻译质量：

英文原文：{sentence.sentence_en}
中文翻译：{data.translation}

请简要评价翻译的准确性、完整性和流畅度，指出主要问题。"""
                
                ai_evaluation = await ai.chat(
                    messages=[{"role": "user", "content": prompt}],
                    system="你是一个专业的学术翻译评价助手。"
                )
            except Exception:
                pass  # AI评价失败不影响提交流程
        
        result = service.submit_sentence_translation(
            data.sentence_id,
            data.translation,
            ai_evaluation
        )
        return result.model_dump()
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/sentences/mark-mastered/{sentence_id}")
def mark_sentence_mastered(
    sentence_id: int = Path(...),
    service: StudyService = Depends(get_study_service)
):
    """标记长难句为已掌握"""
    try:
        sentence = service.mark_sentence_mastered(sentence_id)
        return {
            "success": True,
            "sentence_id": sentence.id,
            "status": sentence.status
        }
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/sentences/{sentence_id}")
def delete_long_sentence(sentence_id: int = Path(...), db: Session = Depends(get_db)):
    """删除长难句"""
    sentence = db.query(LongSentence).filter(LongSentence.id == sentence_id).first()
    if not sentence:
        raise HTTPException(status_code=404, detail="长难句不存在")
    db.delete(sentence)
    db.commit()
    return {"message": "删除成功"}


# ========== 翻译练习 API ==========

@router.get("/translations/stats")
def get_translation_stats(service: StudyService = Depends(get_study_service)):
    """获取翻译练习统计"""
    return service.get_translation_stats()


@router.get("/translations/due")
def get_due_translations(
    limit: int = 10,
    service: StudyService = Depends(get_study_service)
):
    """获取到期复习的翻译练习"""
    cards = service.get_due_translations(limit)
    return [
        {
            "id": c.id,
            "original_text": c.original_text,
            "doi": c.doi,
            "ai_score": c.ai_score,
            "ebbinghaus_stage": c.ebbinghaus_stage,
            "next_review": c.next_review
        }
        for c in cards
    ]


@router.get("/translations", response_model=List[TranslationCardResponse])
def list_translations(
    skip: int = 0, 
    limit: int = 100, 
    db: Session = Depends(get_db)
):
    """获取翻译练习列表"""
    cards = db.query(TranslationCard).offset(skip).limit(limit).all()
    return [
        TranslationCardResponse(
            id=c.id,
            doi=c.doi,
            original_text=c.original_text,
            user_translation=c.user_translation,
            ai_score=c.ai_score,
            ai_feedback=c.ai_feedback,
            error_words=c.error_words,
            ebbinghaus_stage=c.ebbinghaus_stage,
            next_review=c.next_review,
            last_review=c.last_review,
            created_at=c.created_at,
            updated_at=c.updated_at
        )
        for c in cards
    ]


@router.post("/translations", response_model=TranslationCardResponse)
def create_translation(data: TranslationCardCreate, db: Session = Depends(get_db)):
    """创建翻译练习"""
    card = TranslationCard(**data.model_dump())
    db.add(card)
    db.commit()
    db.refresh(card)
    return TranslationCardResponse(
        id=card.id,
        doi=card.doi,
        original_text=card.original_text,
        user_translation=card.user_translation,
        ai_score=card.ai_score,
        ai_feedback=card.ai_feedback,
        error_words=card.error_words,
        ebbinghaus_stage=card.ebbinghaus_stage,
        next_review=card.next_review,
        last_review=card.last_review,
        created_at=card.created_at,
        updated_at=card.updated_at
    )


@router.post("/translations/submit")
async def submit_translation(
    data: TranslationSubmit,
    service: StudyService = Depends(get_study_service)
):
    """提交翻译练习（含AI评价）"""
    try:
        # 先获取卡片原文
        card = service.db.query(TranslationCard).filter(TranslationCard.id == data.card_id).first()
        if not card:
            raise ValueError("翻译卡片不存在")
        
        # 使用AI评价翻译
        ai_score = None
        ai_feedback = None
        error_words = []
        
        try:
            from services.ai_service import get_ai_service
            ai = get_ai_service()
            
            prompt = f"""请评价以下学术文献翻译的质量，给出0-100的分数和详细反馈。

原文：{card.original_text}
翻译：{data.translation}

请按以下JSON格式返回：
{{"score": 分数, "feedback": "评价和改进建议", "error_words": ["翻译错误的关键术语1", "翻译错误的关键术语2"]}}"""
            
            result_text = await ai.chat(
                messages=[{"role": "user", "content": prompt}],
                system="你是一个专业的学术翻译评价助手。请严格评价翻译质量。"
            )
            
            import json, re
            json_match = re.search(r'\{[^}]+\}', result_text, re.DOTALL)
            if json_match:
                result = json.loads(json_match.group())
                ai_score = min(100, max(0, int(result.get("score", 0))))
                ai_feedback = result.get("feedback", "")
                error_words = result.get("error_words", [])
        except Exception:
            pass  # AI评价失败不影响提交流程
        
        result = service.submit_translation(
            data.card_id,
            data.translation,
            ai_score,
            ai_feedback,
            error_words
        )
        return result.model_dump()
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/translations/{card_id}")
def delete_translation(card_id: int = Path(...), db: Session = Depends(get_db)):
    """删除翻译练习"""
    card = db.query(TranslationCard).filter(TranslationCard.id == card_id).first()
    if not card:
        raise HTTPException(status_code=404, detail="翻译练习不存在")
    db.delete(card)
    db.commit()
    return {"message": "删除成功"}


# ========== 单词表/长难句表 CRUD ==========

@router.get("/word-lists", response_model=List[WordListResponse])
def list_word_lists(skip: int = 0, limit: int = 100, db: Session = Depends(get_db)):
    return db.query(WordList).offset(skip).limit(limit).all()


@router.post("/word-lists", response_model=WordListResponse)
def create_word_list(data: WordListCreate, db: Session = Depends(get_db)):
    word_list = WordList(**data.model_dump())
    db.add(word_list)
    db.commit()
    db.refresh(word_list)
    return word_list


@router.delete("/word-lists/{word_list_id}")
def delete_word_list(word_list_id: int = Path(...), db: Session = Depends(get_db)):
    word_list = db.query(WordList).filter(WordList.id == word_list_id).first()
    if not word_list:
        raise HTTPException(status_code=404, detail="单词表不存在")
    db.delete(word_list)
    db.commit()
    return {"message": "删除成功"}


@router.get("/sentence-lists", response_model=List[SentenceListResponse])
def list_sentence_lists(skip: int = 0, limit: int = 100, db: Session = Depends(get_db)):
    return db.query(SentenceList).offset(skip).limit(limit).all()


@router.post("/sentence-lists", response_model=SentenceListResponse)
def create_sentence_list(data: SentenceListCreate, db: Session = Depends(get_db)):
    sentence_list = SentenceList(**data.model_dump())
    db.add(sentence_list)
    db.commit()
    db.refresh(sentence_list)
    return sentence_list


@router.delete("/sentence-lists/{sentence_list_id}")
def delete_sentence_list(sentence_list_id: int = Path(...), db: Session = Depends(get_db)):
    sentence_list = db.query(SentenceList).filter(SentenceList.id == sentence_list_id).first()
    if not sentence_list:
        raise HTTPException(status_code=404, detail="长难句表不存在")
    db.delete(sentence_list)
    db.commit()
    return {"message": "删除成功"}
