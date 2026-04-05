/**
 * src/components/ChatPanel.tsx
 * ============================
 * Chat-style conversation view showing:
 *   - User messages (transcribed speech) on the RIGHT
 *   - AI responses on the LEFT
 * 
 * This makes it easy to see which side has issues during debugging.
 */

import React, { useRef, useEffect } from 'react';
import { useStore, ChatMessage } from '../lib/store';

export function ChatPanel() {
  const chatMessages = useStore((s) => s.chatMessages);
  const currentChatMsgId = useStore((s) => s.currentChatMsgId);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [chatMessages]);

  if (chatMessages.length === 0) {
    return (
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '20px',
          color: 'var(--text-muted)',
          fontSize: '11px',
          fontStyle: 'italic',
          textAlign: 'center',
        }}
      >
        <div>
          <p style={{ marginBottom: '8px' }}>Listening for questions...</p>
          <p style={{ fontSize: '9px', opacity: 0.7 }}>
            Your speech will appear on the right,<br />
            AI responses on the left
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      style={{
        flex: 1,
        overflowY: 'auto',
        padding: '10px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
      }}
    >
      {chatMessages.map((msg) => (
        <MessageBubble
          key={msg.id}
          message={msg}
          isStreaming={msg.id === currentChatMsgId}
        />
      ))}
    </div>
  );
}

interface MessageBubbleProps {
  message: ChatMessage;
  isStreaming: boolean;
}

function MessageBubble({ message, isStreaming }: MessageBubbleProps) {
  const isUser = message.role === 'user';

  return (
    <div
      style={{
        display: 'flex',
        justifyContent: isUser ? 'flex-end' : 'flex-start',
      }}
    >
      <div
        style={{
          maxWidth: '85%',
          padding: '8px 12px',
          borderRadius: isUser
            ? '12px 12px 4px 12px'  // User: bottom-right corner flat
            : '12px 12px 12px 4px', // AI: bottom-left corner flat
          background: isUser
            ? 'var(--accent)'        // User: accent color
            : 'var(--bg-tertiary)',  // AI: muted background
          color: isUser
            ? '#0d1210'              // User: dark text on accent
            : 'var(--text-primary)', // AI: normal text
          fontSize: '11px',
          lineHeight: 1.5,
          wordBreak: 'break-word',
          position: 'relative',
        }}
      >
        {/* Role label */}
        <div
          style={{
            fontSize: '8px',
            fontWeight: 600,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            marginBottom: '4px',
            opacity: 0.7,
            color: isUser ? '#0d1210' : 'var(--text-muted)',
          }}
        >
          {isUser ? 'YOU' : 'AI'}
        </div>

        {/* Message text */}
        <div style={{ whiteSpace: 'pre-wrap' }}>
          {message.text || (isStreaming ? '' : '(empty)')}
          {isStreaming && (
            <span
              style={{
                display: 'inline-block',
                width: '6px',
                height: '12px',
                marginLeft: '2px',
                background: 'var(--text-muted)',
                animation: 'blink 1s infinite',
              }}
            />
          )}
        </div>

        {/* Timestamp */}
        <div
          style={{
            fontSize: '8px',
            marginTop: '4px',
            opacity: 0.5,
            textAlign: isUser ? 'right' : 'left',
          }}
        >
          {formatTime(message.timestamp)}
        </div>
      </div>
    </div>
  );
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}
