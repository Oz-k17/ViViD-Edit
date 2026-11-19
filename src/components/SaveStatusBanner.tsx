import { useEffect, useState, useSyncExternalStore } from 'react';
import { buildProjectFile } from '../engine/project-file';
import { saveBlob } from '../engine/exporter';
import { saveState, subscribeSaveState } from '../store/projectSave';
import { useEditor } from '../store/editor';

/**
 * 編集内容をこの端末に控えられなかったときの知らせ（projectSave.ts）。
 * 以前は黙って諦めていたので、閉じると編集が消えることに気づけなかった。
 * 予備の置き場（IndexedDB）へ入ったときは、ちゃんと残るので何も出さない。
 */
export function SaveStatusBanner() {
  const state = useSyncExternalStore(subscribeSaveState, saveState, saveState);
  const { project } = useEditor();
  const [hidden, setHidden] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    if (state !== 'failed') {
      setHidden(false);
      setNote(null);
    }
  }, [state]);
  if (state !== 'failed' || hidden) return null;

  const saveFile = async () => {
    const name = `${project.name || 'project'}.vivid.json`;
    try {
      await saveBlob(new Blob([JSON.stringify(buildProjectFile(project), null, 2)], { type: 'application/json' }), name);
      setNote(`${name} を保存しました。設定の「プロジェクトを開く」で戻せます。`);
    } catch (error) {
      setNote(`保存できませんでした: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return (
    <div className="update-banner save-failed" role="alert">
      <span>
        {note ??
          '編集内容を、この端末に控えられませんでした（保存する場所がいっぱいです）。このまま閉じると、いまの編集が消えます。ファイルに保存しておいてください。'}
      </span>
      <button type="button" className="primary" onClick={() => void saveFile()}>
        ファイルに保存する
      </button>
      <button type="button" className="ghost" onClick={() => setHidden(true)}>
        閉じる
      </button>
    </div>
  );
}
