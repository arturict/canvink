import { useEffect, useRef, useState } from 'react';

export interface LandingClip {
  /** File name without extension in public/landing/ (see scripts/record-landing-clips.mjs). */
  name: string;
  /** Pixel size of the encoded clip; it reserves the space before anything loads. */
  width: number;
  height: number;
  /** What the clip shows, for people who cannot see it. */
  label: string;
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return reduced;
}

/**
 * A muted, looping clip that downloads and plays only while it is on screen.
 * With `prefers-reduced-motion` it is a still poster and no video file is
 * requested at all.
 */
export function LandingVideo({ clip, priority = false }: { clip: LandingClip; priority?: boolean }) {
  const reduced = usePrefersReducedMotion();
  const video = useRef<HTMLVideoElement>(null);
  const poster = `/landing/${clip.name}-poster.webp`;

  useEffect(() => {
    const element = video.current;
    if (!element || reduced) return undefined;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) element.play().catch(() => undefined);
        else element.pause();
      },
      { threshold: 0.35 },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [reduced]);

  if (reduced) {
    return (
      <img
        className="lp-media"
        src={poster}
        width={clip.width}
        height={clip.height}
        alt={clip.label}
        loading={priority ? 'eager' : 'lazy'}
        decoding="async"
      />
    );
  }

  return (
    <video
      ref={video}
      className="lp-media"
      width={clip.width}
      height={clip.height}
      poster={poster}
      muted
      loop
      playsInline
      preload="none"
      aria-label={clip.label}
    >
      <source src={`/landing/${clip.name}.webm`} type="video/webm" />
      <source src={`/landing/${clip.name}.mp4`} type="video/mp4" />
    </video>
  );
}
