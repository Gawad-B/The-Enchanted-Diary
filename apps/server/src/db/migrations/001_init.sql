-- Initial schema (global section H). Retrieval is always scoped to ONE document, so semantic search is an
-- exact scan of that document's chunk embeddings (ORDER BY embedding <=> $q LIMIT k with document and model
-- filters): there is deliberately no ANN index, which would post-filter and lose recall. The untyped
-- `vector` column plus the model/dims columns let the embedding provider change without a migration.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE sessions (id uuid PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX sessions_last_seen_idx ON sessions(last_seen_at);

CREATE TABLE documents (
  id uuid PRIMARY KEY, session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  filename text NOT NULL, byte_size integer NOT NULL, sha256 text NOT NULL, page_count integer NOT NULL DEFAULT 0,
  status text NOT NULL CHECK (status IN ('processing','ready','failed')), stage text NOT NULL DEFAULT 'queued',
  error_code text, error_detail text, primary_language text NOT NULL DEFAULT 'und',
  direction text NOT NULL DEFAULT 'ltr' CHECK (direction IN ('ltr','rtl')), languages jsonb NOT NULL DEFAULT '[]',
  sections jsonb NOT NULL DEFAULT '[]', warnings jsonb NOT NULL DEFAULT '[]', storage_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL);
CREATE INDEX documents_session_idx ON documents(session_id, created_at DESC);
CREATE INDEX documents_expires_idx ON documents(expires_at);

CREATE TABLE document_pages (
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE, page_number integer NOT NULL,
  width real NOT NULL, height real NOT NULL, text text NOT NULL DEFAULT '', char_count integer NOT NULL DEFAULT 0,
  language text NOT NULL DEFAULT 'und', direction text NOT NULL DEFAULT 'ltr',
  extraction text NOT NULL CHECK (extraction IN ('text','ocr','empty')), ocr_confidence real,
  PRIMARY KEY (document_id, page_number));

CREATE TABLE document_chunks (
  id uuid PRIMARY KEY, document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE, chunk_index integer NOT NULL,
  page_start integer NOT NULL, page_end integer NOT NULL, section_title text, language text NOT NULL DEFAULT 'und',
  direction text NOT NULL DEFAULT 'ltr', content text NOT NULL, search_text text NOT NULL,
  char_start integer NOT NULL, char_end integer NOT NULL, overlap_chars integer NOT NULL DEFAULT 0, token_count integer NOT NULL,
  highlights jsonb NOT NULL DEFAULT '[]',  -- [{page, rects:[{x,y,w,h}], charStart, charEnd}] per page spanned
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', search_text)) STORED,
  UNIQUE (document_id, chunk_index));
CREATE INDEX document_chunks_doc_idx ON document_chunks(document_id, chunk_index);
CREATE INDEX document_chunks_tsv_idx ON document_chunks USING gin (tsv);

CREATE TABLE chunk_embeddings (
  chunk_id uuid NOT NULL REFERENCES document_chunks(id) ON DELETE CASCADE, model text NOT NULL, dims integer NOT NULL,
  embedding vector NOT NULL, PRIMARY KEY (chunk_id, model));

CREATE TABLE conversations (id uuid PRIMARY KEY, document_id uuid NOT NULL UNIQUE REFERENCES documents(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE messages (
  id uuid PRIMARY KEY, conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user','assistant')), kind text NOT NULL CHECK (kind IN ('question','answer','reveal')),
  content text NOT NULL, mode text, grounded boolean, citations jsonb NOT NULL DEFAULT '[]', retrieval jsonb,
  flags jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX messages_conversation_idx ON messages(conversation_id, created_at);
