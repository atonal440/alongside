import { useEffect } from 'react';
import { AppProvider } from './context/AppContext';
import { Header } from './components/layout/Header';
import { SyncStatus } from './components/layout/SyncStatus';
import { SettingsBanner } from './components/common/SettingsBanner';
import { Toast } from './components/common/Toast';
import { SuggestView } from './components/views/SuggestView';
import { AllView } from './components/views/AllView';
import { SessionView } from './components/views/SessionView';
import { DetailView } from './components/views/DetailView';
import { EditView } from './components/views/EditView';
import { useAppState } from './hooks/useAppState';
import { useSync } from './hooks/useSync';
import { useHistory } from './hooks/useHistory';

function AppShell() {
  useSync();
  useHistory();

  const { state } = useAppState();
  const { currentView, editingTaskId, detailTaskId } = state;

  // Register service worker
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(err =>
        console.warn('SW registration failed:', err),
      );
    }
  }, []);

  function renderMain() {
    if (editingTaskId) return <EditView />;
    if (detailTaskId) return <DetailView />;
    switch (currentView) {
      case 'suggest': return <SuggestView />;
      case 'all': return <AllView />;
      case 'session': return <SessionView />;
    }
  }

  return (
    <>
      <Header />
      <SyncStatus />
      <SettingsBanner />
      <main id="app">
        {renderMain()}
      </main>
      <Toast />
    </>
  );
}

export default function App() {
  return (
    <AppProvider>
      <AppShell />
    </AppProvider>
  );
}
