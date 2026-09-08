import { configureStore } from '@reduxjs/toolkit';
import { setupListeners } from '@reduxjs/toolkit/query';
import { useDispatch, useSelector, type TypedUseSelectorHook } from 'react-redux';
import { api } from '../api/api';
import authReducer from './authSlice';
import liveReducer from './liveSlice';
import uiReducer from './uiSlice';

export const store = configureStore({
  reducer: {
    auth: authReducer,
    live: liveReducer,
    ui: uiReducer,
    [api.reducerPath]: api.reducer
  },
  middleware: (getDefault) =>
    getDefault({
      // Live frames are plain JSON and arrive at 5 Hz; running the
      // serializability check on every one of them costs more than it catches.
      serializableCheck: { ignoredActions: ['live/navigationReceived'] },
      immutableCheck: { ignoredPaths: ['live.history', 'live.trails'] }
    }).concat(api.middleware)
});

setupListeners(store.dispatch);

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;

export const useAppDispatch: () => AppDispatch = useDispatch;
export const useAppSelector: TypedUseSelectorHook<RootState> = useSelector;
