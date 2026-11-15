import './auth.js';
import './account-ui.js';
import { boot } from './boot.js';
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
else boot();
