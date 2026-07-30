interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Runtime helpers for packs that wrap government open-data platforms.
 *
 * Socrata (SODA), CKAN, and ArcGIS FeatureServer/MapServer between them back a large share
 * of US state and municipal data, and every pack over them re-implements the same fetch,
 * timeout, retry, and shaping code. These helpers are deliberately small and dependency-free
 * so `scripts/publish-pack.sh` can inline them into a standalone published pack.
 *
 * State agency servers are slow and occasionally hostile: expect stalls, WAF interstitials
 * served with a 200 or 403, and columns whose names disagree between two datasets on the same
 * portal. `govFetchJson` therefore retries once by default and raises a message the caller can
 * turn into a `{ found: false, reason, hint }` rather than a bare throw.
 */

const DEFAULT_UA = 'pipeworx-mcp/1.0 (+https://pipeworx.io)';
const DEFAULT_TIMEOUT_MS = 15_000;

interface GovFetchOpts {
  /** Sent as Accept; defaults to application/json. */
  accept?: string;
  /** Socrata app token, sent as X-App-Token. Public endpoints work without one. */
  appToken?: string;
  /** Per-attempt budget. State ArcGIS servers routinely need >12s under load. */
  timeoutMs?: number;
  /** Extra attempts after the first. Defaults to 1. */
  retries?: number;
  userAgent?: string;
}

async function govFetchText(url: string, opts: GovFetchOpts = {}): Promise<string> {
  const retries = opts.retries ?? 1;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const headers: Record<string, string> = {
        'User-Agent': opts.userAgent ?? DEFAULT_UA,
        Accept: opts.accept ?? 'application/json',
      };
      if (opts.appToken) headers['X-App-Token'] = opts.appToken;
      const res = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`upstream ${res.status}${body ? `: ${body.slice(0, 180)}` : ''}`);
      }
      return await res.text();
    } catch (err) {
      lastErr = err;
      if (attempt === retries) break;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function govFetchJson<T = unknown>(url: string, opts: GovFetchOpts = {}): Promise<T> {
  const text = await govFetchText(url, opts);
  try {
    return JSON.parse(text) as T;
  } catch {
    // A WAF interstitial arrives as HTML on the JSON path; say so plainly, because the
    // alternative reads to a caller as our own parsing bug.
    const looksLikeChallenge = /<html|just a moment|captcha/i.test(text.slice(0, 400));
    throw new Error(
      looksLikeChallenge
        ? `upstream returned an HTML challenge page instead of JSON (${text.slice(0, 90).replace(/\s+/g, ' ')})`
        : `upstream returned non-JSON (${text.slice(0, 120)})`,
    );
  }
}

// ── Socrata (SODA 2.x) ──────────────────────────────────────────────

interface SoqlQuery {
  select?: string;
  where?: string;
  group?: string;
  order?: string;
  limit?: number;
  offset?: number;
}

/** Escape a value for interpolation into a SoQL string literal. */
function soqlEscape(v: string): string {
  return v.replace(/'/g, "''");
}

function soqlUrl(domain: string, resource: string, q: SoqlQuery): string {
  const p = new URLSearchParams();
  if (q.select) p.set('$select', q.select);
  if (q.where) p.set('$where', q.where);
  if (q.group) p.set('$group', q.group);
  if (q.order) p.set('$order', q.order);
  p.set('$limit', String(q.limit ?? 1000));
  if (q.offset) p.set('$offset', String(q.offset));
  return `https://${domain}/resource/${resource}.json?${p.toString()}`;
}

async function soqlRows<T = Record<string, string>>(
  domain: string,
  resource: string,
  q: SoqlQuery,
  opts: GovFetchOpts = {},
): Promise<T[]> {
  return govFetchJson<T[]>(soqlUrl(domain, resource, q), opts);
}

/**
 * A Socrata dataset's last row update, as YYYY-MM-DD, for an `as_of` field. Best-effort:
 * resolves to null rather than failing a call that otherwise has data.
 */
async function soqlUpdatedAt(
  domain: string,
  resource: string,
  opts: GovFetchOpts = {},
): Promise<string | null> {
  try {
    const meta = await govFetchJson<{ rowsUpdatedAt?: number }>(
      `https://${domain}/api/views/${resource}.json`,
      { ...opts, retries: 0 },
    );
    return meta.rowsUpdatedAt ? new Date(meta.rowsUpdatedAt * 1000).toISOString().slice(0, 10) : null;
  } catch {
    return null;
  }
}

/** Largest value of a column, e.g. the latest `year_month` a dataset carries. */
async function soqlMax(
  domain: string,
  resource: string,
  column: string,
  opts: GovFetchOpts = {},
): Promise<string | null> {
  try {
    const rows = await soqlRows<Record<string, string>>(
      domain,
      resource,
      { select: `max(${column}) as mx` },
      opts,
    );
    return rows[0]?.mx ?? null;
  } catch {
    return null;
  }
}

// ── CKAN ────────────────────────────────────────────────────────────

/** CKAN's read-only SQL endpoint (datastore_search_sql). */
async function ckanSql<T = Record<string, string>>(
  domain: string,
  sql: string,
  opts: GovFetchOpts = {},
): Promise<T[]> {
  const body = await govFetchJson<{
    success?: boolean;
    result?: { records?: T[] };
    error?: unknown;
  }>(`https://${domain}/api/3/action/datastore_search_sql?sql=${encodeURIComponent(sql)}`, opts);
  if (!body.success || !body.result?.records) {
    throw new Error(`CKAN rejected the query: ${JSON.stringify(body.error ?? {}).slice(0, 200)}`);
  }
  return body.result.records;
}

async function ckanRows<T = Record<string, unknown>>(
  domain: string,
  resourceId: string,
  limit: number,
  opts: GovFetchOpts = {},
): Promise<T[]> {
  const body = await govFetchJson<{ result?: { records?: T[] } }>(
    `https://${domain}/api/3/action/datastore_search?resource_id=${resourceId}&limit=${limit}`,
    opts,
  );
  return body.result?.records ?? [];
}

// ── ArcGIS (FeatureServer / MapServer) ──────────────────────────────

interface ArcgisFeature {
  attributes: Record<string, unknown>;
  geometry?: { x?: number; y?: number };
}

interface ArcgisQueryOpts extends GovFetchOpts {
  where?: string;
  outFields?: string;
  orderBy?: string;
  limit?: number;
  /** Request geometry in WGS84. Many layers store State Plane, so read lat/lng from here
   *  rather than from XCOORD/YCOORD attribute columns. */
  geometry?: boolean;
  distinct?: boolean;
}

async function arcgisQuery(layerUrl: string, o: ArcgisQueryOpts = {}): Promise<ArcgisFeature[]> {
  const p = new URLSearchParams({
    where: o.where ?? '1=1',
    outFields: o.outFields ?? '*',
    returnGeometry: o.geometry ? 'true' : 'false',
    f: 'json',
  });
  if (o.geometry) p.set('outSR', '4326');
  if (o.orderBy) p.set('orderByFields', o.orderBy);
  if (o.limit) p.set('resultRecordCount', String(o.limit));
  if (o.distinct) p.set('returnDistinctValues', 'true');
  const body = await govFetchJson<{ features?: ArcgisFeature[]; error?: { message?: string } }>(
    `${layerUrl}/query?${p.toString()}`,
    o,
  );
  if (body.error) throw new Error(`ArcGIS: ${body.error.message ?? 'query rejected'}`);
  return body.features ?? [];
}

/** Turn "Y"/"Yes"/"true" flag columns into a list of human-readable service labels. */
function arcgisFlagLabels(
  attrs: Record<string, unknown>,
  labelByField: Record<string, string>,
): string[] {
  return Object.entries(labelByField)
    .filter(([field]) => /^(y|yes|true)$/i.test(String(attrs[field] ?? '')))
    .map(([, label]) => label);
}

// ── Small shaping utilities ─────────────────────────────────────────

/** A recoverable "no answer" result. The hint should name something that does work. */
function govNotFound(
  reason: string,
  hint: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { found: false, reason, hint, ...extra };
}

function govNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if (s === '') return null;
  // Parse as-is first. Socrata returns an all-zero aggregate as "0E-24", and stripping
  // non-numeric characters turns that into "0-24" → NaN, i.e. a real zero reported as
  // unknown. Number() understands scientific notation, so only fall back to stripping
  // for values carrying formatting (currency symbols, thousands separators).
  const direct = Number(s);
  if (Number.isFinite(direct)) return direct;
  // Require a digit before stripping: otherwise "abc" reduces to "" and Number("") is 0,
  // reporting a parse failure as a real zero.
  if (!/\d/.test(s)) return null;
  const stripped = Number(s.replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(stripped) ? stripped : null;
}

/** Trimmed string argument, or undefined when absent or blank. */
function govString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s === '' ? undefined : s;
}

function govLimit(raw: unknown, def: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), max);
}

/** Case-insensitive substring test that tolerates a missing haystack. */
function govContains(hay: unknown, needle: string): boolean {
  return typeof hay === 'string' && hay.toLowerCase().includes(needle.toLowerCase());
}

/** Join day/hours pairs into one line, dropping closed and empty days. */
function govJoinHours(parts: Array<[string, unknown]>): string | null {
  const out = parts
    .filter(([, v]) => v && String(v).trim() && !/^closed$/i.test(String(v).trim()))
    .map(([day, v]) => `${day} ${String(v).trim()}`);
  return out.length ? out.join('; ') : null;
}


/**
 * New Jersey MVC MCP — Motor Vehicle Commission inspection and emission-repair facilities,
 * and the record-level vehicle-inspection results file. Keyless.
 *
 * One pack per state agency: New Jersey's distinctive asset is 2,314,032 individual
 * inspection records carrying make, model, model year, full OBD-II readiness and separate
 * emissions and safety verdicts. No other state publishes per-test pass/fail at that grain,
 * so the tools here aggregate pass rates by vehicle rather than counting registrations by
 * county the way most state files do.
 *
 * Sources (verified live 2026-07-30):
 *   data.nj.gov Socrata t6tk-mr48 — "Vehicle Inspection Facility Locations", 1,167 licensed
 *       private inspection, state inspection and emission-repair facilities (updated 2026-07-20)
 *   data.nj.gov Socrata gvur-kt7q — "Vehicle Inspection Data", 2,314,032 per-test records
 *       (updated 2026-03-12)
 *
 * DATA QUALITY: the facility file's `county` column disagrees with `adr_city` on some rows —
 * a Waterford Works address (Camden County) is labelled MORRIS. City matching is reliable;
 * county matching is not, and the tool says so in its response.
 *
 * Every tool resolves to a shaped object and never throws; a query that cannot be answered
 * comes back as { found: false, reason, hint }.
 */


const UA = 'pipeworx-mcp-nj-mvc/1.0 (+https://pipeworx.io)';
const DOMAIN = 'data.nj.gov';
const FACILITIES = 't6tk-mr48';
const INSPECTIONS = 'gvur-kt7q';

/** Exact `type` labels New Jersey publishes on the facility file. */
const FACILITY_TYPES = [
  'Private Inspection Facility',
  'Emission Repair Facility',
  'State Inspection Facility',
  'State Specialty Inspection Facility',
];

/** Exact `inspection_type` labels. */
const INSPECTION_TYPES = ['Auto Only', 'Emission Repair Only', 'Diesel Only', 'Auto and Diesel'];

/** Fuel codes as published, with the plain words agents pass. */
const FUEL_CODES: Record<string, string> = {
  gas: 'GASO', gasoline: 'GASO', petrol: 'GASO',
  diesel: 'DIES',
  electric: 'ELEC', ev: 'ELEC', bev: 'ELEC',
  hybrid: 'ELEG', 'gas electric': 'ELEG', phev: 'ELEG',
  cng: 'CNGA', 'natural gas': 'CNGA',
  propane: 'PROP', hydrogen: 'HYDR',
};

/** group_by key → the column New Jersey stores it in. */
const GROUP_COLUMNS: Record<string, string> = {
  make: 'nja_make',
  model: 'nja_model',
  model_year: 'nja_model_yr',
  fuel: 'nja_fuel_cd',
  body_style: 'nja_body_style',
  test_type: 'nja_test_type',
  cylinders: 'nja_no_of_cyl',
};

const tools: McpToolExport['tools'] = [
  {
    name: 'nj_mvc_inspection_facilities',
    description:
      'Find a licensed New Jersey vehicle inspection or emission-repair facility — the private inspection stations, state inspection stations and registered emission repair shops overseen by the New Jersey Motor Vehicle Commission (MVC), the agency other states call the DMV. Returns the business name, street address, town, phone, licence id and whether it inspects cars, diesel or both. Answers "where can I get my car inspected in Edison NJ", "NJ diesel inspection station near ZIP 07740", "emission repair facility in Monmouth County", and "how many private inspection facilities does New Jersey license". Covers all 1,167 licensed facilities. For a driver license, ID card or registration renewal, the MVC runs separate licensing agencies that this file leaves out.',
    inputSchema: {
      type: 'object',
      properties: {
        city: { type: 'string', description: 'Town name, matched as a substring, e.g. "Edison", "Long Branch". More reliable than county.' },
        county: { type: 'string', description: 'County name, e.g. "Morris", "Monmouth". Upstream mislabels some rows — prefer city.' },
        zip: { type: 'string', description: 'Five-digit New Jersey ZIP code, or a prefix, e.g. "07740" or "077".' },
        name: { type: 'string', description: 'Business-name substring, e.g. "MIDAS", "AUTO".' },
        facility_type: { type: 'string', description: `Facility category: ${FACILITY_TYPES.map((t) => `"${t}"`).join(', ')}. Substrings such as "private" or "emission" also work.` },
        inspection_type: { type: 'string', description: `What the shop inspects: ${INSPECTION_TYPES.map((t) => `"${t}"`).join(', ')}. "diesel" alone matches both diesel categories.` },
        limit: { type: ['number', 'string'], description: 'Max facilities to return (default 50, max 200).' },
      },
    },
  },
  {
    name: 'nj_mvc_vehicle_inspections',
    description:
      'Measure how often cars pass or fail New Jersey vehicle inspection, from the Motor Vehicle Commission\'s record-level results file — 2,314,032 individual tests, each carrying make, model, model year, fuel, and separate emissions and safety verdicts. Returns test counts with pass rate, fail rate, and how many failures were emissions rather than safety, grouped by make, model, model year, fuel, body style or test type. Answers "which cars fail NJ emissions inspection most", "Toyota Camry NJ inspection failure rate", "do older cars fail New Jersey inspection more often", "NJ inspection pass rate by make", and "how many diesels does New Jersey inspect". Statewide overall, roughly 10% of tests fail.',
    inputSchema: {
      type: 'object',
      properties: {
        make: { type: 'string', description: 'Vehicle make, matched as a substring, e.g. "TOYOTA", "FORD", "HONDA".' },
        model: { type: 'string', description: 'Vehicle model, matched as a substring, e.g. "CAMRY", "F150".' },
        model_year: { type: 'string', description: 'Four-digit model year, e.g. "2015".' },
        fuel: { type: 'string', description: 'Fuel; plain words map to New Jersey\'s codes, e.g. "gas" (GASO), "diesel" (DIES), "hybrid" (ELEG), "electric" (ELEC).' },
        test_type: { type: 'string', description: 'I for an initial test, R for a re-test. Defaults to every test.' },
        group_by: { type: 'string', description: `Breakdown dimension: ${Object.keys(GROUP_COLUMNS).join(', ')}. Defaults to make.` },
        min_tests: { type: ['number', 'string'], description: 'Drop groups with fewer than this many tests before ranking, so a one-car model cannot top a failure-rate table. Default 100.' },
        sort: { type: 'string', description: 'tests (default) ranks by volume; fail_rate ranks by the share of tests that failed.' },
        limit: { type: ['number', 'string'], description: 'Max groups to return (default 25, max 200).' },
      },
    },
  },
];

// ── Facilities ──────────────────────────────────────────────────────

interface FacilityRow {
  type?: string;
  lic_id?: string;
  st_nm?: string;
  adr_street?: string;
  adr_city?: string;
  adr_state?: string;
  zip?: string;
  phone_no?: string;
  county?: string;
  inspection_type?: string;
  geocoded_column?: { latitude?: string; longitude?: string };
}

/** "8567676317" → "(856) 767-6317"; anything else passes through untouched. */
function formatPhone(raw: string | undefined): string | null {
  if (!raw) return null;
  const d = raw.replace(/\D/g, '');
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : raw;
}

async function inspectionFacilities(args: Record<string, unknown>): Promise<unknown> {
  // Fire the metadata lookup alongside the data query rather than after it: Socrata throttles
  // unauthenticated bursts, and soqlUpdatedAt never retries, so a sequential call loses `as_of`
  // to the throttle the data query just earned.
  const [rows, asOf] = await Promise.all([
    soqlRows<FacilityRow>(DOMAIN, FACILITIES, { limit: 2000 }, { userAgent: UA }),
    soqlUpdatedAt(DOMAIN, FACILITIES, { userAgent: UA }),
  ]);
  if (!rows.length) {
    return govNotFound('upstream_empty', 'data.nj.gov returned no inspection facilities; retry once — the file normally carries 1,167 rows.');
  }

  const city = govString(args, 'city');
  const county = govString(args, 'county');
  const zip = govString(args, 'zip');
  const name = govString(args, 'name');
  const facilityType = govString(args, 'facility_type');
  const inspectionType = govString(args, 'inspection_type');

  let list = rows;
  if (city) list = list.filter((r) => govContains(r.adr_city, city));
  if (county) list = list.filter((r) => govContains(r.county, county));
  if (zip) list = list.filter((r) => (r.zip ?? '').startsWith(zip));
  if (name) list = list.filter((r) => govContains(r.st_nm, name));
  if (facilityType) list = list.filter((r) => govContains(r.type, facilityType));
  if (inspectionType) list = list.filter((r) => govContains(r.inspection_type, inspectionType));

  if (!list.length) {
    return govNotFound(
      'no_matching_facilities',
      `No New Jersey inspection facility matched those filters. Town names are stored abbreviated and upper case ("WATERFORD WORK"), so a partial city works better than a full one; published categories are ${FACILITY_TYPES.join(', ')}.`,
      {
        filters_applied: { city, county, zip, name, facility_type: facilityType, inspection_type: inspectionType },
        total_facilities: rows.length,
        facility_types: FACILITY_TYPES,
        inspection_types: INSPECTION_TYPES,
      },
    );
  }

  const limit = govLimit(args.limit, 50, 200);
  return {
    state: 'NJ',
    agency: 'New Jersey Motor Vehicle Commission (MVC)',
    source: 'data.nj.gov — Vehicle Inspection Facility Locations (t6tk-mr48)',
    as_of: asOf,
    total_facilities: rows.length,
    office_count: list.length,
    truncated: list.length > limit,
    facility_types: FACILITY_TYPES,
    offices: list.slice(0, limit).map((r) => ({
      state: 'NJ',
      name: r.st_nm ?? '',
      office_type: r.type ?? null,
      address: r.adr_street ?? null,
      city: r.adr_city ?? null,
      county: r.county ?? null,
      zip: r.zip ?? null,
      phone: formatPhone(r.phone_no),
      // The facility file publishes no hours; shops set their own.
      hours: null,
      latitude: govNumber(r.geocoded_column?.latitude),
      longitude: govNumber(r.geocoded_column?.longitude),
      services: r.inspection_type ? [r.inspection_type] : [],
      url: null,
      license_id: r.lic_id ?? null,
    })),
    note: 'These are licensed inspection and emission-repair shops. New Jersey\'s `county` column is unreliable — some rows carry a county that contradicts the address (a Waterford Works address, which is Camden County, is labelled MORRIS), so filter by city when the answer has to be right. Coordinates are present on most but not all rows.',
  };
}

// ── Inspection results ──────────────────────────────────────────────

interface AggRow {
  grouped?: string;
  tests?: string;
  fails?: string;
  emiss_fails?: string;
  safety_fails?: string;
}

function pct(n: number, d: number): number | null {
  return d ? Math.round((n / d) * 1000) / 10 : null;
}

async function vehicleInspections(args: Record<string, unknown>): Promise<unknown> {
  const groupKey = (govString(args, 'group_by') ?? 'make').toLowerCase();
  const groupCol = GROUP_COLUMNS[groupKey];
  if (!groupCol) {
    return govNotFound(
      'unsupported_group_by',
      `New Jersey inspection results support group_by of ${Object.keys(GROUP_COLUMNS).join(', ')}. Use group_by="make" for a statewide ranking.`,
      { supported_group_by: Object.keys(GROUP_COLUMNS) },
    );
  }

  const clauses: string[] = [];
  const applied: Record<string, unknown> = {};
  const make = govString(args, 'make');
  if (make) {
    clauses.push(`upper(nja_make) like '%${soqlEscape(make.toUpperCase())}%'`);
    applied.make = make;
  }
  const model = govString(args, 'model');
  if (model) {
    clauses.push(`upper(nja_model) like '%${soqlEscape(model.toUpperCase())}%'`);
    applied.model = model;
  }
  const modelYear = govString(args, 'model_year');
  if (modelYear) {
    clauses.push(`nja_model_yr = '${soqlEscape(modelYear)}'`);
    applied.model_year = modelYear;
  }
  const rawFuel = govString(args, 'fuel');
  if (rawFuel) {
    const code = FUEL_CODES[rawFuel.toLowerCase()] ?? rawFuel.toUpperCase();
    clauses.push(`upper(nja_fuel_cd) = '${soqlEscape(code)}'`);
    applied.fuel = code;
  }
  const testType = govString(args, 'test_type');
  if (testType) {
    clauses.push(`upper(nja_test_type) = '${soqlEscape(testType.toUpperCase())}'`);
    applied.test_type = testType.toUpperCase();
  }

  const limit = govLimit(args.limit, 25, 200);
  const minTests = Math.max(0, Number(args.min_tests ?? 100) || 0);
  const sort = (govString(args, 'sort') ?? 'tests').toLowerCase();

  // Ask for more groups than we return, because min_tests and the fail-rate sort both
  // reorder in code; a top-N by volume would otherwise hide the worst failure rates.
  const fetchLimit = Math.min(1000, Math.max(limit * 8, 200));
  // Concurrent, not sequential: the aggregate scans 2.3M rows and Socrata throttles the
  // follow-up, which silently nulls `as_of` on a dataset whose age is the whole point.
  const [rows, asOf] = await Promise.all([
    soqlRows<AggRow>(
      DOMAIN,
      INSPECTIONS,
      {
        select:
          `${groupCol} as grouped, count(1) as tests, ` +
          `sum(case(nja_overall_test_res='F',1,true,0)) as fails, ` +
          `sum(case(nja_overall_emiss_res='F',1,true,0)) as emiss_fails, ` +
          `sum(case(nja_overall_saf_res='F',1,true,0)) as safety_fails`,
        where: clauses.length ? clauses.join(' AND ') : undefined,
        group: groupCol,
        order: 'count(1) DESC',
        limit: fetchLimit,
      },
      { userAgent: UA, timeoutMs: 25_000 },
    ),
    soqlUpdatedAt(DOMAIN, INSPECTIONS, { userAgent: UA }),
  ]);

  const shaped = rows
    .filter((r) => (r.grouped ?? '').trim())
    .map((r) => {
      const tests = govNumber(r.tests) ?? 0;
      const fails = govNumber(r.fails) ?? 0;
      return {
        [groupKey]: r.grouped,
        tests,
        failed: fails,
        fail_rate_pct: pct(fails, tests),
        pass_rate_pct: pct(tests - fails, tests),
        emissions_failures: govNumber(r.emiss_fails) ?? 0,
        safety_failures: govNumber(r.safety_fails) ?? 0,
      };
    })
    .filter((r) => r.tests >= minTests);

  if (!shaped.length) {
    return govNotFound(
      'no_matching_inspections',
      rows.length
        ? `Every group fell below min_tests=${minTests}. Lower min_tests, or widen the filters — New Jersey stores makes and models upper case and abbreviated, e.g. make="TOYOTA", model="CAMRY".`
        : 'No New Jersey inspection records matched those filters. Makes and models are stored upper case and abbreviated (make="TOYOTA", model="CAMRY"); fuel is a code, so pass "diesel" or "gas" rather than a brand of fuel.',
      { filters_applied: applied, min_tests: minTests, groups_before_min_tests: rows.length },
    );
  }

  shaped.sort((a, b) =>
    sort === 'fail_rate'
      ? (b.fail_rate_pct ?? 0) - (a.fail_rate_pct ?? 0)
      : (b.tests ?? 0) - (a.tests ?? 0),
  );
  const shown = shaped.slice(0, limit);
  const totalTests = shown.reduce((a, r) => a + r.tests, 0);
  const totalFails = shown.reduce((a, r) => a + r.failed, 0);

  return {
    state: 'NJ',
    agency: 'New Jersey Motor Vehicle Commission (MVC)',
    grain: `vehicle inspection tests aggregated by ${groupKey}, with pass and fail counts`,
    as_of: asOf,
    source: 'data.nj.gov — Vehicle Inspection Data (gvur-kt7q), 2,314,032 record-level tests',
    filters_applied: applied,
    min_tests: minTests,
    sort: sort === 'fail_rate' ? 'fail_rate' : 'tests',
    sum_of_returned_rows: totalTests,
    returned_failed: totalFails,
    returned_fail_rate_pct: pct(totalFails, totalTests),
    truncated: shaped.length > limit || rows.length >= fetchLimit,
    rows: shown,
    note: 'Rows are tests, not vehicles: a car that fails and returns is counted twice, and test_type="R" isolates the re-tests. failed counts the overall inspection verdict; emissions_failures and safety_failures break that down and can overlap. Statewide the overall fail rate is about 10%.',
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    switch (name) {
      case 'nj_mvc_inspection_facilities': return await inspectionFacilities(args);
      case 'nj_mvc_vehicle_inspections': return await vehicleInspections(args);
      default:
        return govNotFound('unknown_tool', `nj-mvc exposes ${tools.map((t) => t.name).join(', ')}.`, { requested_tool: name });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      error: `nj-mvc/${name}: ${message}`,
      hint: /timeout|abort/i.test(message)
        ? 'data.nj.gov timed out. Retry once, and narrow the inspection query with make or model_year — an unfiltered aggregate scans 2.3M rows.'
        : 'data.nj.gov refused the request or changed shape. Retry once; if it persists the dataset may have been republished under a new Socrata id.',
    };
  }
}

export default { tools, callTool } satisfies McpToolExport;
export { tools, callTool };
