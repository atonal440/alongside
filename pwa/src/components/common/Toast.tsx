import { useEffect, useRef } from 'react';
import { useAppState } from '../../hooks/useAppState';

export function Toast() {
  const { state, dispatch } = useAppState();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!state.toastMessage) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      dispatch({ type: 'SET_TOAST', message: null });
    }, 3000);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [state.toastMessage, dispatch]);

  return (
    <div
      className={`toast${state.toastMessage ? ' visible' : ''}`}
      dangerouslySetInnerHTML={{ __html: state.toastMessage ?? '' }}
    />
  );
}
