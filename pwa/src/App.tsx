import { useEffect } from 'react';
import { AppProvider } from './context/AppContext';
import { SettingsBanner } from './components/common/SettingsBanner';
import { Toast } from './components/common/Toast';
import { CompactNavigation, Sidebar } from './components/layout/Sidebar';
import { SuggestView } from './components/views/SuggestView';
import { AllView } from './components/views/AllView';
import { ReviewView } from './components/views/ReviewView';
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
    if (detailTaskId && currentView !== 'all') return <DetailView />;
    switch (currentView) {
      case 'suggest': return <SuggestView />;
      case 'all': return <AllView />;
      case 'review': return <ReviewView />;
    }
  }

  return (
    <div className={`app-shell app-shell-${currentView}`}>
      <Sidebar />
      <CompactNavigation />
      <main id="app">
        <SettingsBanner />
        {renderMain()}
      </main>
      <Toast />
    </div>
  );
}

export default function App() {
  return (
    <AppProvider>
      <AppShell />
    </AppProvider>
  );
}
