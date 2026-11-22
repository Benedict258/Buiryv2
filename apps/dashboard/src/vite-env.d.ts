/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** '1' builds the preview dashboard: no billing page, plan chip or upgrade prompts (Phase 9 D6). */
  readonly VITE_BUIRY_PREVIEW?: string;
}
