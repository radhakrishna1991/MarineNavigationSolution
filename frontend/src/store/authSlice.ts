/**
 * Authentication state.
 *
 * The token is kept in `sessionStorage` rather than `localStorage`: a bridge
 * terminal is a shared device, and a session that survives the browser closing
 * is a session someone else inherits.
 */

import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { Role, User } from '../types';

const STORAGE_KEY = 'amnp.session';

interface StoredSession {
  token: string;
  user: User;
}

function loadSession(): StoredSession | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredSession;
    if (!parsed?.token || !parsed?.user) return null;
    return parsed;
  } catch {
    return null;
  }
}

function persist(session: StoredSession | null) {
  try {
    if (session) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Private browsing or a locked-down kiosk profile. The session then lives
    // only in memory, which is a degradation rather than a failure.
  }
}

const restored = loadSession();

interface AuthState {
  token: string | null;
  user: User | null;
  sessionExpired: boolean;
}

const initialState: AuthState = {
  token: restored?.token ?? null,
  user: restored?.user ?? null,
  sessionExpired: false
};

const authSlice = createSlice({
  name: 'auth',
  initialState,
  reducers: {
    loggedIn(state, action: PayloadAction<{ token: string; user: User }>) {
      state.token = action.payload.token;
      state.user = action.payload.user;
      state.sessionExpired = false;
      persist(action.payload);
    },
    userRefreshed(state, action: PayloadAction<User>) {
      state.user = action.payload;
      if (state.token) persist({ token: state.token, user: action.payload });
    },
    loggedOut(state) {
      // Distinguish an expiry from a deliberate sign-out so the login screen
      // can explain what happened rather than just reappearing.
      state.sessionExpired = Boolean(state.token);
      state.token = null;
      state.user = null;
      persist(null);
    },
    signedOut(state) {
      state.token = null;
      state.user = null;
      state.sessionExpired = false;
      persist(null);
    },
    expiryAcknowledged(state) {
      state.sessionExpired = false;
    }
  }
});

export const { loggedIn, loggedOut, signedOut, userRefreshed, expiryAcknowledged } = authSlice.actions;
export default authSlice.reducer;

const ROLE_ORDER: Role[] = ['viewer', 'operator', 'engineer', 'administrator'];

/** Does the signed-in role meet or exceed `required`? */
export function hasRole(role: Role | undefined | null, required: Role): boolean {
  if (!role) return false;
  return ROLE_ORDER.indexOf(role) >= ROLE_ORDER.indexOf(required);
}
