import { Routes } from './router';
import EditorPage from './pages/EditorPage';
import MediaLibraryPage from './pages/MediaLibraryPage';
import SettingsPage from './pages/SettingsPage';
import TemplatesPage from './pages/TemplatesPage';
import { AppProvider } from './store/app';
import { EditorProvider } from './store/editor';
import { ToastHost } from './components/Toast';

export default function App() {
  return (
    <AppProvider>
      <EditorProvider>
        {/* 静的ホスティングでも深いリンクが壊れないよう、ハッシュで切り替える（router.tsx） */}
        <Routes
          routes={{
            '/': () => <EditorPage />,
            '/media-library': () => <MediaLibraryPage />,
            '/templates': () => <TemplatesPage />,
            '/settings': () => <SettingsPage />,
          }}
          fallback={() => <EditorPage />}
        />
        <ToastHost />
      </EditorProvider>
    </AppProvider>
  );
}
