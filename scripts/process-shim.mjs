import { Buffer as BufferPolyfill } from 'buffer';

export const Buffer = BufferPolyfill;

export const process = {
  env: { NODE_ENV: 'production', BROWSER: 'true' },
  version: '',
  platform: 'browser',
  stdout: null,
  stderr: null,
  cwd: () => '/',
  nextTick: (fn, ...args) => setTimeout(() => fn(...args), 0),
};
