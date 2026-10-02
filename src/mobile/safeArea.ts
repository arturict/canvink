import { useEffect, useState } from 'react';

/**
 * The status bar's and navigation bar's height in CSS pixels, as the shell's
 * CSS sees them (--safe-top and --safe-bottom in mobile.css: the native
 * insets in the app, env(safe-area-inset-*) in a browser).
 */
export interface SafeArea {
  top: number;
  bottom: number;
}

function measure(): SafeArea {
  if (typeof document === 'undefined') return { top: 0, bottom: 0 };
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;padding-top:var(--safe-top,0px);padding-bottom:var(--safe-bottom,0px);';
  probe.className = 'm-safe-probe';
  (document.querySelector('.m-app') ?? document.body).appendChild(probe);
  const style = getComputedStyle(probe);
  const area = { top: parseFloat(style.paddingTop) || 0, bottom: parseFloat(style.paddingBottom) || 0 };
  probe.remove();
  return area;
}

export function useSafeArea(): SafeArea {
  const [area, setArea] = useState<SafeArea>(measure);
  useEffect(() => {
    const update = () => setArea((current) => {
      const next = measure();
      return next.top === current.top && next.bottom === current.bottom ? current : next;
    });
    update();
    window.addEventListener('resize', update);
    window.addEventListener('canvink:insets', update);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('canvink:insets', update);
    };
  }, []);
  return area;
}
