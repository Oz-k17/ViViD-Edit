import { useState } from 'react';
import { LayoutToggle } from '../components/LayoutToggle';
import { Brand, SiteNav } from '../components/SiteNav';
import { Panel } from '../components/ui';
import { formatBytes, formatTime } from '../engine/media';
import { OUTPUT_STATUSES, groupOutputs, nextStatus, outputCounts, type OutputItem, type OutputStatus } from '../model/outputs';
import { outputsStore, useOutputs } from '../store/outputs';

function dateLabel(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const NEXT_LABEL: Record<OutputStatus, string> = { check: '確認した', ok: '投稿した', posted: '' };

/**
 * 完成品 — 書き出した作品の一覧と、確認の状態（model/outputs.ts）。
 * 投稿はここからはしない。確かめて、投稿したら自分で印を進める。
 */
export default function OutputsPage() {
  const items = useOutputs();
  const [filter, setFilter] = useState<OutputStatus | 'all'>('all');
  const [copied, setCopied] = useState<string | null>(null);
  const counts = outputCounts(items);
  const shown = filter === 'all' ? items : items.filter((i) => i.status === filter);
  const groups = groupOutputs(shown);

  const copyNote = async (item: OutputItem) => {
    if (!item.postNote) return;
    try {
      await navigator.clipboard.writeText(item.postNote);
      setCopied(item.id);
    } catch {
      setCopied(null);
    }
  };

  return (
    <div className="page">
      <header className="topbar">
        <Brand />
        <SiteNav />
        <div className="topbar-actions">
          <LayoutToggle />
        </div>
      </header>

      <main className="page-body">
        <Panel title={`完成品（${items.length}）`}>
          <p className="empty-hint">
            書き出した作品が、ここに「確認待ち」で並びます。見て確かめたら「確認した」、投稿したら「投稿した」を押して進めます。
            自動で投稿することはありません。動画のファイルは、保存した先（ダウンロードやカメラロール）にあります。
          </p>
          <div className="chip-row wrap" role="group" aria-label="状態で絞り込む">
            <button type="button" className={filter === 'all' ? 'chip active' : 'chip'} onClick={() => setFilter('all')}>
              すべて {items.length}
            </button>
            {OUTPUT_STATUSES.map((s) => (
              <button
                key={s.key}
                type="button"
                className={filter === s.key ? 'chip active' : 'chip'}
                title={s.hint}
                onClick={() => setFilter(s.key)}
              >
                {s.label} {counts[s.key]}
              </button>
            ))}
          </div>

          {items.length === 0 ? (
            <p className="empty-hint">まだありません。エディタの「書き出し」から動画を書き出すと、ここに並びます。</p>
          ) : shown.length === 0 ? (
            <p className="empty-hint">この状態のものはありません。</p>
          ) : (
            <div className="output-groups">
              {groups.map((group) => (
                <section key={group[0].id} className="output-group">
                  <header>
                    <strong>{group[0].project || '（名前なし）'}</strong>
                    <span className="muted small">{dateLabel(group[0].at)}</span>
                  </header>
                  <ul>
                    {group.map((item) => {
                      const next = nextStatus(item.status);
                      return (
                        <li key={item.id} className={`output-row status-${item.status}`}>
                          <div className="output-main">
                            <span className={`output-status status-${item.status}`}>
                              {OUTPUT_STATUSES.find((s) => s.key === item.status)?.label}
                            </span>
                            <span className="output-name">
                              {item.variant && <strong>{item.variant}</strong>}
                              <span className="output-file">{item.filename}</span>
                            </span>
                            <span className="muted small">
                              {item.aspect}・{item.quality}p・{formatTime(item.duration)}・{formatBytes(item.bytes)}
                            </span>
                          </div>
                          <div className="output-actions">
                            {next && (
                              <button type="button" className="primary" onClick={() => outputsStore.update(item.id, { status: next })}>
                                {NEXT_LABEL[item.status]}
                              </button>
                            )}
                            {item.status !== 'check' && (
                              <button
                                type="button"
                                className="ghost"
                                onClick={() => outputsStore.update(item.id, { status: item.status === 'posted' ? 'ok' : 'check' })}
                              >
                                1 つ戻す
                              </button>
                            )}
                            {item.postNote && (
                              <button type="button" onClick={() => void copyNote(item)}>
                                {copied === item.id ? 'コピーしました' : '投稿メモをコピー'}
                              </button>
                            )}
                            <button
                              type="button"
                              className="danger"
                              title="一覧から外します（保存した動画のファイルは消えません）"
                              onClick={() => outputsStore.remove(item.id)}
                            >
                              一覧から外す
                            </button>
                          </div>
                          <input
                            type="text"
                            className="output-memo"
                            defaultValue={item.memo}
                            placeholder="メモ（どこに投稿したか・直したい所など）"
                            aria-label="メモ"
                            maxLength={500}
                            onBlur={(e) => e.target.value !== item.memo && outputsStore.update(item.id, { memo: e.target.value })}
                          />
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </Panel>
      </main>
    </div>
  );
}
