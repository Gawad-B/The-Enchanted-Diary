-- Upload tickets (review of Task 12: single use, bound to a session, and what the Blob budgets are counted from).
-- A browser uploads a PDF straight to the Blob store under a pathname the server chose, and then asks the server to make a
-- document of it. The ticket the server signed for that is a row here too, so that it can be used ONCE:
--   * the token route only gives a token for a ticket that is open (not claimed, not expired, this session's);
--   * the create call claims the ticket in the transaction that inserts the document, and a claimed ticket is never accepted
--     again, not after the document was deleted and not after the file was refused (the row outlives the document);
--   * the bytes a ticket may still bring (max_bytes) count against BLOB_MAX_TOTAL_MB while it is open, and a blob that
--     nobody claimed is deleted an hour after its ticket expired (released_at says it is gone).
CREATE TABLE upload_tickets (
  pathname text PRIMARY KEY,
  session_id uuid NOT NULL,
  -- The most the blob may weigh (MAX_UPLOAD_MB at the time).
  max_bytes bigint NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  -- Set by the create call that used the ticket (or that burned it: the file was refused).
  claimed_at timestamptz,
  document_id uuid,
  -- The blob of a ticket that was never claimed has been deleted (or was never uploaded).
  released_at timestamptz
);
CREATE INDEX upload_tickets_open_idx ON upload_tickets(expires_at) WHERE claimed_at IS NULL AND released_at IS NULL;
CREATE INDEX upload_tickets_issued_idx ON upload_tickets(issued_at);
