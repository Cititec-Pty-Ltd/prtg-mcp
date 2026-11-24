# Changelog

Releases are cut by semantic-release from the commit messages on `main` (the
"Cititec release" workflow); it adds an entry above this line for each release
and publishes the image to `ghcr.io/cititec-pty-ltd/prtg-mcp`.

## 1.0.0

First release: a read-only MCP server for Paessler PRTG Network Monitor over the
classic HTTP API (`/api/table.json`, `status.json`, `getsensordetails.json`,
`historicdata.json`), stdio transport.

- 11 tools: `prtg_status`, `prtg_list_probes`, `prtg_list_groups`,
  `prtg_list_devices`, `prtg_get_device`, `prtg_list_sensors`,
  `prtg_list_alarms`, `prtg_get_sensor`, `prtg_get_sensor_history`,
  `prtg_list_logs`, `prtg_search`.
- API token (`PRTG_API_TOKEN`), scrubbed from every error; https required unless
  `PRTG_ALLOW_HTTP=true`; `PRTG_ACCEPT_SELF_SIGNED=true` for a self-signed
  certificate.
- Paged and bounded results (500 rows a page, 60,000 characters a result);
  historic data at most 31 days a call, summarised per channel.
- Results with device-supplied text are wrapped in `<prtg-data>` as untrusted
  data.
- Fleet 429 policy: a read is retried once when the wait is 10 s or less,
  otherwise a structured `rate_limited` error.
