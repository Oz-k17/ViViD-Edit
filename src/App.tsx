import { Routes } from './router';
import { UpdateBanner } from './components/UpdateBanner';
import EditorPage from './pages/EditorPage';
import MediaLibraryPage from './pages/MediaLibraryPage';
import SettingsPage from './pages/SettingsPage';
import TemplatesPage from './pages/TemplatesPage';
import OutputsPage from './pages/OutputsPage';
import TextStylePage from './pages/TextStylePage';
import { AppProvider } from './store/app';
import { EditorProvider } from './store/editor';
import { ToastHost } from './components/Toast';

export default function App() {
  return (
    <AppProvider>
      <EditorProvider>
        <UpdateBanner />
        {/* 静的ホスティングでも深いリンクが壊れないよう、ハッシュで切り替える（router.tsx） */}
        <Routes
          routes={{
            '/': () => <EditorPage />,
            '/media-library': () => <MediaLibraryPage />,
            '/templates': () => <TemplatesPage />,
            '/text-styles': () => <TextStylePage />,
            '/outputs': () => <OutputsPage />,
            '/settings': () => <SettingsPage />,
          }}
          fallback={() => <EditorPage />}
        />
        <ToastHost />
      </EditorProvider>
    </AppProvider>
  );
}
