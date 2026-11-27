import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/bricolage-grotesque/wdth.css';
import '@fontsource-variable/jetbrains-mono/wght.css';
import './ui/styles.css';
import { App } from './ui/App';
import { installTooltips } from './ui/tooltip';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
installTooltips();
