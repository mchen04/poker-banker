import { createRoot } from 'react-dom/client';
import { App } from './App';
import './style.css';

const standalone = window.matchMedia('(display-mode: standalone)').matches || window.matchMedia('(display-mode: fullscreen)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
document.documentElement.dataset.displayMode = standalone ? 'standalone' : 'browser';
window.dispatchEvent(new Event('pb:app-started'));
createRoot(document.getElementById('root')!).render(<App />);
