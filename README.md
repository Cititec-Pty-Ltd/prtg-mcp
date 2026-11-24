# PRTG MCP server

A read-only MCP server for [Paessler PRTG Network Monitor](https://www.paessler.com/prtg). Claude can ask PRTG what is down right now, find a client's group, device or sensor by name or address, read a sensor's channels and its history, and read the log.

It uses the same framework as Cititec's other MCP servers: TypeScript, `@modelcontextprotocol/sdk`, a stdio transport, vitest tests, tsup and a Docker image.

## Why the classic API

PRTG has two HTTP APIs:

- the **classic API** (`/api/table.json` and friends), served by the PRTG web interface on every on-premises version;
- **API v2** (PRTG 25+), served by a separate Application Server (port 1616) that has to be activated, and that is not available on PRTG Hosted Monitor or in cluster mode.

This server uses the classic API, so it works on any on-premises PRTG from 22.1 (when API keys arrived), including 25.x whether or not API v2 is activated. [WYRE-AI/prtg-mcp](https://github.com/WYRE-AI/prtg-mcp) covers API v2.

**Adding API v2 later:** every PRTG request goes through `src/client.ts` (`Api.get` and `Api.table`, over a fixed list of endpoints), and the tools only see the `Api` interface plus the row mappers in `src/tools/format.ts`. A v2 backend would be a second `Api` implementation, chosen by a setting such as `PRTG_API=v2` with its own base URL (the Application Server, port 1616), that maps v2 objects onto the same rows. The tools and their output would not change.

## The API

- **Authentication:** an **API key** of a PRTG user, sent as the `apitoken` query parameter on every request. A key has every right of its user and cannot be narrowed, so **create a dedicated read-only PRTG user** with access to the groups Claude may see, then create the key under that user (**Setup > Account Settings > My Account > API Keys**). `prtg_status` reports whether the key's user is read-only.
- **Endpoints used:** `GET /api/status.json`, `/api/table.json` (`content=probenodes|groups|devices|sensors|channels|messages`, fixed columns), `/api/getsensordetails.json` and `/api/historicdata.json`. No tool takes a free-form endpoint, column or filter. No tool changes anything in PRTG.
- **Paging:** `count` (at most 500) and `start`; PRTG's `treesize` is the total. Every list returns `total`, `count`, `offset` and `nextOffset` when there is more.
- **Filters:** states become `filter_status` codes (PRTG ORs repeats); names and hosts become `filter_name=@sub(text)` / `filter_host=@sub(text)` (text with a parenthesis is refused); a parent becomes `id=` (everything below that object).
- **Times:** PRTG reads and writes historic-data times in the core server's local time, so set `PRTG_TIME_ZONE`.

## Configuration

| Variable | |
|---|---|
| `PRTG_URL` | The PRTG web interface address as typed in a browser, https: `https://prtg.example.local`. A trailing `/`, `/api` or `/index.htm` is accepted. Not the API v2 port 1616. |
| `PRTG_API_TOKEN` | The API key. Never logged; removed from every error message (also URL-encoded, and any `apitoken=` value). |
| `PRTG_ACCEPT_SELF_SIGNED` | `true` only when the PRTG certificate is self-signed or not issued for the name in `PRTG_URL`. The connection stays encrypted but the server is not authenticated, so use it only over a trusted path (VPN). Default `false`. |
| `PRTG_TIME_ZONE` | The PRTG core server's IANA time zone, e.g. `Australia/Sydney`. Default `UTC`. |
| `PRTG_ALLOW_HTTP` | `true` allows an `http://` URL. The key then crosses the network in clear text. Default `false`. |
| `PRTG_UNTRUSTED_MARKERS` | `off` disables the `<prtg-data>` wrapper (below). |
| `LOG_LEVEL` | `debug`, `info` (default), `warn`, `error`, to stderr. Tool arguments and the key are never logged. |

## Tools

| Tool | What it does |
|------|--------------|
| `prtg_status` | Version, server clock, sensor counts by state, new alarms and log entries, whether the key's user is read-only or an administrator (`status.json`). |
| `prtg_list_probes` | Probes with connection state and sensor counts. |
| `prtg_list_groups` | Groups (often one per client or site), by name or below a probe/group, with sensor counts. |
| `prtg_list_devices` | Devices by name, host, state or parent, with sensor counts. |
| `prtg_get_device` | One device, every sensor that is not up (with its message), and the names of those that are. |
| `prtg_list_sensors` | Sensors by state (`down`, `down_partial`, `down_acknowledged`, `warning`, `unusual`, `paused`, `up`, `unknown`), name or parent. |
| `prtg_list_alarms` | Down and partially down sensors, plus acknowledged, warning and unusual ones (each can be turned off), worst first across every page (one table read per state, so paging is exact), with how long they have been down, and the whole-server counts. |
| `prtg_get_sensor` | One sensor's details (`getsensordetails.json`) and every channel's last value; a traffic channel gives its speed (`lastValue`) and its volume (`volume`). PRTG's `lastvalue_` column repeats the same JSON key for the two, so that one response is read with a parser that keeps repeated keys. |
| `prtg_get_sensor_history` | Historic data over `hours` back from now or `start`/`end` (server local time), at most 31 days. Per-channel min, max, mean and last over every interval, plus up to `max_rows` (default 100, max 500) evenly spaced intervals. The average is picked so the range is about 300 intervals unless `average_seconds` is given (raw values only for 24 hours or less). |
| `prtg_list_logs` | Log entries, newest first, for `today`, `yesterday`, `7days`, `30days`, `6months` or `12months`, for the whole server or one object and below. |
| `prtg_search` | Groups and sensors whose name contains the text, devices whose name or host contains it. |

Results are trimmed to useful fields, HTML tags and entities in PRTG's text are cleaned, and each response is capped at 60,000 characters.

### Untrusted text

Almost everything PRTG returns was written by someone or something other than the MSP: device and sensor names come from auto-discovery (a device's own host name, its SNMP sysName), sensor messages and channel names come from the monitored device's answers, and log entries repeat both. Every result except `prtg_status` is wrapped in a `<prtg-data>` block followed by a reminder that it is data, not instructions. A closing tag inside the data is neutralized, so it cannot end the block early. This is a label, not a guarantee; what bounds the damage is that every tool is read-only and the key's user is read-only.

### Rate limits

PRTG itself does not throttle the API, but large tables and historic data load the core server. The Cititec MCP host applies its own per-service rate limit. If a proxy answers HTTP 429, a read is retried once when the wait is 10 s or less; otherwise the tool returns a structured `rate_limited` error with `retryAfterSeconds` (fleet 429 policy).

## Development

```bash
npm ci
npm run lint    # tsc --noEmit
npm test        # vitest
npm run build   # tsup -> dist/index.js
```

## Docker

```bash
docker build -t prtg-mcp .
docker run --rm -i --env-file prtg.env prtg-mcp
```

stdio only: the Cititec MCP host runs one container per connection with the service's env file. The **Cititec release** workflow tags a release with semantic-release on every merge to `main` and pushes `ghcr.io/cititec-pty-ltd/prtg-mcp:vX.Y.Z` (and `:latest`).

## Licence

Apache 2.0. See `LICENSE` and `NOTICE`.
