// A paper can open before its other notebooks have been downloaded. Drawing
// controllers explicitly hydrate their current question before accepting ink.
export function shouldHydrateOnPage(key, { page, quizId } = {}) {
  if (key === 'practice-quiz:theme') return true;
  if (typeof key !== 'string' || !key.startsWith('practice-quiz:')) return false;
  if (page === 'home') return key.endsWith(':attempt');
  if (typeof quizId !== 'string' || !quizId) return false;
  const paper = `practice-quiz:${quizId}`;
  return key === paper || key === `${paper}:attempt`;
}
