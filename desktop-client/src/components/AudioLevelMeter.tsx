/**
 * src/components/AudioLevelMeter.tsx
 * ===================================
 * Real-time audio level visualization to confirm microphone is capturing sound.
 * 
 * Shows a horizontal bar that responds to audio input levels.
 * Uses Web Audio API's AnalyserNode to measure audio amplitude.
 */

import React, { useEffect, useRef, useState } from 'react';

interface AudioLevelMeterProps {
  stream: MediaStream | null;
  isRecording: boolean;
}

export function AudioLevelMeter({ stream, isRecording }: AudioLevelMeterProps) {
  const [level, setLevel] = useState(0);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationRef = useRef<number | null>(null);

  useEffect(() => {
    if (!stream || !isRecording) {
      setLevel(0);
      return;
    }

    // Create audio context and analyser
    const audioContext = new AudioContext();
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.3;

    const source = audioContext.createMediaStreamSource(stream);
    source.connect(analyser);

    audioContextRef.current = audioContext;
    analyserRef.current = analyser;

    const dataArray = new Uint8Array(analyser.frequencyBinCount);

    const updateLevel = () => {
      if (!analyserRef.current) return;

      analyserRef.current.getByteFrequencyData(dataArray);
      
      // Calculate average level
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        sum += dataArray[i];
      }
      const average = sum / dataArray.length;
      
      // Normalize to 0-100 range
      const normalizedLevel = Math.min(100, (average / 128) * 100);
      setLevel(normalizedLevel);

      animationRef.current = requestAnimationFrame(updateLevel);
    };

    updateLevel();

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
      if (audioContextRef.current) {
        audioContextRef.current.close();
      }
      setLevel(0);
    };
  }, [stream, isRecording]);

  // Don't render if not recording
  if (!isRecording) {
    return null;
  }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '6px 0',
      }}
    >
      <span
        style={{
          color: 'var(--text-muted)',
          fontSize: '9px',
          letterSpacing: '0.05em',
          fontWeight: 500,
          minWidth: '30px',
        }}
      >
        MIC
      </span>
      
      {/* Level bar container */}
      <div
        style={{
          flex: 1,
          height: '8px',
          background: 'var(--bg-tertiary)',
          borderRadius: '4px',
          overflow: 'hidden',
          position: 'relative',
        }}
      >
        {/* Level indicator */}
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            height: '100%',
            width: `${level}%`,
            background: level > 70 
              ? '#ef4444' // Red for loud
              : level > 40 
                ? '#f59e0b' // Orange for medium
                : '#22c55e', // Green for normal
            borderRadius: '4px',
            transition: 'width 50ms ease-out',
          }}
        />
        
        {/* Grid lines for reference */}
        <div
          style={{
            position: 'absolute',
            left: '25%',
            top: 0,
            bottom: 0,
            width: '1px',
            background: 'rgba(255,255,255,0.1)',
          }}
        />
        <div
          style={{
            position: 'absolute',
            left: '50%',
            top: 0,
            bottom: 0,
            width: '1px',
            background: 'rgba(255,255,255,0.1)',
          }}
        />
        <div
          style={{
            position: 'absolute',
            left: '75%',
            top: 0,
            bottom: 0,
            width: '1px',
            background: 'rgba(255,255,255,0.1)',
          }}
        />
      </div>
      
      {/* Level percentage */}
      <span
        style={{
          color: 'var(--text-muted)',
          fontSize: '9px',
          fontFamily: 'var(--font-mono)',
          minWidth: '28px',
          textAlign: 'right',
        }}
      >
        {Math.round(level)}%
      </span>
    </div>
  );
}
