import { useCallback, useEffect, useState } from 'react';

/** The install prompt Chromium browsers offer; it is not part of the DOM typings. */
interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

function isInstallPrompt(event: Event): event is InstallPromptEvent {
  return 'prompt' in event && typeof event.prompt === 'function';
}

export interface InstallState {
  /** The browser can show its install dialog right now. */
  canPrompt: boolean;
  /** Canvink already runs as an installed app. */
  installed: boolean;
  install: () => Promise<void>;
}

export function useInstallPrompt(): InstallState {
  const [event, setEvent] = useState<InstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(() => window.matchMedia('(display-mode: standalone)').matches);

  useEffect(() => {
    const onPrompt = (candidate: Event) => {
      if (!isInstallPrompt(candidate)) return;
      // Keep the browser's own mini bar away; the button below asks instead.
      candidate.preventDefault();
      setEvent(candidate);
    };
    const onInstalled = () => {
      setInstalled(true);
      setEvent(null);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const install = useCallback(async () => {
    if (!event) return;
    await event.prompt();
    const { outcome } = await event.userChoice;
    if (outcome === 'accepted') setEvent(null);
  }, [event]);

  return { canPrompt: event !== null, installed, install };
}
