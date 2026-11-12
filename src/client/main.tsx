import { createRoot } from 'react-dom/client';
import { App } from './App';
import './style.css';

window.dispatchEvent(new Event('pb:app-started'));
createRoot(document.getElementById('root')!).render(<App />);
