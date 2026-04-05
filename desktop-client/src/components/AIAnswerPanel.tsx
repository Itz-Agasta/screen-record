/**
 * src/components/AIAnswerPanel.tsx
 * =================================
 * The centrepiece of the UI — displays streaming AI answers from Claude.
 *
 * Behaviour:
 *   • New answer blocks are prepended (newest at top)
 *   • While streaming: shows a blinking cursor after the last token
 *   • When complete: cursor snaps off, text is static and selectable
 *   • History: up to 20 answer blocks kept; older ones fade in opacity
 *   • Empty state: shows a passive listening indicator
 *
 * Token animation:
 *   Tokens are rendered as inline <span> elements with a fade-in animation.
 *   This is deliberately subtle — the motion communicates "live data"
 *   without being distracting during an interview.
 *
 * Selection:
 *   Completed answer blocks re-enable text selection so the user can
 *   copy answers to paste elsewhere. Streaming blocks block selection
 *   (prevents accidental drag during rapid token arrival).
 */

import React, { useRef, useEffect } from 'react';
import { useStore } from '../lib/store';

export function AIAnswerPanel() {
  const answers         = useStore((s) => s.answers);
  const currentAnswerId = useStore((s) => s.currentAnswerId);
  const scrollRef       = useRef<HTMLDivElement>(null);

  // Auto-scroll to top when a new answer block starts
  // (answers are prepended, so newest is at top — scroll there)
  useEffect(() => {
    if (currentAnswerId && scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
  }, [currentAnswerId]);

  if (answers.length === 0) {
    return <EmptyState />;
  }

  return (
    <div
      ref={scrollRef}
      style={{
        flex: 1,
        overflowY: 'auto',
        padding: '12px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
      }}
    >
      {answers.map((answer, index) => (
        <AnswerBlock
          key={answer.id}
          text={answer.text}
          streaming={answer.streaming}
          timestamp={answer.timestamp}
          opacity={index === 0 ? 1 : Math.max(0.35, 1 - index * 0.15)}
        />
      ))}
    </div>
  );
}

// ── AnswerBlock ───────────────────────────────────────────────────────────────

interface AnswerBlockProps {
  text:      string;
  streaming: boolean;
  timestamp: Date;
  opacity:   number;
}

function AnswerBlock({ text, streaming, timestamp, opacity }: AnswerBlockProps) {
  const timeStr = timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  return (
    <div
      className="fade-up"
      style={{
        background: 'var(--bg-surface)',
        border: `1px solid ${streaming ? 'rgba(0,229,204,0.2)' : 'var(--bg-border)'}`,
        borderRadius: 'var(--radius-lg)',
        padding: '11px 13px',
        opacity,
        transition: 'border-color 0.3s, opacity 0.3s',
        boxShadow: streaming ? '0 0 0 1px rgba(0,229,204,0.05) inset' : 'none',
      }}
    >
      {/* ── Header ───────────────────────────────────────────────── */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        marginBottom: '7px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
          {streaming ? (
            <span style={{
              width: '5px', height: '5px', borderRadius: '50%',
              background: 'var(--accent)', display: 'inline-block',
              boxShadow: '0 0 6px var(--accent)',
            }} />
          ) : (
            <span style={{
              width: '5px', height: '5px', borderRadius: '50%',
              background: 'var(--text-muted)', display: 'inline-block',
            }} />
          )}
          <span style={{ color: 'var(--text-muted)', fontSize: '9.5px', letterSpacing: '0.08em', fontWeight: 500 }}>
            {streaming ? 'CLAUDE' : 'ANSWER'}
          </span>
        </div>
        <span style={{ color: 'var(--text-muted)', fontSize: '9.5px', fontFamily: 'var(--font-mono)' }}>
          {timeStr}
        </span>
      </div>

      {/* ── Answer text ──────────────────────────────────────────── */}
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: '12px',
          lineHeight: '1.7',
          color: 'var(--text-primary)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          userSelect: streaming ? 'none' : 'text',
          WebkitUserSelect: streaming ? 'none' : 'text',
        } as React.CSSProperties}
        className={streaming ? 'cursor-blink' : ''}
      >
        {text || (streaming ? '\u00A0' : '')}
      </div>
    </div>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div style={{
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '10px',
      padding: '24px',
    }}>
      {/* Animated listening dots */}
      <div style={{ display: 'flex', gap: '5px', alignItems: 'center', height: '16px' }}>
        {[0, 1, 2].map((i) => (
          <span key={i} style={{
            width: '4px', height: '4px', borderRadius: '50%',
            background: 'var(--text-muted)',
            display: 'inline-block',
            animation: `pulse-dot 1.4s ease-in-out ${i * 0.2}s infinite`,
          }} />
        ))}
      </div>
      <style>{`
        @keyframes pulse-dot {
          0%, 80%, 100% { transform: scale(1);   opacity: 0.3; }
          40%            { transform: scale(1.5); opacity: 0.8; }
        }
      `}</style>
      <p style={{ color: 'var(--text-muted)', fontSize: '11px', textAlign: 'center', lineHeight: 1.5 }}>
        Listening for questions…<br/>
        <span style={{ fontSize: '10px', opacity: 0.6 }}>AI answers will appear here in real time</span>
      </p>
    </div>
  );
}
