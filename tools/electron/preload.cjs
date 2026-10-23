/**
 * LED Wall — preload bridge.
 *
 * The one thing the page cannot do from its own sandbox is grant itself a
 * USER GESTURE, and Web Serial's requestPort() demands one. In a browser
 * that demand is correct - a human clicked Connect. In the app the human
 * already said yes at install (the permission handler), so the shell hands
 * the page a trusted gesture on request: 'wall-shell-gesture' dispatches a
 * synthetic key event through the debugger API, which is a real input event
 * with real transient activation, and the page spends it on requestPort().
 * No clicks, no dark wall after a reboot - and no fake grant hidden in a
 * browser: this bridge exists only inside the app binary.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wallShell', {
  requestGesture: () => ipcRenderer.invoke('wall-shell-gesture'),
});
