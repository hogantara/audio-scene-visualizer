import { useEffect, useRef } from 'react';

export default function Waveform({ peaks, height = 64 }: { peaks: number[]; height?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = 'rgba(79, 70, 229, 0.55)';
    const n = peaks.length;
    const barW = width / n;
    for (let i = 0; i < n; i++) {
      const h = Math.max(1.5, peaks[i] * (height - 6));
      ctx.fillRect(i * barW, (height - h) / 2, Math.max(1, barW - 0.8), h);
    }
  }, [peaks, height]);

  return <canvas ref={ref} className="waveform" style={{ height }} />;
}
