declare global {
  /** The id of this build, compiled in by vite.config.ts and also written into /sw.js. */
  const __DUELWISE_BUILD__: string
}

export {}
