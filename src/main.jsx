import React from 'react';
import { createRoot } from 'react-dom/client';

// Carbon Design System + Carbon Charts prebuilt stylesheets.
import '@carbon/styles/css/styles.css';
import '@carbon/charts/styles.css';

// App-level styles (fonts, layout, animations, ported wireframe CSS).
import './styles/global.css';

import App from './App.jsx';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
