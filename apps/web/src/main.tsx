import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { startApplication } from './state/boot';
import './styles/fonts';
import './styles/tokens.css';
import './styles/global.css';
import './styles/stage.css';
import './styles/reader.css';
import './styles/upload.css';
import './styles/ink.css';
import './styles/diary.css';
import './styles/truth.css';
import './styles/settings.css';
import './styles/fallback.css';

const container = document.getElementById('root');
if (!container) throw new Error('The page has no #root element to mount the application in');

startApplication();
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
