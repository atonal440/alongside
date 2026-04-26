# pwa/src/components/common/SettingsBanner.tsx

## Components

**`SettingsBanner`** — Collapsible reconnect panel shown only when the app has no worker config, such as after an explicit logout. Contains form fields for the worker URL (`alongside_api`) and bearer token (`alongside_token`), verifies them against the worker, then saves them to `localStorage`, clears the `alongside_logged_out` marker, and dispatches `SET_CONFIG` to trigger sync again. Offline-but-configured state is reported in the app shell instead of showing this panel.
