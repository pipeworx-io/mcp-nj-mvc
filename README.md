# @pipeworx/nj-mvc

New Jersey DMV data: **Motor Vehicle Commission (MVC)** inspection and emission-repair
facilities, and the record-level vehicle-inspection results file. Keyless.

## What New Jersey calls its DMV

New Jersey's agency is the **Motor Vehicle Commission**, universally the **MVC**. Residents say
"MVC agency" where other states say "DMV office", so the tool descriptions name both.

## Tools

| Tool | What it returns |
|---|---|
| `nj_mvc_inspection_facilities` | All 1,167 licensed private/state inspection and emission-repair facilities — name, address, town, phone, licence id, what they inspect |
| `nj_mvc_vehicle_inspections` | Pass/fail rates aggregated from 2,314,032 individual inspection tests, by make, model, model year, fuel, body style, test type or cylinder count |

## Auth

None. `data.nj.gov` is a public Socrata portal; the public rate limit handles these queries
without an app token.

## The distinctive dataset

`gvur-kt7q` is **2,314,032 per-test records**, each carrying make, model, model year, fuel,
full OBD-II readiness monitors, and *separate* emissions and safety verdicts. No other state
publishes inspection outcomes at that grain, which is what makes "which cars fail New Jersey
emissions inspection most" answerable at all.

Live-verified statewide numbers: 2,080,550 passes and 233,477 failures — about a **10% overall
fail rate**. Split by test type, initial tests fail 8.7% of the time and re-tests 26.7%.

`min_tests` (default 100) exists because a fail-rate ranking without it is meaningless — a
model with three tests and two failures would top every table. `sort="fail_rate"` ranks by
failure share; the default ranks by volume.

## Gotchas worth knowing

These are live-verified behaviours, not guesses:

- **The facility file's `county` column contradicts the address on some rows.** A
  `WATERFORD WORK` address — Waterford Works is in **Camden** County — is labelled `MORRIS`.
  The `county` filter is kept because agents ask for counties, but **prefer `city`** when the
  answer has to be right, and the response says so in its `note`.
- **These are inspection and repair shops, not licensing agencies.** Someone asking where to
  renew a New Jersey licence needs an MVC *agency*, which this file does not contain. The tool
  description is explicit so a router does not send that question here.
- **Town names are abbreviated and upper case** (`WATERFORD WORK`, not "Waterford Works"), so a
  partial city string matches more reliably than a full one.
- **Coordinates are missing on some facility rows** — `geocoded_column` is absent rather than
  null, so `latitude`/`longitude` come back null for those.
- **Inspection rows are tests, not vehicles.** A car that fails and returns is counted twice;
  `test_type="R"` isolates the re-tests.
- **`emissions_failures` and `safety_failures` can overlap** and do not have to sum to `failed`,
  which is the overall verdict column.
- **Makes and models are upper case and abbreviated** (`TOYOTA`, `CAMRY`, `F150`).
- **Model years include junk** — a handful of rows carry 2033 and 2041. `min_tests` filters
  them out of any ranking by construction.
- **`nja_vhcl_type` is empty on every row** despite being documented as P/T/H, so it is not
  offered as a `group_by`. `nja_body_style` is the working equivalent.
- **`as_of` is fetched concurrently with the data**, not after it. The 2.3M-row aggregate earns
  a Socrata throttle, and the metadata helper does not retry, so a sequential call
  intermittently returned a null refresh date.
- **The inspection file was last refreshed 2026-03-12**; the facility file 2026-07-20. Both are
  reported in `as_of` rather than assumed current.

## Data sources

- [data.nj.gov](https://data.nj.gov) Socrata `t6tk-mr48` — Vehicle Inspection Facility Locations
- [data.nj.gov](https://data.nj.gov) Socrata `gvur-kt7q` — Vehicle Inspection Data

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "nj-mvc": {
      "url": "https://gateway.pipeworx.io/nj-mvc/mcp"
    }
  }
}
```

Or connect to the full Pipeworx gateway for access to all 1392+ data sources:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English:

```
ask_pipeworx({ question: "your question about New Jersey MVC data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [All tools and guides](https://github.com/pipeworx-io/examples)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
