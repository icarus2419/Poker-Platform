const { contextBridge } = require('electron');

// Inject the Vercel backend URL so all API calls from the frontend
// go to the shared server — enabling cross-platform multiplayer
// between desktop app users and website users.
const API_BASE = process.env.POKER_API_BASE || 'https://e-port-git-main-icarus2419s-projects.vercel.app';

contextBridge.exposeInMainWorld('POKER_API_BASE', API_BASE);
