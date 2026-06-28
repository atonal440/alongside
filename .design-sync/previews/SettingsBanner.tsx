import { SettingsBanner } from 'alongside-pwa';

// SettingsBanner only renders when state.isConfigured is false (which is the default
// in the preview environment because apiBase is empty).
export function Default() {
  return (
    <div style={{ maxWidth: 480, padding: 16 }}>
      <SettingsBanner />
    </div>
  );
}
