import { ASPECT_PRESETS, type AspectKey } from '../types';
import { useEditor } from '../store/editor';
import { ColorInput, Field, Panel } from './ui';

export function ProjectSettings() {
  const { project, dispatch } = useEditor();

  return (
    <Panel title="プロジェクト">
      <Field label="タイトル">
        <input
          type="text"
          value={project.name}
          onChange={(e) => dispatch({ type: 'project/patch', patch: { name: e.target.value }, key: 'name' })}
        />
      </Field>

      <Field label="画角">
        <div className="aspect-grid">
          {ASPECT_PRESETS.map((preset) => (
            <button
              key={preset.key}
              type="button"
              className={project.aspect === preset.key ? 'aspect active' : 'aspect'}
              onClick={() => dispatch({ type: 'project/aspect', aspect: preset.key as AspectKey })}
            >
              <span className="aspect-shape" style={{ aspectRatio: `${preset.width} / ${preset.height}` }} />
              <strong>{preset.label}</strong>
              <small>{preset.hint}</small>
            </button>
          ))}
        </div>
      </Field>

      <div className="two-col">
        <Field label="フレームレート">
          <select
            value={project.fps}
            onChange={(e) => dispatch({ type: 'project/patch', patch: { fps: Number(e.target.value) } })}
          >
            <option value={24}>24 fps</option>
            <option value={30}>30 fps</option>
            <option value={60}>60 fps</option>
          </select>
        </Field>
        <Field label="背景色">
          <ColorInput
            value={project.background}
            onChange={(background) => dispatch({ type: 'project/patch', patch: { background }, key: 'bg' })}
          />
        </Field>
      </div>

      <p className="muted">
        出力サイズ {project.width} × {project.height}
      </p>
    </Panel>
  );
}
