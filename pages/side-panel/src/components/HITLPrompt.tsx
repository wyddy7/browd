import { useState } from 'react';
import type { HITLDecision, HITLRequest } from '../../../../chrome-extension/src/background/agent/hitl/types';

interface HITLPromptProps {
  request: HITLRequest;
  onDecision: (id: string, decision: HITLDecision) => void;
}

export function HITLPrompt({ request, onDecision }: HITLPromptProps) {
  const [answerText, setAnswerText] = useState('');
  const [editJson, setEditJson] = useState('');
  const [mode, setMode] = useState<'default' | 'edit' | 'answer'>('default');

  const submit = (decision: HITLDecision) => onDecision(request.id, decision);

  // T2f-handover — dedicated UI for "click this in your real
  // browser" requests. Shows a downscaled thumb of the page with a
  // ring marker over the (x,y) target so the user knows what to
  // click; two buttons drive approve/reject through the same HITL
  // wire as everything else.
  if (request.reason === 'real_user_click' && request.context.userClick) {
    const { x, y, imageThumbBase64, imageThumbMime } = request.context.userClick;
    const thumbUrl = imageThumbBase64 ? `data:${imageThumbMime ?? 'image/jpeg'};base64,${imageThumbBase64}` : null;
    return (
      <div className="border border-[var(--browd-border)] rounded-[var(--browd-radius-md)] bg-[var(--browd-panel)] p-3 my-2 text-sm">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-[var(--browd-accent)] font-semibold">✋ Help me click</span>
          <span className="text-[var(--browd-muted)] text-xs ml-auto">anti-automation wall</span>
        </div>
        <p className="text-[var(--browd-text)] mb-2 leading-snug">{request.context.summary}</p>
        {thumbUrl ? (
          <div className="browd-hitl-click-target relative mb-3 overflow-hidden rounded border border-[var(--browd-border)]">
            <img src={thumbUrl} alt="click target" className="block w-full" />
            <span
              className="browd-hitl-click-marker"
              aria-hidden="true"
              style={{ left: `${(x / 1280) * 100}%`, top: `${(y / 800) * 100}%` }}
            />
          </div>
        ) : null}
        <div className="flex gap-2 flex-wrap">
          <button
            onClick={() => submit({ type: 'approve' })}
            className="px-3 py-1 rounded text-xs bg-[var(--browd-accent)] text-white hover:opacity-90">
            I clicked it
          </button>
          <button
            onClick={() => submit({ type: 'reject', message: "couldn't click" })}
            className="px-3 py-1 rounded text-xs text-[var(--browd-muted)] hover:text-red-400">
            Skip
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="border border-[var(--browd-border)] rounded-[var(--browd-radius-md)] bg-[var(--browd-panel)] p-3 my-2 text-sm">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[var(--browd-accent)] font-semibold">⏸ Agent waiting</span>
        <span className="text-[var(--browd-muted)] text-xs ml-auto capitalize">
          {request.reason.replace(/_/g, ' ')}
        </span>
      </div>

      {request.question && <p className="text-[var(--browd-text)] mb-3 leading-snug">{request.question}</p>}

      {request.context.summary && !request.question && (
        <p className="text-[var(--browd-text)] mb-3 leading-snug">{request.context.summary}</p>
      )}

      {mode === 'default' && (
        <>
          {request.options && request.options.length > 0 && (
            <div className="flex flex-wrap gap-1 mb-3">
              {request.options.map(opt => (
                <button
                  key={opt}
                  onClick={() => submit({ type: 'answer', answer: opt })}
                  className="px-2 py-1 rounded text-xs border border-[var(--browd-border)] hover:border-[var(--browd-accent)] text-[var(--browd-text)]">
                  {opt}
                </button>
              ))}
            </div>
          )}

          <div className="flex gap-2 flex-wrap">
            <button
              onClick={() => submit({ type: 'approve' })}
              className="px-3 py-1 rounded text-xs bg-[var(--browd-accent)] text-white hover:opacity-90">
              Approve
            </button>
            <button
              onClick={() => setMode('answer')}
              className="px-3 py-1 rounded text-xs border border-[var(--browd-border)] text-[var(--browd-text)] hover:border-[var(--browd-accent)]">
              Answer
            </button>
            <button
              onClick={() => {
                setEditJson(JSON.stringify(request.pendingAction, null, 2));
                setMode('edit');
              }}
              className="px-3 py-1 rounded text-xs border border-[var(--browd-border)] text-[var(--browd-muted)] hover:border-[var(--browd-accent)]">
              Edit
            </button>
            <button
              onClick={() => submit({ type: 'reject', message: 'User rejected' })}
              className="px-3 py-1 rounded text-xs text-[var(--browd-muted)] hover:text-red-400">
              Reject
            </button>
          </div>
        </>
      )}

      {mode === 'answer' && (
        <div className="flex flex-col gap-2">
          <textarea
            autoFocus
            value={answerText}
            onChange={e => setAnswerText(e.target.value)}
            placeholder="Type your answer…"
            rows={3}
            className="w-full rounded border border-[var(--browd-border)] bg-[var(--browd-bg)] text-[var(--browd-text)] px-2 py-1 text-xs resize-none focus:outline-none focus:border-[var(--browd-accent)]"
          />
          <div className="flex gap-2">
            <button
              onClick={() => submit({ type: 'answer', answer: answerText })}
              disabled={!answerText.trim()}
              className="px-3 py-1 rounded text-xs bg-[var(--browd-accent)] text-white hover:opacity-90 disabled:opacity-40">
              Send
            </button>
            <button onClick={() => setMode('default')} className="px-3 py-1 rounded text-xs text-[var(--browd-muted)]">
              Back
            </button>
          </div>
        </div>
      )}

      {mode === 'edit' && (
        <div className="flex flex-col gap-2">
          <textarea
            autoFocus
            value={editJson}
            onChange={e => setEditJson(e.target.value)}
            rows={6}
            className="w-full rounded border border-[var(--browd-border)] bg-[var(--browd-bg)] text-[var(--browd-text)] px-2 py-1 text-xs font-mono resize-none focus:outline-none focus:border-[var(--browd-accent)]"
          />
          <div className="flex gap-2">
            <button
              onClick={() => {
                try {
                  const edited = JSON.parse(editJson);
                  submit({ type: 'edit', editedAction: edited });
                } catch {
                  alert('Invalid JSON');
                }
              }}
              className="px-3 py-1 rounded text-xs bg-[var(--browd-accent)] text-white hover:opacity-90">
              Submit edit
            </button>
            <button onClick={() => setMode('default')} className="px-3 py-1 rounded text-xs text-[var(--browd-muted)]">
              Back
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
