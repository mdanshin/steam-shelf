export class CallableError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CallableError';
    this.code = code;
  }
}

export async function handleSyncCall(request, { checkRateLimit, sync }) {
  const uid = request?.auth?.uid;
  if (!uid) throw new CallableError('unauthenticated', 'Войдите через Google, чтобы синхронизировать Steam.');
  const token = request.auth.token || {};
  if (token.email_verified !== true || token.firebase?.sign_in_provider !== 'google.com') {
    throw new CallableError('permission-denied', 'Для синхронизации нужен подтверждённый Google-аккаунт.');
  }
  const resource = request?.data?.resource;
  if (!['library', 'wishlist'].includes(resource)) throw new CallableError('invalid-argument', 'Неизвестный тип синхронизации.');
  const release = await checkRateLimit(uid, resource);
  try {
    try {
      return await sync(request.data);
    } catch (error) {
      if (error instanceof CallableError) throw error;
      if (error instanceof TypeError) throw new CallableError('invalid-argument', error.message);
      throw new CallableError('unavailable', 'Steam временно недоступен. Попробуйте позже.');
    }
  } finally {
    if (typeof release === 'function') await release().catch(() => {});
  }
}
