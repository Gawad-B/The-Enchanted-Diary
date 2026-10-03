-- Serverless re-platform (Task 12). A function instance lives for seconds and is not the same one twice, so everything that
-- the ingestion pipeline and the abuse limits kept in process memory lives in the database now:
--   * ingest_jobs: one row per document being read. The work is done in short "ticks" (one request each); a tick takes the
--     job's lease, does a bounded amount of work, saves the cursor and gives the lease back. A lease that is not given
--     back expires by itself, which is what an interrupted tick looks like.
--   * ingest_stage_data: what the stages hand to each other while a job runs (the extracted pages, the OCR results); it is
--     emptied when the job ends.
--   * documents.progress_*: the real progress of the job, read by whoever polls the document.
--   * rate_counters: fixed-window counters behind every rate limit and the daily budgets of the Gemini quotas.

ALTER TABLE documents
  ADD COLUMN progress_completed integer NOT NULL DEFAULT 0,
  ADD COLUMN progress_total integer NOT NULL DEFAULT 0,
  ADD COLUMN progress_unit text NOT NULL DEFAULT 'steps'
    CHECK (progress_unit IN ('pages', 'chunks', 'bytes', 'steps', 'queue')),
  ADD COLUMN progress_detail text;

CREATE TABLE ingest_jobs (
  document_id uuid PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  stage text NOT NULL DEFAULT 'queued',
  -- Where the stage stopped (next page, pages read by OCR, ...). Small: bulky data goes to ingest_stage_data.
  cursor jsonb NOT NULL DEFAULT '{}',
  -- The tick that holds the job: its id (writes by anyone else are refused) and when the lease runs out.
  lease_id uuid,
  lease_until timestamptz,
  -- Ticks that died holding the lease, in a row: a document that keeps killing its tick is given up on.
  attempts integer NOT NULL DEFAULT 0,
  -- A Gemini daily quota is used up: nothing is attempted before this moment (the next reset of the quota).
  parked_until timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ingest_jobs_lease_idx ON ingest_jobs(lease_until);
CREATE INDEX ingest_jobs_parked_idx ON ingest_jobs(parked_until) WHERE parked_until IS NOT NULL;

CREATE TABLE ingest_stage_data (
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  kind text NOT NULL,
  item integer NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY (document_id, kind, item)
);

CREATE TABLE rate_counters (
  key text NOT NULL,
  window_start timestamptz NOT NULL,
  count integer NOT NULL,
  PRIMARY KEY (key, window_start)
);
CREATE INDEX rate_counters_window_idx ON rate_counters(window_start);
