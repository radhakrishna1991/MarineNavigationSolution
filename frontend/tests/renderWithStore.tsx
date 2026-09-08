/**
 * Test harness: a real store with the API middleware, plus a fetch stub so
 * components exercise their genuine query lifecycle rather than a mock.
 */

import { type ReactElement, type ReactNode } from 'react';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { MemoryRouter } from 'react-router-dom';
import { render } from '@testing-library/react';
import { vi } from 'vitest';
import { api } from '../src/api/api';
import authReducer, { loggedIn } from '../src/store/authSlice';
import liveReducer, { navigationReceived, alarmReceived } from '../src/store/liveSlice';
import uiReducer from '../src/store/uiSlice';
import type { Alarm, NavigationOutput, Role } from '../src/types';

export function makeStore() {
  return configureStore({
    reducer: { auth: authReducer, live: liveReducer, ui: uiReducer, [api.reducerPath]: api.reducer },
    middleware: (getDefault) => getDefault({ serializableCheck: false }).concat(api.middleware)
  });
}

export type TestStore = ReturnType<typeof makeStore>;

export interface RenderOptions {
  navigation?: NavigationOutput | null;
  alarms?: Alarm[];
  role?: Role;
  route?: string;
  /** Map of URL substring to JSON response. */
  responses?: Record<string, unknown>;
}

/** Install a fetch stub that answers from `responses`, 404 otherwise. */
export function stubFetch(responses: Record<string, unknown>) {
  const stub = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const match = Object.keys(responses).find((key) => url.includes(key));
    if (match) {
      return new Response(JSON.stringify(responses[match]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({ error: 'NOT_FOUND', message: `No stub for ${url}` }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    });
  });
  global.fetch = stub as unknown as typeof fetch;
  return stub;
}

export function renderWithStore(ui: ReactElement, options: RenderOptions = {}) {
  const store = makeStore();

  store.dispatch(
    loggedIn({
      token: 'test-token',
      user: {
        id: 'user-1',
        username: 'tester',
        full_name: 'Test User',
        role: options.role ?? 'engineer',
        is_active: true
      }
    })
  );

  if (options.navigation) {
    store.dispatch(
      navigationReceived({ navigation: options.navigation, active_alarms: options.alarms ?? [] })
    );
  }
  for (const alarm of options.alarms ?? []) store.dispatch(alarmReceived(alarm));

  stubFetch(options.responses ?? {});

  const Wrapper = ({ children }: { children: ReactNode }) => (
    <Provider store={store}>
      <MemoryRouter
        initialEntries={[options.route ?? '/']}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        {children}
      </MemoryRouter>
    </Provider>
  );

  return { store, ...render(ui, { wrapper: Wrapper }) };
}
