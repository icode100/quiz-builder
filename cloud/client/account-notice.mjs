export const MEMORY_AUTH_NOTICE = 'You are signed in for this tab only because browser storage is unavailable.';

// null means another action owns the visible notice, so leave it untouched.
export function noticeAfterConnection(currentMessage, connectionError, { signedIn = false, persistence = 'local' } = {}) {
  if (!connectionError || currentMessage !== connectionError) return null;
  return signedIn && persistence === 'memory' ? MEMORY_AUTH_NOTICE : '';
}
