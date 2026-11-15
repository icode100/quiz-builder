'use strict';
const engine = require('../../_template/rough-work-engine.js');
const MAX_VALUE_BYTES = 3 * 1024 * 1024;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const stamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
class ApiError extends Error { constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; } }
const bad = message => { throw new ApiError(400, message); };
const typeOf = question => question.type || 'mcq';
const number = raw => typeof raw === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw.trim()) && Number.isFinite(Number(raw.trim())) ? Number(raw.trim()) : null;
const marks = (q, data) => ({ correct: q.marks ?? data.scoring?.correct ?? 1, incorrect: q.incorrectMarks ?? data.scoring?.incorrect ?? 0 });
function flags(value, ids) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || new Set(value).size !== value.length || value.some(id => typeof id !== 'string' || !ids.has(id))) bad('Invalid question flags or syllabus exclusions.');
  return value.slice();
}
function responses(value, data, submitted) {
  if (!object(value)) bad('Invalid quiz responses.');
  const byId = new Map(data.questions.map(q => [q.id, q])), result = Object.create(null);
  for (const [id, response] of Object.entries(value)) {
    const question = byId.get(id);
    if (!question) bad('Unknown response question.');
    if (response === null) continue;
    const type = typeOf(question), options = new Set((question.options || []).map(option => option.id));
    if (type === 'nat') {
      if (typeof response !== 'string' || response.length > 2048 || !response.trim() || (submitted && number(response) === null)) bad('Invalid numerical answer.');
    } else if (type === 'mcq') { if (!options.has(response)) bad('Invalid answer option.'); }
    else if (type === 'msq') {
      if (!Array.isArray(response) || !response.length || new Set(response).size !== response.length || response.some(answer => !options.has(answer))) bad('Invalid multiple-select answer.');
    } else bad('Unsupported question type.');
    result[id] = response;
  }
  return result;
}
function classifyKey(key, catalog) {
  if (typeof key !== 'string' || key.length > 600) bad('Invalid storage key.');
  if (key === 'practice-quiz:theme') return { kind: 'theme' };
  for (const [quizId, quiz] of catalog) {
    const prefix = `practice-quiz:${quizId}`;
    if (key === prefix) return { kind: 'draft', quizId, ...quiz };
    if (key === `${prefix}:attempt`) return { kind: 'attempt', quizId, ...quiz };
    for (const kind of ['rough', 'annotation']) if (key.startsWith(`${prefix}:${kind}:`)) {
      const encoded = key.slice(prefix.length + kind.length + 2);
      let questionId;
      try { questionId = decodeURIComponent(encoded); } catch { bad('Invalid note question ID.'); }
      if (encodeURIComponent(questionId) !== encoded || !quiz.data.questions.some(question => question.id === questionId)) bad('Unknown note question.');
      return { kind, quizId, questionId, ...quiz };
    }
  }
  bad('Unknown quiz storage key.');
}
function correctText(q) {
  if (q.marksToAll) return 'MTA — marks to all';
  if (typeOf(q) === 'nat') return q.correctRanges.map(({ min, max }) => min === max ? String(min) : `${min} to ${max} (inclusive)`).join(' OR ');
  if (typeOf(q) === 'msq') return (q.acceptedAnswerSets || [q.correctAnswers]).map(set => set.join(' + ')).join(' OR ');
  return (q.acceptedAnswers || [q.correctAnswer]).join(' OR ');
}
function canonicalAttempt(saved, quiz) {
  const { data, signature, quizId = data.id } = quiz;
  if (!object(saved) || saved.version !== 1 || saved.quizId !== quizId || saved.quizSignature !== signature || !stamp(saved.submittedAt) || !stamp(saved.updatedAt)) bad('This attempt belongs to a different paper or answer key, or has an invalid timestamp.');
  const answers = responses(saved.answers, data, true), ids = new Set(data.questions.map(q => q.id));
  const reviewFlags = flags(saved.reviewFlags, ids), outOfSyllabus = flags(saved.outOfSyllabus, ids), excluded = new Set(outOfSyllabus), outcomes = new Map();
  const counts = { correct: 0, incorrect: 0, unanswered: 0, awarded: 0 };
  let score = 0, maximum = 0, awardedMarks = 0;
  const results = data.questions.map(question => {
    const answer = answers[question.id], type = typeOf(question), weight = marks(question, data);
    if (!Number.isFinite(weight.correct) || weight.correct <= 0 || !Number.isFinite(weight.incorrect) || weight.incorrect > 0) throw new ApiError(500, 'Invalid bundled marking rules.');
    let outcome = 'unanswered', reason = '';
    if (excluded.has(question.id)) { outcome = 'excluded'; reason = 'Marked out of syllabus. Excluded from earned and total marks.'; }
    else if (question.marksToAll) outcome = 'awarded';
    else if (answer !== undefined) {
      const correct = type === 'nat' ? question.correctRanges.some(({ min, max }) => number(answer) >= min && number(answer) <= max)
        : type === 'msq' ? (question.acceptedAnswerSets || [question.correctAnswers]).some(set => answer.length === set.length && answer.every(id => set.includes(id)))
          : (question.acceptedAnswers || [question.correctAnswer]).includes(answer);
      outcome = correct ? 'correct' : 'incorrect';
      if (question.requiresCorrect && !excluded.has(question.requiresCorrect) && outcomes.get(question.requiresCorrect) !== 'correct') {
        outcome = 'blocked'; const q = data.questions.find(item => item.id === question.requiresCorrect);
        reason = `Not evaluated because question ${q.displayLabel || q.id} was incorrect or unanswered.`;
      }
    }
    outcomes.set(question.id, outcome);
    const earned = ['unanswered', 'blocked', 'excluded'].includes(outcome) ? 0 : outcome === 'awarded' ? weight.correct : weight[outcome];
    counts[outcome] = (counts[outcome] || 0) + 1; score += earned;
    if (outcome !== 'excluded') maximum += weight.correct;
    if (outcome === 'awarded') awardedMarks += earned;
    return { questionId: question.id, answer: answer ?? null, correctAnswer: correctText(question), outcome, marksEarned: earned, maxMarks: outcome === 'excluded' ? 0 : weight.correct, ...(reason ? { reason } : {}) };
  });
  if (!Number.isFinite(score) || !Number.isFinite(maximum)) throw new ApiError(500, 'Invalid bundled score.');
  return { version: 1, quizId, quizTitle: data.title, quizSignature: signature, updatedAt: saved.updatedAt, submittedAt: saved.submittedAt,
    answers: Object.fromEntries(data.questions.map(q => [q.id, answers[q.id] ?? null])), reviewFlags, outOfSyllabus,
    summary: { percentage: maximum ? score / maximum * 100 : null, score, maximum, ...counts, awardedMarks }, results };
}
function validateValue(key, value, catalog) {
  const record = classifyKey(key, catalog);
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_VALUE_BYTES) bad('The record is too large or has an invalid format.');
  if (record.kind === 'theme') { if (!['light', 'dark'].includes(value)) bad('Invalid theme.'); return { value, record }; }
  let saved;
  try { saved = JSON.parse(value); } catch { bad('Invalid record JSON.'); }
  if (!object(saved)) bad('Invalid record.');
  if (record.kind === 'attempt') return { value: JSON.stringify(canonicalAttempt(saved, record)), record };
  const ids = new Set(record.data.questions.map(q => q.id));
  if (record.kind === 'draft') {
    const allowed = new Set(['signature', 'answers', 'reviewFlags', 'outOfSyllabus', 'currentQuestionId', 'timer', 'updatedAt']);
    if (Object.keys(saved).some(field => !allowed.has(field)) || saved.signature !== record.signature) bad('The draft belongs to a different paper or answer key.');
    responses(saved.answers, record.data, false); flags(saved.reviewFlags, ids); flags(saved.outOfSyllabus, ids);
    if (saved.currentQuestionId !== undefined && !ids.has(saved.currentQuestionId)) bad('Invalid last question.');
    if (saved.updatedAt !== undefined && !stamp(saved.updatedAt)) bad('Invalid draft timestamp.');
    if (saved.timer !== undefined) {
      const timer = saved.timer;
      if (!object(timer) || ![180, 150, 120, 90, 60, 30].includes(timer.durationMinutes) || !Number.isSafeInteger(timer.remainingMs) || timer.remainingMs < 0 || timer.remainingMs > timer.durationMinutes * 60000 ||
          !(timer.endsAt === null || Number.isSafeInteger(timer.endsAt) && timer.endsAt > 0 && timer.endsAt - Date.now() <= timer.durationMinutes * 60000)) bad('Invalid timer.');
    }
  } else {
    if (saved.version !== 1 || saved.quizId !== record.quizId || saved.questionId !== record.questionId || !stamp(saved.updatedAt)) bad('Invalid drawing identity or timestamp.');
    try {
      if (record.kind === 'rough') {
        if (saved.paperStyle !== undefined && !engine.paperStyles.includes(saved.paperStyle)) bad('Invalid paper style.');
        if (saved.pageHeight !== undefined && (!Number.isInteger(saved.pageHeight) || saved.pageHeight < engine.paper.height || saved.pageHeight > engine.limits.paperHeight)) bad('Invalid drawing height.');
        engine.validateStrokes(saved.strokes);
      } else {
        const allowed = ['version', 'quizId', 'questionId', 'updatedAt', 'parts'];
        if (Object.keys(saved).length !== allowed.length || allowed.some(field => !Object.hasOwn(saved, field)) || !object(saved.parts)) bad('Invalid annotation record.');
        const question = record.data.questions.find(q => q.id === record.questionId), names = new Set(question.text.trim() ? ['text'] : []);
        for (let i = 0; i < (question.image ? 1 : 0) + (question.images || []).length; i++) names.add(`image-${i}`);
        let count = 0, points = 0;
        for (const [name, strokes] of Object.entries(saved.parts)) {
          if (!names.has(name)) bad('Invalid annotation part.');
          const checked = engine.validateStrokes(strokes, engine.annotationWidths); count += checked.length;
          points += checked.reduce((sum, stroke) => sum + stroke.points.length, 0);
        }
        if (count > engine.limits.strokes || points > engine.limits.totalPoints) bad('Annotation limits exceeded.');
      }
    } catch (error) { if (error instanceof ApiError) throw error; bad('Invalid drawing strokes.'); }
  }
  return { value, record };
}
module.exports = { ApiError, MAX_VALUE_BYTES, classifyKey, validateValue, canonicalAttempt, number };
