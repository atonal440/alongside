# pwa/src/components/common/SettingsBanner.tsx

## Components

**`SettingsBanner`** — Collapsible configuration panel shown when `syncStatus` is `'offline'` and no API config is set. Contains form fields for the worker URL (`alongside_api`) and bearer token (`alongside_token`), and saves them to `localStorage` on submit, then dispatches `SET_API_CONFIG` to trigger an immediate sync attempt.
