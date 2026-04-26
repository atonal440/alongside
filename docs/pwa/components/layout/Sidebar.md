# pwa/src/components/layout/Sidebar.tsx

Primary navigation for desktop (`Sidebar`) and compact widths (`CompactNavigation`). Both variants expose Today, All Tasks, Review, project filters, sync status, and logout when worker credentials are configured.

## Logout

The shared logout path first clears IndexedDB task, project, link, and pending-op stores, then removes worker credentials from `localStorage`, dispatches `LOG_OUT`, and returns the UI to Today. If IndexedDB clearing fails, logout is cancelled and a toast is shown so cached data is not left behind for a later credential set.
