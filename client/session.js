export function beginSessionTransition(state) {
  state.controller?.abort(new DOMException('Account changed.', 'AbortError'));
  state.controller = new AbortController();
  state.epoch += 1;
  return state.epoch;
}

export function captureSession(state) {
  if (!state.user || !state.vault || !state.controller) return null;
  return {
    epoch: state.epoch,
    uid: state.user.uid,
    vault: state.vault,
    credentials: state.credentials,
    signal: state.controller.signal,
  };
}

export function isCurrentSession(state, session) {
  return Boolean(session)
    && !session.signal.aborted
    && state.epoch === session.epoch
    && state.user?.uid === session.uid
    && state.vault === session.vault;
}

export function transitionForDisconnect(state) {
  beginSessionTransition(state);
  state.credentials = null;
  return captureSession(state);
}

export function transitionForCredentialReplacement(state) {
  beginSessionTransition(state);
  state.credentials = null;
  return captureSession(state);
}
