# Explicit schemes are part of Gitea Host identity

When a user provides `http://` or `https://` explicitly, `gtea` preserves that scheme as part of the Gitea Host identity across auth config, repository resolution, API requests, browse URL synthesis, and Git credential setup. Bare hostnames continue to default to `https://` for backward compatibility instead of probing transport or treating scheme as a per-command override.
