import '@fontsource/orbitron/500.css';
import '@fontsource/orbitron/700.css';
import '@fontsource/orbitron/900.css';
import '@fontsource/share-tech-mono/400.css';
import './ui/styles/base.css';
import { startApp } from './ui/app';

startApp(document.getElementById('app')!);

// Register the custom service worker for offline support.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Vite PWA plugin will handle registration; fall back gracefully.
    });
  });
}
