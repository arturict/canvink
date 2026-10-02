import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { ClerkGate } from './auth';
import { registerCanvinkServiceWorker } from './pwa/registerServiceWorker';
import { VIEWER_APP } from './platform/viewerApp';
import { installKeyboardInset } from './ui/keyboardInset';
import { installNativeMenuGuard, installTouchMode } from './ui/touchMode';
import './styles.css';
import './touch.css';
import './viewer.css';

const root = document.getElementById('root');

if (!root) {
  throw new Error('Canvink could not find its root element.');
}

if (VIEWER_APP) document.documentElement.dataset.viewer = 'true';
installTouchMode();
installNativeMenuGuard();
// The phone app's window shrinks for the keyboard (see MainActivity).
installKeyboardInset({ overlay: !VIEWER_APP });

createRoot(root).render(
  <StrictMode>
    <ClerkGate>
      <App />
    </ClerkGate>
  </StrictMode>,
);

void registerCanvinkServiceWorker();
