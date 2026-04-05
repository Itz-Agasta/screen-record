/**
 * src/main.tsx
 * ============
 * Renderer process entry point.
 * Mounts the React application into the #root div in index.html.
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root element not found in index.html');

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
