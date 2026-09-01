import { HashRouter, Route, Routes } from 'react-router-dom';
import EditorPage from './pages/EditorPage';
import MediaLibraryPage from './pages/MediaLibraryPage';
import SettingsPage from './pages/SettingsPage';
import TemplatesPage from './pages/TemplatesPage';
import { AppProvider } from './store/app';
import { EditorProvider } from './store/editor';

export default function App() {
  return (
    <AppProvider>
      <EditorProvider>
        {/* 静的ホスティングでも深いリンクが壊れないよう HashRouter を使う */}
        <HashRouter>
          <Routes>
            <Route path="/" element={<EditorPage />} />
            <Route path="/media-library" element={<MediaLibraryPage />} />
            <Route path="/templates" element={<TemplatesPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<EditorPage />} />
          </Routes>
        </HashRouter>
      </EditorProvider>
    </AppProvider>
  );
}
